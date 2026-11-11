import { defineFeature } from "../../core/FeatureRegistration.ts";
import { ImageCompressorFeature } from "./ImageCompressorFeature.ts";
import ImageSettingsPanel from "./ImageSettingsPanel.svelte";
import { compressionDefaults, type CompressionSettings } from "./settings.ts";

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

function parseImageConfig(raw: unknown): ImageFeatureConfig {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error("Image config must be an object");
  }
  const input = raw as Record<string, any>;
  if (input.schemaVersion !== 1) throw new Error("Unknown image config schema");
  if (typeof input.autoCompression?.globalEnabled !== "boolean") {
    throw new Error("Invalid global compression switch");
  }
  const pages = input.autoCompression.pageAllowlist;
  if (!pages || typeof pages !== "object" || Array.isArray(pages)) {
    throw new Error("Invalid page allowlist");
  }
  const safePages: ImageFeatureConfig["autoCompression"]["pageAllowlist"] = {};
  for (const [id, meta] of Object.entries(pages)) {
    if (!/^\d{14}-[a-z0-9]{7}$/.test(id)) throw new Error("Invalid page rootID");
    if (!meta || typeof meta !== "object") throw new Error("Invalid page permission");
    const row = meta as PagePermission;
    if (typeof row.grantedAt !== "number" || !Number.isFinite(row.grantedAt)) {
      throw new Error("Invalid permission timestamp");
    }
    safePages[id] = {
      grantedAt: row.grantedAt,
      ...(typeof row.titleSnapshot === "string" ? { titleSnapshot: row.titleSnapshot } : {}),
      ...(typeof row.notebookIdSnapshot === "string" ? { notebookIdSnapshot: row.notebookIdSnapshot } : {}),
    };
  }
  const rawCompression = input.compression;
  if (!rawCompression || typeof rawCompression !== "object") throw new Error("Missing compression settings");
  const defaults = compressionDefaults;
  const compression = {} as CompressionSettings;
  for (const [key, fallback] of Object.entries(defaults)) {
    const value = rawCompression[key];
    if (typeof value !== typeof fallback) throw new Error(`Invalid compression field: ${key}`);
    if (typeof value === "number" && !Number.isFinite(value)) {
      throw new Error(`Non-finite compression field: ${key}`);
    }
    (compression as any)[key] = value;
  }
  if (compression.quality < 0.1 || compression.quality > 1 ||
      compression.maxDimension < 256 || compression.maxDimension > 8192 ||
      compression.minSizeBytes < 0 || compression.minSavingRatio < 0 ||
      compression.minSavingRatio > 1 || compression.concurrencyDesktop < 1 ||
      compression.concurrencyDesktop > 8 || compression.concurrencyMobile < 1 ||
      compression.concurrencyMobile > 3) throw new Error("Compression options out of range");
  return {
    schemaVersion: 1,
    autoCompression: { globalEnabled: input.autoCompression.globalEnabled, pageAllowlist: safePages },
    compression,
  };
}

/** No reference to the core settings schema and no legacy-config migration. */
export const imageCompressorRegistration = defineFeature<ImageFeatureConfig>({
  id: "imageCompressor",
  titleKey: "feature.imageCompressor.title",
  descriptionKey: "feature.imageCompressor.description",
  defaultEnabled: true,
  file: "feature-image-compressor.json",
  codec: { defaults: defaultImageFeatureConfig, parse: parseImageConfig },
  create: (plugin, settings) => new ImageCompressorFeature(plugin, settings),
  settingsView: ImageSettingsPanel,
});
