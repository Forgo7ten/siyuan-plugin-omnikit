import { Plugin, getFrontend, showMessage } from "siyuan";
import { FeatureCatalog } from "./framework/FeatureCatalog.ts";
import { FeatureManager } from "./framework/FeatureManager.ts";
import type { FeatureContext } from "./framework/FeatureContext.ts";
import { SettingsManager } from "./store/SettingsManager.ts";
import { MenuRegistry } from "./feedback/MenuRegistry.ts";
import { installMenuRouter } from "./feedback/MenuRouter.ts";
import { Logger } from "./host/Logger.ts";
import { UiFeedback } from "./feedback/UiFeedback.ts";
import { PluginStatusBar } from "./feedback/PluginStatusBar.ts";
import { imageCompressorRegistration } from "../features/image-compressor/registration.ts";
import { titledLinkRegistration } from "../features/titled-link/registration.ts";
import { documentDiffRegistration } from "../features/document-diff/registration.ts";
import { createSettingsWindow } from "../ui/settings/mountSettings.ts";
import { registerTopBar } from "../ui/topbar/registerTopBar.ts";
import { registerDock } from "../ui/dock/registerDock.ts";
import { OMNIKIT_ICONS } from "../ui/icons.ts";
import { translate } from "../i18n/translate.ts";
import { setFrontendResolver } from "./host/Platform.ts";
import "../styles/index.scss";

/** @design Add one registration here; no changes to core schema or SettingsRoot.svelte. */
const registrations = [imageCompressorRegistration, titledLinkRegistration, documentDiffRegistration];

/**
 * @design A `body--settings` instance mounts stores and Svelte `SettingsRoot` only;
 * host menus, Dock, and feature runtime run exclusively in main window instances.
 * Settings changes synchronize across instances via `onDataChanged` rather than shared memory.
 */
export class OmniKitPlugin extends Plugin {
  private readonly catalog = new FeatureCatalog();
  private readonly logger = Logger.shared;
  private settingsManager?: SettingsManager;
  private manager?: FeatureManager;
  private menuRegistry?: MenuRegistry;
  private statusBar?: PluginStatusBar;
  private disposeMenuRouter?: () => void;
  private refreshDock?: () => void;
  private disposeCoreSubscription?: () => void;
  private disposeStatusSubscription?: () => void;
  private settingsWindow?: ReturnType<typeof createSettingsWindow>;
  private unloading = false;
  private settingsInstance = false;
  private ready?: Promise<void>;

  private t(key: string, values?: Record<string, string | number>): string {
    return translate(this.i18n as Record<string, unknown>, key, values);
  }

  onload(): Promise<void> {
    this.unloading = false;
    this.settingsInstance = document.body.classList.contains("body--settings");
    this.ready = this.initialize();
    return this.ready;
  }

  /** The host can call this before async initialization has created the settings window. */
  override openSetting(): void {
    void this.ready?.then(() => {
      if (this.unloading) return;
      this.settingsWindow?.open();
    }).catch(error => this.logger.error("打开设置失败", error));
  }

  private async initialize(): Promise<void> {
    setFrontendResolver(() => getFrontend());
    this.addIcons(OMNIKIT_ICONS);
    const settings = new SettingsManager(this, registrations);
    await settings.load();
    if (this.unloading) return;
    this.settingsManager = settings;
    this.disposeCoreSubscription = settings.core.subscribe(core => {
      this.logger.setDebugEnabled(core.general.debugLog);
    });

    if (this.settingsInstance) {
      this.settingsWindow = createSettingsWindow({
        registrations,
        settings,
        t: (key, values) => this.t(key, values),
      });
      return;
    }

    for (const registration of registrations) {
      this.catalog.register(registration.create(this, settings));
    }
    const feedback = new UiFeedback(undefined, (msg, timeout, type) => showMessage(msg, timeout, type));
    const menus = new MenuRegistry(
      id => this.manager?.isRunning(id) === true,
      error => this.logger.error("菜单操作失败", error),
      this.logger,
      () => feedback.notify(this.t("menu.featureInactive"), "info", { timeout: 3000 }),
    );
    this.menuRegistry = menus;
    this.statusBar = new PluginStatusBar();
    const featureContext: FeatureContext = {
      plugin: this,
      settings,
      menus,
      logger: this.logger,
      feedback,
      statusBar: this.statusBar,
    };
    const manager = new FeatureManager(this.catalog, featureContext);
    this.manager = manager;
    this.disposeStatusSubscription = manager.subscribeStatus(() => this.refreshDock?.());
    this.settingsWindow = createSettingsWindow({
      registrations,
      settings,
      manager,
      t: (key, values) => this.t(key, values),
    });
    this.disposeMenuRouter = installMenuRouter(this, menus, this.logger);
    this.refreshDock = registerDock(this, {
      type: "omnikit-dock",
      icon: "iconOmnikitMenu",
      title: "OmniKit",
      context: featureContext,
      views: () => registrations.flatMap(registration =>
        registration.dockView && manager.isRunning(registration.id)
          ? [{ id: registration.id, title: this.t(registration.titleKey), component: registration.dockView, frontends: registration.frontends }]
          : []),
      t: (key, values) => this.t(key, values),
      openSettings: () => this.openSetting(),
    });
    await manager.initialize();
    if (this.unloading) return;
    this.refreshDock?.();
  }

  onLayoutReady(): void {
    // @safety onLayoutReady may fire before async onload finishes.
    void this.ready?.then(() => {
      if (this.unloading || this.settingsInstance || !this.menuRegistry) return;
      this.statusBar?.mount(this);
      // Core UI remains available even if every Feature is disabled.
      registerTopBar(this, {
        title: this.t("settings"),
        menus: this.menuRegistry,
        openSettings: () => this.openSetting(),
      });
    }).catch(error => this.logger.error("初始化顶部栏失败", error));
  }

  async onDataChanged(): Promise<void> {
    await this.ready?.catch(() => undefined);
    if (this.unloading || !this.settingsManager) return;
    if (!this.settingsInstance && this.manager) {
      for (const registration of registrations) {
        if (registration.reloadData) {
          try {
            await registration.reloadData(this);
          } catch (error) {
            this.logger.error(`Feature ${registration.id} reloadData 失败`, error);
          }
        }
      }
      if (this.unloading) return;
      const changed = await this.settingsManager.reloadAfterExternalChange();
      if (this.unloading) return;
      if (changed.includes("core")) await this.manager.reconcileFromLoadedSettings();
      for (const id of changed) {
        if (id !== "core") await this.manager.notifySettingsChanged(id);
      }
      this.refreshDock?.();
      return;
    }
    await this.settingsManager.reloadAfterExternalChange();
  }

  async onunload(): Promise<void> {
    this.unloading = true;
    this.statusBar?.dispose();
    this.disposeCoreSubscription?.();
    this.disposeStatusSubscription?.();
    this.manager?.freezeAll();
    this.disposeMenuRouter?.();
    this.settingsWindow?.close();
    try {
      await this.manager?.disposeAll();
    } catch (error) {
      this.logger.error("清理功能失败", error);
    }
  }
}
