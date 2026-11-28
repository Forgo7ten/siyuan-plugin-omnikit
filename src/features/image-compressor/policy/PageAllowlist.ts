import type { SettingsManager } from "../../../core/store/SettingsManager.ts";
import { IMAGE_FEATURE_ID } from "./parseImageConfig.ts";
import type { ImageFeatureConfig } from "../registration.ts";

/**
 * @design The allowlist belongs to feature-image-compressor.json, never core settings.
 * @invariant Global ON ignores the allowlist for behavior; list changes are preserved
 * for use when Global is switched OFF again.
 */
export class PageAllowlist {
  constructor(private readonly settings: SettingsManager) {}

  hasCached(rootId: string): boolean {
    return Boolean(this.settings.getFeature<ImageFeatureConfig>(IMAGE_FEATURE_ID)
      .auto.pageAllowlist[rootId]);
  }

  async toggle(rootId: string): Promise<boolean> {
    let added = false;
    await this.settings.updateFeature<ImageFeatureConfig>(IMAGE_FEATURE_ID, draft => {
      const pages = draft.auto.pageAllowlist;
      if (pages[rootId]) {
        delete pages[rootId];
        added = false;
      } else {
        pages[rootId] = { grantedAt: Date.now() };
        added = true;
      }
    });
    return added;
  }
}
