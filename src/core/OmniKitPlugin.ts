import { Plugin, getFrontend } from "siyuan";
import { FeatureCatalog } from "./FeatureCatalog.ts";
import { FeatureManager } from "./FeatureManager.ts";
import { SettingsManager } from "./SettingsManager.ts";
import { MenuRegistry } from "./MenuRegistry.ts";
import { installMenuRouter } from "./MenuRouter.ts";
import { Logger } from "./Logger.ts";
import { Compatibility } from "./Compatibility.ts";
import { imageCompressorRegistration } from "../features/image-compressor/registration.ts";
import { createSettingsWindow } from "../ui/settings/mountSettings.ts";
import { registerTopBar } from "../ui/topbar/registerTopBar.ts";
import { registerDock } from "../ui/dock/registerDock.ts";
import { OMNIKIT_ICONS } from "../ui/icons.ts";
import { translate } from "../i18n/translate.ts";
import { isMobileFrontend, setFrontendResolver } from "./Platform.ts";
import "../styles/index.scss";

/** @design Add one registration here; no changes to core schema or SettingsRoot.svelte. */
const registrations = [imageCompressorRegistration];

/**
 * @migration-settings-window SiYuan 3.8.7+: a body--settings instance may mount stores
 * and Svelte SettingsRoot only; never initialize host menus, Dock or auto-upload listeners.
 * Settings changes synchronize through onDataChanged, not shared JS memory.
 */
export class OmniKitPlugin extends Plugin {
  private readonly catalog = new FeatureCatalog();
  private readonly logger = Logger.shared;
  private readonly compatibility = new Compatibility();
  private settingsManager?: SettingsManager;
  private manager?: FeatureManager;
  private menuRegistry?: MenuRegistry;
  private disposeMenuRouter?: () => void;
  private refreshDock?: () => void;
  private settingsWindow?: ReturnType<typeof createSettingsWindow>;
  private unloading = false;
  private settingsInstance = false;
  private ready?: Promise<void>;

  private t(key: string): string {
    return translate(this.i18n as Record<string, unknown>, key);
  }

  onload(): Promise<void> {
    this.unloading = false;
    this.settingsInstance = document.body.classList.contains("body--settings");
    this.ready = this.initialize();
    return this.ready;
  }

  private async initialize(): Promise<void> {
    setFrontendResolver(() => getFrontend());
    this.addIcons(OMNIKIT_ICONS);
    const settings = new SettingsManager(this, registrations);
    await settings.load();
    if (this.unloading) return;
    this.settingsManager = settings;
    this.logger.setDebugEnabled(settings.getGeneral().debugLog);

    for (const registration of registrations) {
      this.catalog.register(registration.create(this, settings));
    }
    if (!this.settingsInstance) {
      const menus = new MenuRegistry(
        id => this.manager?.isRunning(id) === true,
        error => this.logger.error("菜单操作失败", error),
        this.logger,
      );
      this.menuRegistry = menus;
      this.manager = new FeatureManager(this.catalog, {
        plugin: this, settings, menus, compatibility: this.compatibility, logger: this.logger,
      });
    }
    this.settingsWindow = createSettingsWindow({
      registrations, settings, manager: this.manager, t: key => this.t(key),
    });

    if (this.settingsInstance) {
      this.settingsWindow.open();
      return;
    }
    if (this.unloading) return;
    this.disposeMenuRouter = installMenuRouter(this, this.menuRegistry!, this.logger);
    this.refreshDock = registerDock(this, {
      type: "omnikit-dock",
      icon: "iconOmnikitMenu",
      title: "OmniKit",
      mobile: isMobileFrontend(),
      statuses: () => this.manager?.statuses() ?? [],
      t: key => this.t(key),
      openSettings: () => this.settingsWindow?.open(),
    });
    await this.manager!.initialize();
    this.refreshDock?.();
  }

  onLayoutReady(): void {
    // @safety onLayoutReady may fire before async onload finishes.
    void this.ready?.then(() => {
      if (this.unloading || this.settingsInstance || !this.menuRegistry) return;
      // Core UI remains available even if every Feature is disabled.
      registerTopBar(this, {
        title: this.t("settings"),
        menus: this.menuRegistry,
        openSettings: () => this.settingsWindow?.open(),
      });
    }).catch(error => this.logger.error("初始化顶部栏失败", error));
  }

  async onDataChanged(): Promise<void> {
    if (this.unloading || !this.settingsManager) return;
    const changed = await this.settingsManager.reloadAfterExternalChange();
    if (this.unloading || changed.length === 0) return;
    this.logger.setDebugEnabled(this.settingsManager.getGeneral().debugLog);
    if (!this.settingsInstance && this.manager) {
      if (changed.includes("core")) await this.manager.reconcileFromLoadedSettings();
      for (const id of changed) {
        if (id !== "core") await this.manager.notifySettingsChanged(id);
      }
      this.refreshDock?.();
    }
  }

  onunload(): void {
    this.unloading = true;
    this.manager?.freezeAll();
    this.disposeMenuRouter?.();
    this.settingsWindow?.close();
    void this.manager?.disposeAll().catch(error => {
      this.logger.error("清理功能失败", error);
    });
  }
}
