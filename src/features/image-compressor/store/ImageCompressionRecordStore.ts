import type { Plugin } from "siyuan";
import { JsonStore, type StoreCodec } from "../../../core/store/JsonStore.ts";
import type { AssetAvailability, CompressionRecord, OperationKind } from "../policy/contracts.ts";

interface RecordsFile {
  schemaVersion: 1;
  records: CompressionRecord[];
}

export interface RecordMigrationFieldResult {
  field: "originalPath" | "compressedPath";
  current: string;
  candidate?: string;
  status:
    | "unchanged"
    | "keep-literal"
    | "migratable"
    | "ambiguous-both-present"
    | "ambiguous-both-unreachable"
    | "ambiguous-collision";
}

export interface RecordMigrationEntry {
  record: CompressionRecord;
  original: RecordMigrationFieldResult;
  compressed: RecordMigrationFieldResult;
  nextRecord: CompressionRecord;
  canMigrate: boolean;
}

export interface RecordMigrationDryRunReport {
  entries: RecordMigrationEntry[];
  migratableCount: number;
  ambiguousCount: number;
  diagnostics: string[];
}

const MAX_RECORDS = 10_000;
const MAX_PATH_LENGTH = 2_048;
const MAX_IDENTITY_CACHE = 50_000;
const BOX_ID = /^\d{14}-[a-z0-9]{7}$/;
const OPERATIONS = new Set<OperationKind>(["saved-only", "replaced", "incomplete"]);
const identityCache = new Map<string, string>();
const trustedDrafts = new WeakSet<object>();

/**
 * Validate a kernel asset path and return a case-sensitive literal identity
 * preserving percent sequences (e.g. `100%.png` vs `100%25.png`) and `?box=`.
 */
