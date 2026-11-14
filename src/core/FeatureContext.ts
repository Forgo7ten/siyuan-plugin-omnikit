import type { Plugin } from "siyuan";
import type { FeatureScope } from "./FeatureScope.ts";
import type { SettingsManager } from "./SettingsManager.ts";
import type { MenuRegistry } from "./MenuRegistry.ts";
import type { Logger } from "./Logger.ts";
import type { Compatibility } from "./Compatibility.ts";

export type FeatureId = string;
export interface FeatureMetadata {
  id: FeatureId; title: string; description: string;
  category: "media" | "document" | "text" | "workspace" | "other";
  icon: string; defaultEnabled: boolean; minimumAppVersion?: string;
}
/**
 * @design The context exposes core capabilities only. It never carries resolved settings
 * values, so a feature always reads the current configuration instead of a stale copy.
 */
export interface FeatureContext {
  plugin: Plugin; settings: SettingsManager; menus: MenuRegistry; compatibility: Compatibility; logger: Logger;
}
export interface FeatureCallbacks { onEnabled?: () => void; onDisabled?: () => void; onFailed?: (error: unknown) => void; }
export type FeatureSetup = (context: FeatureContext, scope: FeatureScope) => void | Promise<void>;
