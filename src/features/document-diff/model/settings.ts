import type { StoreCodec } from "../../../core/store/JsonStore.ts";

export interface DocumentDiffConfig {
  defaultSyncScroll: boolean;
}

export function defaultDocumentDiffConfig(): DocumentDiffConfig {
  return {
    defaultSyncScroll: true,
  };
}

export function parseDocumentDiffConfig(input: unknown): DocumentDiffConfig {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new Error("Invalid document-diff settings: expected an object");
  }
  const record = input as Record<string, unknown>;
  const defaults = defaultDocumentDiffConfig();
  if (record.defaultSyncScroll !== undefined && typeof record.defaultSyncScroll !== "boolean") {
    throw new Error("Invalid document-diff settings: defaultSyncScroll must be a boolean");
  }
  return {
    defaultSyncScroll: record.defaultSyncScroll ?? defaults.defaultSyncScroll,
  };
}

export const documentDiffSettingsCodec: StoreCodec<DocumentDiffConfig> = {
  defaults: defaultDocumentDiffConfig,
  parse: parseDocumentDiffConfig,
};
