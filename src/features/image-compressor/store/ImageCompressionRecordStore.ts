import type { Plugin } from "siyuan";
import { JsonStore, type StoreCodec } from "../../../core/store/JsonStore.ts";
import type { CompressionRecord, OperationKind } from "../policy/contracts.ts";

interface RecordsFile {
  schemaVersion: 1;
  records: CompressionRecord[];
}

const MAX_RECORDS = 10_000;
const MAX_PATH_LENGTH = 2_048;
const MAX_FILE_BYTES = 4 * 1024 * 1024;
const BOX_ID = /^\d{14}-[a-z0-9]{7}$/;
const OPERATIONS = new Set<OperationKind>(["saved-only", "replaced", "incomplete"]);

/** Validate a kernel asset path and return a stable identity for duplicate checks. */
function assetIdentity(path: unknown): string {
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
    if (!match || !BOX_ID.test(match[1])) throw new Error("Invalid asset notebook suffix");
    box = match[1];
  }
  const parts = assetPath.slice("assets/".length).split("/");
  if (!parts.length || parts.some(part => !part || part.length > 255)) {
    throw new Error("Invalid compression record asset path");
  }
  const decoded = parts.map(part => {
    let value: string;
    try { value = decodeURIComponent(part); }
    catch { throw new Error("Invalid encoded compression record asset path"); }
    if (!value || value === "." || value === ".." || /[\/\\\u0000-\u001f\u007f]/.test(value)) {
      throw new Error("Invalid compression record asset segment");
    }
    return value.normalize("NFC").toLowerCase();
  });
  return `${decoded.join("/")}?box=${box}`;
}

const codec: StoreCodec<RecordsFile> = {
  defaults: () => ({ schemaVersion: 1, records: [] }),
  parse(raw) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
      throw new Error("Invalid image compression records store");
    }
    const file = raw as Partial<RecordsFile>;
    if (file.schemaVersion !== 1 || !Array.isArray(file.records) || file.records.length > MAX_RECORDS) {
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
    const result = { schemaVersion: 1 as const, records };
    if (new TextEncoder().encode(JSON.stringify(result)).byteLength > MAX_FILE_BYTES) {
      throw new Error("Image compression records store exceeds size limit");
    }
    return result;
  },
};

/** Durable one-to-one latest mappings for the Image Compressor Dock. */
export class ImageCompressionRecordStore {
  readonly store: JsonStore<RecordsFile>;

  constructor(plugin: Plugin) {
    this.store = new JsonStore(plugin, "feature-image-compressor-records.json", codec);
  }

  async init(): Promise<void> { await this.store.load(); }

  snapshot(): CompressionRecord[] { return this.store.snapshot().records; }

  async upsert(originalPath: string, compressedPath: string): Promise<void> {
    // Validate even before entering update so malformed input cannot be normalized silently.
    assetIdentity(originalPath);
    assetIdentity(compressedPath);
    const updatedAt = Date.now();
    await this.store.update(draft => {
      const existing = draft.records.find(record => assetIdentity(record.originalPath) === assetIdentity(originalPath));
      if (existing) {
        existing.compressedPath = compressedPath;
        existing.updatedAt = updatedAt;
        existing.lastOperation = "saved-only";
      } else {
        draft.records.unshift({ originalPath, compressedPath, updatedAt, lastOperation: "saved-only" });
      }
    });
  }

  async markOperation(originalPath: string, compressedPath: string, status: OperationKind): Promise<void> {
    assetIdentity(originalPath);
    assetIdentity(compressedPath);
    if (!OPERATIONS.has(status)) throw new Error("Invalid compression record operation");
    await this.store.update(draft => {
      const row = draft.records.find(record => assetIdentity(record.originalPath) === assetIdentity(originalPath));
      // A stale job must never update the status of a newer mapping for this original.
      if (row && assetIdentity(row.compressedPath) === assetIdentity(compressedPath)) {
        row.lastOperation = status;
        row.updatedAt = Date.now();
      }
    });
  }

  async removeRecord(originalPath: string): Promise<void> {
    const identity = assetIdentity(originalPath);
    await this.store.update(draft => {
      draft.records = draft.records.filter(record => assetIdentity(record.originalPath) !== identity);
    });
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
