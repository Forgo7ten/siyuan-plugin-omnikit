import type { Component } from "svelte";
import type { Plugin } from "siyuan";
import type { BaseFeature } from "./BaseFeature.ts";
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
  file: `feature-${string}.json`;
  codec: StoreCodec<T>;
  create(plugin: Plugin, settings: SettingsManager): BaseFeature;
  /** Settings UI belongs to the feature; core never checks a feature id. */
  settingsView: Component<{
    store: JsonStore<T>;
    disabled: boolean;
    t: (key: string) => string;
  }>;
}

export function defineFeature<T>(registration: FeatureRegistration<T>): FeatureRegistration<T> {
  if (!/^[a-z][a-zA-Z0-9]*$/.test(registration.id)) {
    throw new Error(`Invalid feature id: ${registration.id}`);
  }
  return registration;
}
