import type { StoreCodec } from "../../../core/store/JsonStore.ts";
import type { TitledLinkConfig } from "./types.ts";

export const TITLED_LINK_SETTINGS_FILE = "feature-titled-link-settings.json" as const;

export function defaultTitledLinkConfig(): TitledLinkConfig {
  return {
    schemaVersion: 1,
    auto: { enabled: true },
    replaceTitle: false,
    maxTitleLength: 80,
    fallbackToHostname: true,
  };
}

function object(value: unknown, name: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${name}: object required`);
  }
  return value as Record<string, unknown>;
}

function boolean(value: unknown, name: string): boolean {
  if (typeof value !== "boolean") throw new Error(`${name}: boolean required`);
  return value;
}

export function parseTitledLinkConfig(raw: unknown): TitledLinkConfig {
  const config = object(raw, "config");
  if (config.schemaVersion !== 1) {
    throw new Error("Only titled-link config schemaVersion 1 is supported");
  }
  const auto = object(config.auto, "auto");
  const maxTitleLength = config.maxTitleLength;
  if (!Number.isSafeInteger(maxTitleLength) || (maxTitleLength as number) < 0 || (maxTitleLength as number) > 200) {
    throw new Error("maxTitleLength: integer from 0 to 200 required");
  }

  return {
    schemaVersion: 1,
    auto: { enabled: boolean(auto.enabled, "auto.enabled") },
    replaceTitle: boolean(config.replaceTitle, "replaceTitle"),
    maxTitleLength: maxTitleLength as number,
    fallbackToHostname: boolean(config.fallbackToHostname, "fallbackToHostname"),
  };
}

export const titledLinkSettingsCodec: StoreCodec<TitledLinkConfig> = {
  defaults: defaultTitledLinkConfig,
  parse: parseTitledLinkConfig,
};

