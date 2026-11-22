export const MiB = 1024 * 1024;
export const NODE_ID = /^\d{14}-[a-z0-9]{7}$/;

/** Runtime limits remain part of the validated in-memory config. */
export interface ImageConfig {
  schemaVersion: 2;
  auto: { globalEnabled: boolean; pageAllowlist: Record<string, PagePermission> };
  compression: {
    initialQuality: number; manualMaxEdge: number;
    minInputBytes: number; minSavingBytes: number; minSavingRatio: number;
    maxInputBytes: number; maxPixels: number; maxEncodeMs: number;
    concurrencyDesktop: number; excludedExtensions: string[];
    smartEnabled: boolean;
    targetSimilarity: number;
  };
  metadata: { preserveExif: false };
}

export type ImageFeatureConfig = ImageConfig;
export interface PagePermission { grantedAt: number }

const runtimeDefaults = () => ({
  minInputBytes: 100 * 1024, minSavingBytes: 4096, minSavingRatio: 0.05,
  maxInputBytes: 32 * MiB, maxPixels: 32_000_000, maxEncodeMs: 45_000,
  concurrencyDesktop: 3,
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

/** Validate the v2 image compressor configuration; parsing never writes storage. */
export function parseImageConfig(raw: unknown): ImageConfig {
  const r = object(raw, "config");
  if (r.schemaVersion !== 2) {
    throw new Error("Only image config schemaVersion 2 is supported");
  }
  const defaults = defaultImageFeatureConfig();
  const a = object(r.auto, "auto"), c = object(r.compression, "compression");
  const metadata = object(r.metadata, "metadata");
  const pages = object(a.pageAllowlist, "pageAllowlist");
  const pageAllowlist: ImageConfig["auto"]["pageAllowlist"] = {};
  for (const [id, value] of Object.entries(pages)) {
    if (!NODE_ID.test(id)) throw new Error("Invalid document ID");
    const p = object(value, "permission");
    pageAllowlist[id] = { grantedAt: number(p.grantedAt, "grantedAt", 0, Number.MAX_SAFE_INTEGER, true) };
  }
  if (metadata.preserveExif !== false) throw new Error("EXIF preservation is not supported");
  if (!Array.isArray(c.excludedExtensions) || c.excludedExtensions.some(v => typeof v !== "string" || !/^[a-z0-9]+$/.test(v))) throw new Error("Invalid excludedExtensions");

  const smartEnabled = bool(c.smartEnabled, "smartEnabled");
  const targetSimilarity = number(c.targetSimilarity, "targetSimilarity", 0.90, 0.999);

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
  };
}

export function autoAllowed(config: ImageConfig, rootID: string): boolean {
  return NODE_ID.test(rootID) && (config.auto.globalEnabled || Object.hasOwn(config.auto.pageAllowlist, rootID));
}
