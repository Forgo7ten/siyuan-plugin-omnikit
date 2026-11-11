import type { BaseFeature } from "./BaseFeature.ts";
/**
 * @design The catalog captures feature definitions only. Registration must never create
 * host side effects; runtime resources belong to the FeatureScope of an activation.
 * @invariant Feature ids are stable and unique for the lifetime of the plugin instance.
 */
export class FeatureCatalog {
  private readonly entries = new Map<string, BaseFeature>();
  register(feature: BaseFeature): void {
    if (this.entries.has(feature.meta.id)) throw new Error(`Duplicate feature: ${feature.meta.id}`);
    this.entries.set(feature.meta.id, feature);
  }
  get(id: string): BaseFeature | undefined { return this.entries.get(id); }
  all(): BaseFeature[] { return [...this.entries.values()]; }
}
