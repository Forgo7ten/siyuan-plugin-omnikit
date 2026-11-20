import type { CompressionMode } from "./contracts.ts";

export const MiB = 1024 * 1024;
export const NODE_ID = /^\d{14}-[a-z0-9]{7}$/;

/** Runtime limits remain part of the validated in-memory config. */
export interface ImageConfig {
  schemaVersion: 2;
  auto: { globalEnabled: boolean; pageAllowlist: Record<string, { grantedAt: number; title: string }> };
  compression: {
    initialQuality: number; manualMaxEdge: number;
    minInputBytes: number; minSavingBytes: number; minSavingRatio: number;
    maxInputBytes: number; maxPixels: number; maxEncodeMs: number;
    concurrencyDesktop: number; concurrencyMobile: number; excludedExtensions: string[];
    smartEnabled: boolean;
    targetSimilarity: number;
  };
  metadata: { preserveExif: false };
  /** Internal compatibility knobs used by current services. */
  sources: { desktopLocalFiles: boolean };
  references: { backend: "auto" | "sql"; maxDocuments: number };
}

export type ImageFeatureConfig = ImageConfig;
export interface PagePermission { grantedAt: number; title: string }
export class UnsupportedConfigError extends Error {}

const runtimeDefaults = () => ({
  minInputBytes: 100 * 1024, minSavingBytes: 4096, minSavingRatio: 0.05,
  maxInputBytes: 32 * MiB, maxPixels: 32_000_000, maxEncodeMs: 45_000,
  concurrencyDesktop: 3, concurrencyMobile: 1,
  excludedExtensions: ["gif", "svg", "webp"],
  smartEnabled: false,
  targetSimilarity: 0.99,
});

export function defaultImageFeatureConfig(): ImageConfig {
  return {
    schemaVersion: 2,
    auto: { globalEnabled: false, pageAllowlist: {} },
    compression: { initialQuality: 0.8, manualMaxEdge: 4096, ...runtimeDefaults() },
    metadata: { preserveExif: false },
    sources: { desktopLocalFiles: true },
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

/** Validate config with automatic migration from v1 to v2; parsing never writes storage. */
export function parseImageConfig(raw: unknown): ImageConfig {
  const r = object(raw, "config");
  if (r.schemaVersion !== 1 && r.schemaVersion !== 2) {
    throw new UnsupportedConfigError("Only image config schemaVersion 1 and 2 are supported");
  }
  const isV1 = r.schemaVersion === 1;
  const defaults = defaultImageFeatureConfig();
  const a = object(r.auto, "auto"), c = object(r.compression, "compression");
  const metadata = object(r.metadata, "metadata");
  const pages = object(a.pageAllowlist, "pageAllowlist");
  const pageAllowlist: ImageConfig["auto"]["pageAllowlist"] = {};
  for (const [id, value] of Object.entries(pages)) {
    if (!NODE_ID.test(id)) throw new Error("Invalid document ID");
    const p = object(value, "permission");
    if (typeof p.title !== "string" || p.title.length > 512) throw new Error("Invalid title");
    pageAllowlist[id] = { grantedAt: number(p.grantedAt, "grantedAt", 0, Number.MAX_SAFE_INTEGER, true), title: p.title };
  }
  if (metadata.preserveExif !== false) throw new Error("EXIF preservation is not supported");
  if (!Array.isArray(c.excludedExtensions) || c.excludedExtensions.some(v => typeof v !== "string" || !/^[a-z0-9]+$/.test(v))) throw new Error("Invalid excludedExtensions");
  const refsRaw = object(r.references ?? defaults.references, "references");
  const sourcesRaw = object(r.sources ?? defaults.sources, "sources");

  const smartEnabled = isV1
    ? defaults.compression.smartEnabled
    : bool(c.smartEnabled ?? defaults.compression.smartEnabled, "smartEnabled");
  const targetSimilarity = isV1
    ? defaults.compression.targetSimilarity
    : number(c.targetSimilarity ?? defaults.compression.targetSimilarity, "targetSimilarity", 0.90, 0.999);

  return {
    schemaVersion: 2,
    auto: { globalEnabled: bool(a.globalEnabled, "globalEnabled"), pageAllowlist },
    compression: {
      ...defaults.compression,
      initialQuality: number(c.initialQuality, "initialQuality", 0.01, 1),
      manualMaxEdge: number(c.manualMaxEdge, "manualMaxEdge", 512, 16_384, true),
      excludedExtensions: [...new Set(c.excludedExtensions as string[])],
      smartEnabled,
      targetSimilarity,
    },
    metadata: { preserveExif: false },
    sources: { desktopLocalFiles: bool(sourcesRaw.desktopLocalFiles, "desktopLocalFiles") },
    references: {
      backend: refsRaw.backend === "sql" ? "sql" : refsRaw.backend === "auto" ? "auto" : (() => { throw new Error("Invalid backend"); })(),
      maxDocuments: number(refsRaw.maxDocuments, "maxDocuments", 1, 100_000, true),
    },
  };
}

export function autoAllowed(config: ImageConfig, rootID: string): boolean {
  return NODE_ID.test(rootID) && (config.auto.globalEnabled || Object.hasOwn(config.auto.pageAllowlist, rootID));
}
export type Intent = { kind: "document" | "manual-single"; rootID: string } |
  { kind: "upload"; rootID: string; originalInputCount: number } |
  { kind: "remote-auto"; rootID: string; blockID: string };
export type { CompressionMode };
