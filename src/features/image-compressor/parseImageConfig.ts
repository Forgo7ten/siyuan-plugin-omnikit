import { compressionDefaults, type CompressionSettings } from "./settings.ts";
import { readExcludedExtensions } from "./ExcludedExtensions.ts";

export interface PagePermission {
  grantedAt: number;
  titleSnapshot?: string;
  notebookIdSnapshot?: string;
}
export interface ImageFeatureConfig {
  schemaVersion: 1;
  autoCompression: {
    globalEnabled: boolean;
    pageAllowlist: Record<string, PagePermission>;
  };
  compression: CompressionSettings;
}

export function defaultImageFeatureConfig(): ImageFeatureConfig {
  return {
    schemaVersion: 1,
    autoCompression: { globalEnabled: false, pageAllowlist: {} },
    compression: { ...compressionDefaults },
  };
}

export function parseImageConfig(raw: unknown): ImageFeatureConfig {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error("Image config must be an object");
  }
  const input = raw as Record<string, any>;
  if (input.schemaVersion !== 1) throw new Error("Unknown image config schema");
  if (!input.autoCompression || typeof input.autoCompression !== "object" || Array.isArray(input.autoCompression)) {
    throw new Error("Invalid auto compression settings");
  }
  if (typeof input.autoCompression.globalEnabled !== "boolean") {
    throw new Error("Invalid global compression switch");
  }
  const pages = input.autoCompression.pageAllowlist;
  if (!pages || typeof pages !== "object" || Array.isArray(pages)) {
    throw new Error("Invalid page allowlist");
  }
  const safePages: ImageFeatureConfig["autoCompression"]["pageAllowlist"] = {};
  for (const [id, meta] of Object.entries(pages)) {
    if (!/^\d{14}-[0-9a-z]{7}$/.test(id)) throw new Error("Invalid page rootID");
    if (!meta || typeof meta !== "object" || Array.isArray(meta)) throw new Error("Invalid page permission");
    const row = meta as Record<string, unknown>;
    if (typeof row.grantedAt !== "number" || !Number.isFinite(row.grantedAt) || row.grantedAt < 0) {
      throw new Error("Invalid permission timestamp");
    }
    if (row.titleSnapshot !== undefined && typeof row.titleSnapshot !== "string") {
      throw new Error("Invalid permission title snapshot");
    }
    if (row.notebookIdSnapshot !== undefined && typeof row.notebookIdSnapshot !== "string") {
      throw new Error("Invalid permission notebook snapshot");
    }
    safePages[id] = {
      grantedAt: row.grantedAt,
      ...(row.titleSnapshot !== undefined ? { titleSnapshot: row.titleSnapshot } : {}),
      ...(row.notebookIdSnapshot !== undefined ? { notebookIdSnapshot: row.notebookIdSnapshot } : {}),
    };
  }
  const rawCompression = input.compression;
  if (!rawCompression || typeof rawCompression !== "object" || Array.isArray(rawCompression)) throw new Error("Missing compression settings");
  const defaults = compressionDefaults;
  const compression = {} as CompressionSettings;
  for (const [key, fallback] of Object.entries(defaults)) {
    let value = rawCompression[key];
    // schemaVersion 1 was shipped with four format booleans. Read them without
    // treating existing settings as corrupt; never write during parsing.
    if (key === "excludedExtensions") value = readExcludedExtensions(rawCompression);
    if (typeof value !== typeof fallback) throw new Error(`Invalid compression field: ${key}`);
    if (typeof value === "number" && !Number.isFinite(value)) {
      throw new Error(`Non-finite compression field: ${key}`);
    }
    (compression as any)[key] = value;
  }
  if (compression.quality < 0.1 || compression.quality > 1 ||
      !Number.isInteger(compression.maxDimension) || compression.maxDimension < 256 || compression.maxDimension > 8192 ||
      !Number.isInteger(compression.minSizeBytes) || compression.minSizeBytes < 0 || compression.minSizeBytes > 100 * 1024 * 1024 ||
      compression.minSavingRatio < 0 || compression.minSavingRatio > 1 ||
      !Number.isInteger(compression.concurrencyDesktop) || compression.concurrencyDesktop < 1 || compression.concurrencyDesktop > 8 ||
      !Number.isInteger(compression.concurrencyMobile) || compression.concurrencyMobile < 1 || compression.concurrencyMobile > 3) {
    throw new Error("Compression options out of range");
  }
  return {
    schemaVersion: 1,
    autoCompression: { globalEnabled: input.autoCompression.globalEnabled, pageAllowlist: safePages },
    compression,
  };
}