export function assetIdentity(path: unknown): string {
  if (typeof path !== "string" || path.length === 0 || path.length > MAX_PATH_LENGTH ||
      path !== path.trim() || /[\u0000-\u001f\u007f\\#]/.test(path)) {
    throw new Error("Invalid compression record asset path");
  }
  const cached = identityCache.get(path);
  if (cached !== undefined) return cached;
  const [assetPath, ...suffix] = path.split("?");
  if (!assetPath.startsWith("assets/") || assetPath.startsWith("assets//") || suffix.length > 1) {
    throw new Error("Compression record path must be a SiYuan asset path");
  }
  let box = "";
  if (suffix.length) {
    const match = /^box=(\d{14}-[a-z0-9]{7})$/.exec(suffix[0]);
    if (!match || !BOX_ID.test(match[1])) throw new Error("Invalid asset notebook suffix");
    box = match[1];
  }
  const parts = assetPath.slice("assets/".length).split("/");
  if (!parts.length || parts.some(part => !part || part === "." || part === ".." || part.length > 255 || /[\/\\\u0000-\u001f\u007f]/.test(part))) {
    throw new Error("Invalid compression record asset path");
  }
  const identity = box ? `${assetPath}?box=${box}` : assetPath;
  if (identityCache.size >= MAX_IDENTITY_CACHE) identityCache.clear();
  identityCache.set(path, identity);
  return identity;
}

function tryDecodeLegacyCandidate(path: string): string | undefined {
  const [assetPath, ...suffix] = path.split("?");
  const parts = assetPath.slice("assets/".length).split("/");
  let changed = false;
  const decodedParts: string[] = [];
  for (const part of parts) {
    let decoded: string;
    try {
      decoded = decodeURIComponent(part);
    } catch {
      return undefined;
    }
    if (decoded !== part) changed = true;
    if (!decoded || decoded === "." || decoded === ".." || decoded.length > 255 || /[\/\\\u0000-\u001f\u007f#]/.test(decoded)) {
      return undefined;
    }
    decodedParts.push(decoded);
  }
  if (!changed) return undefined;
  const candidate = `assets/${decodedParts.join("/")}${suffix.length ? `?${suffix[0]}` : ""}`;
  try {
    assetIdentity(candidate);
    return candidate;
  } catch {
    return undefined;
  }
}

/**
 * Read-only dry-run migration verifier for legacy percent-encoded records.
 * Never mutates records or writes storage; preserves ambiguous entries with diagnostics.
 */
export async function dryRunRecordMigration(
  records: readonly CompressionRecord[],
  verifyAsset: (path: string, signal?: AbortSignal) => Promise<AssetAvailability>,
  signal?: AbortSignal,
): Promise<RecordMigrationDryRunReport> {
  const diagnostics: string[] = [];
  const entries: RecordMigrationEntry[] = [];
  const existingOriginalKeys = new Set(records.map(r => assetIdentity(r.originalPath)));
  const claimedOriginalKeys = new Set<string>();

  const inspectField = async (
    field: "originalPath" | "compressedPath",
    current: string,
    checkCollision: boolean,
  ): Promise<RecordMigrationFieldResult> => {
    const candidate = tryDecodeLegacyCandidate(current);
    if (!candidate) {
      return { field, current, status: "unchanged" };
    }
    const [litStatus, decStatus] = await Promise.all([
      verifyAsset(current, signal),
      verifyAsset(candidate, signal),
    ]);
    if (litStatus === "present" && decStatus === "present") {
      diagnostics.push(`Ambiguous ${field} (both present): ${current} vs ${candidate}`);
      return { field, current, candidate, status: "ambiguous-both-present" };
    }
    if (litStatus !== "present" && decStatus !== "present") {
      diagnostics.push(`Ambiguous ${field} (neither reachable): ${current} vs ${candidate}`);
      return { field, current, candidate, status: "ambiguous-both-unreachable" };
    }
    if (litStatus === "present") {
      return { field, current, candidate, status: "keep-literal" };
    }
    if (checkCollision) {
      const candidateKey = assetIdentity(candidate);
      const currentKey = assetIdentity(current);
      if ((candidateKey !== currentKey && existingOriginalKeys.has(candidateKey)) || claimedOriginalKeys.has(candidateKey)) {
        diagnostics.push(`Collision on ${field} migration: ${current} -> ${candidate}`);
        return { field, current, candidate, status: "ambiguous-collision" };
      }
      claimedOriginalKeys.add(candidateKey);
    }
    return { field, current, candidate, status: "migratable" };
  };

  let migratableCount = 0;
  let ambiguousCount = 0;

  for (const record of records) {
    if (signal?.aborted) break;
    const original = await inspectField("originalPath", record.originalPath, true);
    const compressed = await inspectField("compressedPath", record.compressedPath, false);

    const origAmbiguous = original.status.startsWith("ambiguous-");
    const compAmbiguous = compressed.status.startsWith("ambiguous-");
    if (origAmbiguous || compAmbiguous) {
      ambiguousCount++;
      entries.push({ record, original, compressed, nextRecord: { ...record }, canMigrate: false });
      continue;
    }

    const nextOriginal = original.status === "migratable" && original.candidate ? original.candidate : record.originalPath;
    const nextCompressed = compressed.status === "migratable" && compressed.candidate ? compressed.candidate : record.compressedPath;
    const canMigrate = nextOriginal !== record.originalPath || nextCompressed !== record.compressedPath;
    if (canMigrate) migratableCount++;
    entries.push({
      record,
      original,
      compressed,
      nextRecord: { ...record, originalPath: nextOriginal, compressedPath: nextCompressed },
      canMigrate,
    });
  }

  return { entries, migratableCount, ambiguousCount, diagnostics };
}

const codec: StoreCodec<RecordsFile> = {
  defaults: () => ({ schemaVersion: 1, records: [] }),
  parse(raw) {
    if (raw && typeof raw === "object" && trustedDrafts.has(raw)) {
      trustedDrafts.delete(raw);
      return raw as RecordsFile;
    }
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
      throw new Error("Invalid image compression records store");
    }
    const file = raw as Partial<RecordsFile>;
    if (file.schemaVersion !== 1 || !Array.isArray(file.records)) {
      throw new Error("Unsupported image compression records store schema");
    }
    const originals = new Set<string>();
    const records = file.records.map(record => {
      if (!record || typeof record !== "object" ||
          !Number.isSafeInteger(record.updatedAt) || record.updatedAt < 0 ||
          !OPERATIONS.has(record.lastOperation)) {
        throw new Error("Invalid image compression record");
      }
      const originalPath = record.originalPath;
      const compressedPath = record.compressedPath;
      const originalIdentity = assetIdentity(originalPath);
      const compressedIdentity = assetIdentity(compressedPath);
      if (originalIdentity === compressedIdentity) throw new Error("Compression record paths must be distinct");
      if (originals.has(originalIdentity)) throw new Error("Duplicate original asset in compression records");
      originals.add(originalIdentity);
      return { originalPath, compressedPath, updatedAt: record.updatedAt, lastOperation: record.lastOperation };
    });
    return { schemaVersion: 1 as const, records };
  },
};

/** Durable one-to-one latest mappings for the Image Compressor Dock. */
export class ImageCompressionRecordStore {
  readonly store: JsonStore<RecordsFile>;

  constructor(plugin: Plugin) {
    this.store = new JsonStore(plugin, "feature-image-compressor-records.json", codec);
  }

  async init(): Promise<void> { await this.store.load(); }

  async reload(): Promise<boolean> { return this.store.reload(); }

  snapshot(): CompressionRecord[] { return this.store.snapshot().records; }

  async upsert(originalPath: string, compressedPath: string): Promise<void> {
    // Validate even before entering update so malformed input cannot be normalized silently.
    const originalIdentity = assetIdentity(originalPath);
    const compressedIdentity = assetIdentity(compressedPath);
    if (originalIdentity === compressedIdentity) {
      throw new Error("Compression record paths must be distinct");
    }
    const updatedAt = Date.now();
    await this.store.update(draft => {
      const idx = draft.records.findIndex(record => assetIdentity(record.originalPath) === originalIdentity);
      if (idx >= 0) {
        const existing = draft.records[idx];
        existing.compressedPath = compressedPath;
        existing.updatedAt = updatedAt;
        existing.lastOperation = "saved-only";
        if (idx > 0) {
          draft.records.splice(idx, 1);
          draft.records.unshift(existing);
        }
      } else {
        if (draft.records.length >= MAX_RECORDS) {
          throw new Error(`Compression records reached limit (${MAX_RECORDS})`);
        }
        draft.records.unshift({ originalPath, compressedPath, updatedAt, lastOperation: "saved-only" });
      }
      trustedDrafts.add(draft);
    });
  }

  async markOperation(originalPath: string, compressedPath: string, status: OperationKind): Promise<void> {
    const originalIdentity = assetIdentity(originalPath);
    const compressedIdentity = assetIdentity(compressedPath);
    if (!OPERATIONS.has(status)) throw new Error("Invalid compression record operation");
    await this.store.update(draft => {
      const idx = draft.records.findIndex(record => assetIdentity(record.originalPath) === originalIdentity);
      const row = idx >= 0 ? draft.records[idx] : undefined;
      // A stale job must never update the status of a newer mapping for this original.
      if (row && assetIdentity(row.compressedPath) === compressedIdentity) {
        row.lastOperation = status;
        row.updatedAt = Date.now();
        if (idx > 0) {
          draft.records.splice(idx, 1);
          draft.records.unshift(row);
        }
      }
      trustedDrafts.add(draft);
    });
  }

  async removeRecord(originalPath: string): Promise<void> {
    const identity = assetIdentity(originalPath);
    await this.store.update(draft => {
      draft.records = draft.records.filter(record => assetIdentity(record.originalPath) !== identity);
      trustedDrafts.add(draft);
    });
  }

  /**
   * Atomically removes the single record inside the serialized `JsonStore.update` queue
   * only if both `originalPath` and `compressedPath` still match (CAS guard against A->B => A->C races).
   */
  async compareAndRemove(originalPath: string, compressedPath: string): Promise<boolean> {
    const originalIdentity = assetIdentity(originalPath);
    const compressedIdentity = assetIdentity(compressedPath);
    let removed = false;
    await this.store.update(draft => {
      const idx = draft.records.findIndex(record =>
        assetIdentity(record.originalPath) === originalIdentity &&
        assetIdentity(record.compressedPath) === compressedIdentity,
      );
      if (idx >= 0) {
        draft.records.splice(idx, 1);
        removed = true;
      }
      trustedDrafts.add(draft);
    });
    return removed;
  }
}

const stores = new WeakMap<Plugin, { store: ImageCompressionRecordStore; ready: Promise<void> }>();

/** Share one in-memory write queue with the feature runtime and its Dock view. */
export function imageRecordsFor(plugin: Plugin): { store: ImageCompressionRecordStore; ready: Promise<void> } {
  let entry = stores.get(plugin);
  if (!entry) {
    const store = new ImageCompressionRecordStore(plugin);
    entry = { store, ready: store.init() };
    stores.set(plugin, entry);
  }
  return entry;
}

/** Reload an already-initialized record store without triggering cold-start creation or reads. */
export async function reloadLoadedImageRecords(plugin: Plugin): Promise<void> {
  const entry = stores.get(plugin);
  if (!entry) return;
  await entry.ready.catch(() => undefined);
  await entry.store.reload();
}
