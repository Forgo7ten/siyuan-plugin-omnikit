export const MiB = 1024 * 1024;
export const NODE_ID = /^\d{14}-[a-z0-9]{7}$/;

export interface ImageConfig {
  schemaVersion: 1;
  auto: {
    globalEnabled: boolean;
    pageAllowlist: Record<string, { grantedAt: number; title: string }>;
    uploads: boolean;
    remoteImages: boolean;
  };
  compression: {
    initialQuality: number;
    maxDimension: number;
    minInputBytes: number;
    minSavingBytes: number;
    minSavingRatio: number;
    maxInputBytes: number;
    maxPixels: number;
    maxEncodeMs: number;
    concurrencyDesktop: number;
    concurrencyMobile: number;
    excludedExtensions: string[];
  };
  sources: { desktopLocalFiles: boolean };
  retention: { deleteSingleOriginal: boolean };
  references: { backend: "auto" | "sql"; maxDocuments: number };
}

export type ImageFeatureConfig = ImageConfig;
export interface PagePermission { grantedAt: number; title: string }
export class UnsupportedConfigError extends Error {}

export function defaultImageFeatureConfig(): ImageConfig {
  return {
    schemaVersion: 1,
    auto: { globalEnabled: false, pageAllowlist: {}, uploads: true, remoteImages: false },
    compression: {
      initialQuality: 0.8, maxDimension: 4096,
      minInputBytes: 100 * 1024, minSavingBytes: 4096,
      minSavingRatio: 0.05, maxInputBytes: 32 * MiB,
      maxPixels: 32_000_000, maxEncodeMs: 45_000,
      concurrencyDesktop: 2, concurrencyMobile: 1,
      excludedExtensions: ["gif", "svg", "webp"],
    },
    sources: { desktopLocalFiles: true },
    retention: { deleteSingleOriginal: false },
    references: { backend: "auto", maxDocuments: 10_000 },
  };
}

function object(value: unknown, name: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${name}: object required`);
  return value as Record<string, unknown>;
}
function bool(value: unknown, name: string): boolean {
  if (typeof value !== "boolean") throw new Error(`${name}: boolean required`);
  return value;
}
function number(value: unknown, name: string, min: number, max: number, integer = false): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < min || value > max || (integer && !Number.isSafeInteger(value))) {
    throw new Error(`${name}: out of range`);
  }
  return value;
}
export function parseExtensions(raw: string): string[] {
  const values = raw.split(/[,，]/).map(s => s.trim().replace(/^\./, "").toLowerCase()).filter(Boolean);
  if (values.some(s => !/^[a-z0-9]+$/.test(s))) throw new Error("Invalid extension");
  return [...new Set(values)];
}

/** Accept only complete image schema data; parsing never fills fields or writes files. */
export function parseImageConfig(raw: unknown): ImageConfig {
  const r = object(raw, "config");
  if (r.schemaVersion !== 1) throw new UnsupportedConfigError("Only image config schemaVersion 1 is supported");
  const a = object(r.auto, "auto"), c = object(r.compression, "compression");
  const s = object(r.sources, "sources"), t = object(r.retention, "retention");
  const refs = object(r.references, "references"), pages = object(a.pageAllowlist, "pageAllowlist");
  const pageAllowlist: ImageConfig["auto"]["pageAllowlist"] = {};
  for (const [id, value] of Object.entries(pages)) {
    if (!NODE_ID.test(id)) throw new Error("Invalid document ID");
    const p = object(value, "permission");
    if (typeof p.title !== "string" || p.title.length > 512) throw new Error("Invalid title");
    pageAllowlist[id] = { grantedAt: number(p.grantedAt, "grantedAt", 0, Number.MAX_SAFE_INTEGER, true), title: p.title };
  }
  if (!Array.isArray(c.excludedExtensions) || c.excludedExtensions.some(v => typeof v !== "string" || !/^[a-z0-9]+$/.test(v))) {
    throw new Error("Invalid excludedExtensions");
  }
  if (refs.backend !== "auto" && refs.backend !== "sql") throw new Error("Invalid backend");
  return {
    schemaVersion: 1,
    auto: { globalEnabled: bool(a.globalEnabled, "globalEnabled"), pageAllowlist,
      uploads: bool(a.uploads, "uploads"), remoteImages: bool(a.remoteImages, "remoteImages") },
    compression: {
      initialQuality: number(c.initialQuality, "initialQuality", 0.1, 1),
      maxDimension: number(c.maxDimension, "maxDimension", 256, 8192, true),
      minInputBytes: number(c.minInputBytes, "minInputBytes", 0, 128 * MiB, true),
      minSavingBytes: number(c.minSavingBytes, "minSavingBytes", 0, MiB, true),
      minSavingRatio: number(c.minSavingRatio, "minSavingRatio", 0, 0.9),
      maxInputBytes: number(c.maxInputBytes, "maxInputBytes", MiB, 128 * MiB, true),
      maxPixels: number(c.maxPixels, "maxPixels", 1_000_000, 64_000_000, true),
      maxEncodeMs: number(c.maxEncodeMs, "maxEncodeMs", 1000, 90_000, true),
      concurrencyDesktop: number(c.concurrencyDesktop, "concurrencyDesktop", 1, 4, true),
      concurrencyMobile: number(c.concurrencyMobile, "concurrencyMobile", 1, 2, true),
      excludedExtensions: [...new Set(c.excludedExtensions as string[])],
    },
    sources: { desktopLocalFiles: bool(s.desktopLocalFiles, "desktopLocalFiles") },
    retention: { deleteSingleOriginal: bool(t.deleteSingleOriginal, "deleteSingleOriginal") },
    references: { backend: refs.backend, maxDocuments: number(refs.maxDocuments, "maxDocuments", 1, 100_000, true) },
  };
}

export function autoAllowed(config: ImageConfig, rootID: string): boolean {
  return NODE_ID.test(rootID) && (config.auto.globalEnabled || Object.hasOwn(config.auto.pageAllowlist, rootID));
}
export type Intent = { kind: "document" | "manual-single"; rootID: string } |
  { kind: "upload"; rootID: string; originalInputCount: number } |
  { kind: "remote-auto"; rootID: string; blockID: string };
export function retainOriginal(intent: Intent, config: ImageConfig): boolean {
  if (intent.kind === "document" || intent.kind === "remote-auto") return true;
  if (intent.kind === "upload" && intent.originalInputCount !== 1) return true;
  return !config.retention.deleteSingleOriginal;
}
