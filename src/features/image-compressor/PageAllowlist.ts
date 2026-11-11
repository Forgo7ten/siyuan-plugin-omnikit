import type { SettingsManager } from "../../core/SettingsManager.ts";
import { IMAGE_FEATURE_ID } from "./settings.ts";
import type { ImageFeatureConfig, PagePermission } from "./registration.ts";

export interface DocumentPermission extends PagePermission { rootId: string; }

/**
 * @design The allowlist belongs to feature-image-compressor.json, never core settings.
 * @invariant Global ON ignores the allowlist for behavior; list changes are preserved
 * for use when Global is switched OFF again.
 */
export class PageAllowlist {
  constructor(private readonly settings: SettingsManager) {}

  get needsRecovery(): boolean {
    return this.settings.store(IMAGE_FEATURE_ID).needsRecovery;
  }

  async recoverCorruptData(): Promise<void> {
    await this.settings.store(IMAGE_FEATURE_ID).recoverWithBackup();
  }

  hasCached(rootId: string): boolean {
    return Boolean(this.settings.getFeature<ImageFeatureConfig>(IMAGE_FEATURE_ID)
      .autoCompression.pageAllowlist[rootId]);
  }

  async has(rootId: string): Promise<boolean> { return this.hasCached(rootId); }

  async list(): Promise<DocumentPermission[]> {
    const pages = this.settings.getFeature<ImageFeatureConfig>(IMAGE_FEATURE_ID)
      .autoCompression.pageAllowlist;
    return Object.entries(pages)
      .map(([rootId, value]) => ({ rootId, ...value }))
      .sort((a, b) => a.rootId.localeCompare(b.rootId));
  }

  async toggle(rootId: string, meta: Partial<Omit<DocumentPermission, "rootId" | "grantedAt">> = {}): Promise<boolean> {
    let added = false;
    await this.settings.updateFeature<ImageFeatureConfig>(IMAGE_FEATURE_ID, draft => {
      const pages = draft.autoCompression.pageAllowlist;
      if (pages[rootId]) { delete pages[rootId]; added = false; }
      else {
        pages[rootId] = {
          grantedAt: Date.now(),
          ...(meta.titleSnapshot ? { titleSnapshot: meta.titleSnapshot } : {}),
          ...(meta.notebookIdSnapshot ? { notebookIdSnapshot: meta.notebookIdSnapshot } : {}),
        };
        added = true;
      }
    });
    return added;
  }

  async remove(rootId: string): Promise<void> {
    await this.settings.updateFeature<ImageFeatureConfig>(IMAGE_FEATURE_ID, draft => {
      delete draft.autoCompression.pageAllowlist[rootId];
    });
  }
}
