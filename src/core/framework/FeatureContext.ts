import type { Plugin } from "siyuan";
import type { FeatureScope } from "./FeatureScope.ts";
import type { SettingsManager } from "../store/SettingsManager.ts";
import type { MenuRegistry } from "../feedback/MenuRegistry.ts";
import type { Logger } from "../host/Logger.ts";
import type { SiyuanFrontend } from "../host/Platform.ts";
import type { UiFeedback } from "../feedback/UiFeedback.ts";
import type { PluginStatusBar } from "../feedback/PluginStatusBar.ts";

export type FeatureId = string;
export interface FeatureMetadata {
  id: FeatureId; title: string; description: string;
  category: "media" | "document" | "text" | "workspace" | "other";
  icon: string; defaultEnabled: boolean; minimumAppVersion?: string;
  readonly frontends?: readonly SiyuanFrontend[];
}
/**
 * @design The context exposes core capabilities only. It never carries resolved settings
 * values, so a feature always reads the current configuration instead of a stale copy.
 */
export interface FeatureContext {
  plugin: Plugin;
  settings: SettingsManager;
  menus: MenuRegistry;
  logger: Logger;
  feedback?: UiFeedback;
  statusBar?: PluginStatusBar;
  scope?: FeatureScope;
}
export interface FeatureCallbacks { onEnabled?: () => void; onDisabled?: () => void; onFailed?: (error: unknown) => void; }
export type FeatureSetup = (context: FeatureContext, scope: FeatureScope) => void | Promise<void>;
