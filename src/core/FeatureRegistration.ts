import type { Component } from "svelte";
import type { Plugin } from "siyuan";
import type { BaseFeature } from "./BaseFeature.ts";
import type { FeatureContext } from "./FeatureContext.ts";
import type { JsonStore, StoreCodec } from "./JsonStore.ts";
import type { SettingsManager } from "./SettingsManager.ts";

/**
 * @design Metadata remains available even when the feature runtime is stopped.
 * The only central extension point is adding one registration to featureRegistrations.
 */
export interface FeatureRegistration<T> {
  id: string;
  titleKey: string;
  descriptionKey: string;
  defaultEnabled: boolean;
  file: `feature-${string}-settings.json`;
  codec: StoreCodec<T>;
  create(plugin: Plugin, settings: SettingsManager): BaseFeature;
  /** Settings UI belongs to the feature; core never checks a feature id. */
  settingsView: Component<{
    store: JsonStore<T>;
    runtimePhase: string;
    t: (key: string) => string;
  }>;
  /** Optional feature-owned content for the shared OmniKit dock container. */
  dockView?: Component<{ context: FeatureContext; t: (key: string, values?: Record<string, string | number>) => string }>;
}

function featureSlug(id: string): string {
  if (!/^[a-z][a-zA-Z0-9]*(?:-[a-z0-9]+)*$/.test(id)) throw new Error(`Invalid feature id: ${id}`);
  return id.replace(/([a-z0-9])([A-Z])/g, "$1-$2").toLowerCase();
}

/** User configuration only; settings reset code must never be given a data filename. */
export function featureConfigFile(id: string): `feature-${string}-settings.json` {
  return `feature-${featureSlug(id)}-settings.json`;
}

/** Generate a separately owned business-data filename, never a settings store. */
export function featureDataFile(id: string, dataName: string): `feature-${string}.json` {
  const slug = featureSlug(id);
  if (!/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/.test(dataName) || dataName === "settings") {
    throw new Error(`Invalid feature data name: ${dataName}`);
  }
  return `feature-${slug}-${dataName}.json`;
}

/** Validate persisted business-data names against the feature and data-name contract. */
export function isFeatureDataFile(id: string, dataName: string, file: string): boolean {
  try { return file === featureDataFile(id, dataName); }
  catch { return false; }
}

export function validateFeatureFiles(ids: readonly string[]): void {
  if (new Set(ids).size !== ids.length) throw new Error("Duplicate feature ID");
  const files = ids.map(featureConfigFile);
  if (new Set(files).size !== files.length) throw new Error("Feature filename collision");
}

export function defineFeature<T>(registration: FeatureRegistration<T>): FeatureRegistration<T> {
  if (!/^[a-z][a-zA-Z0-9]*(?:-[a-z0-9]+)*$/.test(registration.id)) {
    throw new Error(`Invalid feature id: ${registration.id}`);
  }
  if (registration.file !== featureConfigFile(registration.id)) throw new Error(`Feature file must be derived from its id: ${registration.id}`);
  return registration;
}
