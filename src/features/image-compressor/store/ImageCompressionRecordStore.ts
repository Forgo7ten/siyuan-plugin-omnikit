import type { Plugin } from "siyuan";
import { featureDataFile } from "../../../core/framework/FeatureRegistration.ts";
import { JsonStore, type StoreCodec } from "../../../core/store/JsonStore.ts";
import type { CompressionRecord, OperationKind } from "../policy/contracts.ts";
import { IMAGE_FEATURE_ID } from "../policy/settings.ts";

interface RecordsFile {
  schemaVersion: 1;
  records: CompressionRecord[];
}

const MAX_RECORDS = 100;
const MAX_PATH_LENGTH = 2_048;
const OPERATIONS = new Set<OperationKind>(["saved-only", "replaced", "incomplete"]);
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
  const [assetPath, ...suffix] = path.split("?");
  if (!assetPath.startsWith("assets/") || assetPath.startsWith("assets//") || suffix.length > 1) {
    throw new Error("Compression record path must be a SiYuan asset path");
  }
  let box = "";
  if (suffix.length) {
    const match = /^box=(\d{14}-[a-z0-9]{7})$/.exec(suffix[0]);
    if (!match) throw new Error("Invalid asset notebook suffix");
    box = match[1];
  }
  const parts = assetPath.slice("assets/".length).split("/");
  if (!parts.length || parts.some(part => !part || part === "." || part === ".." || part.length > 255 || /[\/\\\u0000-\u001f\u007f]/.test(part))) {
    throw new Error("Invalid compression record asset path");
  }
  return box ? `${assetPath}?box=${box}` : assetPath;
}

/** Returns true when a record source key looks like an HTTP(S) URL. */
export function isRemoteRecordSource(path: unknown): boolean {
  return typeof path === "string" && /^https?:\/\//i.test(path.trim());
}

/**
 * Validates either a remote HTTP(S) URL (without credentials or control chars)
 * or a SiYuan `assets/...` path for use as the record store left-hand identity.
 */
export function recordSourceIdentity(path: unknown): string {
  if (!isRemoteRecordSource(path)) {
    return assetIdentity(path);
  }
  const raw = path as string;
  if (raw.length === 0 || raw.length > MAX_PATH_LENGTH || raw !== raw.trim() || /[\u0000-\u001f\u007f]/.test(raw)) {
    throw new Error("Invalid compression record remote URL");
  }
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error("Invalid compression record remote URL");
  }
  if ((url.protocol !== "http:" && url.protocol !== "https:") || url.username || url.password) {
    throw new Error("Compression record remote URL must be HTTP(S) without credentials");
  }
  return url.href;
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
      const originalIdentity = recordSourceIdentity(originalPath);
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

  constructor(plugin: Plugin, options?: { fetchFn?: typeof fetch }) {
    this.store = new JsonStore(plugin, featureDataFile(IMAGE_FEATURE_ID, "records"), codec, options?.fetchFn);
  }

  async init(): Promise<void> { await this.store.load(); }

  async reload(): Promise<boolean> { return this.store.reload(); }

  snapshot(): CompressionRecord[] { return this.store.snapshot().records; }

  async upsert(originalPath: string, compressedPath: string): Promise<void> {
    // Validate even before entering update so malformed input cannot be normalized silently.
    const originalIdentity = recordSourceIdentity(originalPath);
    const compressedIdentity = assetIdentity(compressedPath);
    if (originalIdentity === compressedIdentity) {
      throw new Error("Compression record paths must be distinct");
    }
    const storedOriginal = isRemoteRecordSource(originalPath) ? originalIdentity : originalPath;
    const updatedAt = Date.now();
    await this.store.update(draft => {
      const idx = draft.records.findIndex(record => recordSourceIdentity(record.originalPath) === originalIdentity);
      if (idx >= 0) {
        const existing = draft.records[idx];
        existing.originalPath = storedOriginal;
        existing.compressedPath = compressedPath;
        existing.updatedAt = updatedAt;
        existing.lastOperation = "saved-only";
        if (idx > 0) {
          draft.records.splice(idx, 1);
          draft.records.unshift(existing);
        }
      } else {
        if (draft.records.length >= MAX_RECORDS) {
          draft.records.sort((a, b) => b.updatedAt - a.updatedAt);
          draft.records.length = MAX_RECORDS - 1;
        }
        draft.records.unshift({ originalPath: storedOriginal, compressedPath, updatedAt, lastOperation: "saved-only" });
      }
      trustedDrafts.add(draft);
    });
  }

  async markOperation(originalPath: string, compressedPath: string, status: OperationKind): Promise<void> {
    const originalIdentity = recordSourceIdentity(originalPath);
    const compressedIdentity = assetIdentity(compressedPath);
    if (!OPERATIONS.has(status)) throw new Error("Invalid compression record operation");
    await this.store.update(draft => {
      const idx = draft.records.findIndex(record => recordSourceIdentity(record.originalPath) === originalIdentity);
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
    const identity = recordSourceIdentity(originalPath);
    await this.store.update(draft => {
      draft.records = draft.records.filter(record => recordSourceIdentity(record.originalPath) !== identity);
      trustedDrafts.add(draft);
    });
  }

  /**
   * Atomically removes the single record inside the serialized `JsonStore.update` queue
   * only if both `originalPath` and `compressedPath` still match (CAS guard against A->B => A->C races).
   */
  async compareAndRemove(originalPath: string, compressedPath: string): Promise<boolean> {
    const originalIdentity = recordSourceIdentity(originalPath);
    const compressedIdentity = assetIdentity(compressedPath);
    let removed = false;
    await this.store.update(draft => {
      const idx = draft.records.findIndex(record =>
        recordSourceIdentity(record.originalPath) === originalIdentity &&
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
export function imageRecordsFor(
  plugin: Plugin,
  options?: { fetchFn?: typeof fetch },
): { store: ImageCompressionRecordStore; ready: Promise<void> } {
  let entry = stores.get(plugin);
  if (!entry) {
    const store = new ImageCompressionRecordStore(plugin, options);
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
