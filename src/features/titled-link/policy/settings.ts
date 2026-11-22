import type { StoreCodec } from "../../../core/store/JsonStore.ts";
import type { TitledLinkConfig } from "./types.ts";

export function defaultTitledLinkConfig(): TitledLinkConfig {
  return {
    schemaVersion: 1,
    auto: { enabled: true },
    replaceTitle: false,
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

  return {
    schemaVersion: 1,
    auto: { enabled: boolean(auto.enabled, "auto.enabled") },
    replaceTitle: boolean(config.replaceTitle, "replaceTitle"),
    fallbackToHostname: boolean(config.fallbackToHostname, "fallbackToHostname"),
  };
}

export const titledLinkSettingsCodec: StoreCodec<TitledLinkConfig> = {
  defaults: defaultTitledLinkConfig,
  parse: parseTitledLinkConfig,
};

