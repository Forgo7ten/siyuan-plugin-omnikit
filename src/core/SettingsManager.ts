import type { Plugin } from "siyuan";
import { JsonStore, type StoreCodec } from "./JsonStore.ts";
import type { FeatureRegistration } from "./FeatureRegistration.ts";

export interface GeneralSettings {
  debugLog: boolean;
}
export interface CoreSettings {
  schemaVersion: 1;
  general: GeneralSettings;
  /** Feature enabled preference only: no feature options here. */
  featureStates: Record<string, { enabled: boolean }>;
}

const coreDefaults = (): CoreSettings => ({
  schemaVersion: 1,
  general: { debugLog: false },
  featureStates: {},
});

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Expected a JSON object");
  }
  return value as Record<string, unknown>;
}

const coreCodec: StoreCodec<CoreSettings> = {
  defaults: coreDefaults,
  parse(raw): CoreSettings {
    const value = object(raw);
    if (value.schemaVersion !== 1) throw new Error("Unsupported core schemaVersion");
    const general = object(value.general);
    const states = object(value.featureStates);
    if (typeof general.debugLog !== "boolean") throw new Error("Invalid general settings");
    const featureStates: CoreSettings["featureStates"] = {};
    for (const [id, state] of Object.entries(states)) {
      const parsed = object(state);
      if (typeof parsed.enabled !== "boolean") throw new Error(`Invalid feature state: ${id}`);
      featureStates[id] = { enabled: parsed.enabled };
    }
    return {
      schemaVersion: 1,
      general: {
        debugLog: general.debugLog,
      },
      featureStates,
    };
  },
};

/**
 * @design Core switches and feature data live in different files.
 * @invariant Adding Feature N requires registering its codec/file only; no core schema edit.
 * @safety Cross-file transactions are never assumed. Toggle writes only core JSON;
 * feature options write only their own feature JSON.
 */
export class SettingsManager {
  readonly core: JsonStore<CoreSettings>;
  private readonly featureStores = new Map<string, JsonStore<any>>();
  private readonly definitions = new Map<string, FeatureRegistration<any>>();

  constructor(plugin: Plugin, registrations: readonly FeatureRegistration<any>[]) {
    this.core = new JsonStore(plugin, "omnikit-core.json", coreCodec);
    for (const definition of registrations) {
      if (this.featureStores.has(definition.id)) {
        throw new Error(`Duplicate feature: ${definition.id}`);
      }
      if ([...this.featureStores.values()].some(store => store.file === definition.file)) {
        throw new Error(`Duplicate feature file: ${definition.file}`);
      }
      this.definitions.set(definition.id, definition);
      this.featureStores.set(definition.id, new JsonStore(plugin, definition.file, definition.codec));
    }
  }

  async load(): Promise<void> {
    await this.core.load();
    for (const store of this.featureStores.values()) await store.load();
  }

  get needsRecovery(): boolean {
    return this.core.needsRecovery || [...this.featureStores.values()].some(s => s.needsRecovery);
  }

  getGeneral(): GeneralSettings { return this.core.snapshot().general; }
  updateGeneral(patch: Partial<GeneralSettings>): Promise<boolean> {
    return this.core.update(draft => Object.assign(draft.general, patch));
  }

  getFeatureEnabled(id: string, defaultEnabled = false): boolean {
    if (this.core.needsRecovery || this.featureStores.get(id)?.needsRecovery) return false;
    return this.core.snapshot().featureStates[id]?.enabled ?? defaultEnabled;
  }

  setFeatureEnabled(id: string, enabled: boolean): Promise<boolean> {
    this.requireStore(id);
    return this.core.update(draft => {
      draft.featureStates[id] = { enabled };
    });
  }

  store<T>(id: string): JsonStore<T> {
    return this.requireStore(id) as JsonStore<T>;
  }
  getFeature<T>(id: string): T {
    return this.store<T>(id).snapshot();
  }
  updateFeature<T>(id: string, mutator: (draft: T) => void): Promise<boolean> {
    return this.store<T>(id).update(mutator);
  }

  /** Called on SiYuan onDataChanged. Never writes files back. */
  async reloadAfterExternalChange(): Promise<string[]> {
    const changed: string[] = [];
    if (await this.core.reload()) changed.push("core");
    for (const [id, store] of this.featureStores) {
      if (await store.reload()) changed.push(id);
    }
    return changed;
  }

  private requireStore(id: string): JsonStore<unknown> {
    const store = this.featureStores.get(id);
    if (!store) throw new Error(`Unregistered feature config: ${id}`);
    return store;
  }
}
