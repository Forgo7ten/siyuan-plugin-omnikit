import type { FeatureScope } from "../framework/FeatureScope.ts";
import type { Logger } from "../host/Logger.ts";

export type MenuLocation = "topbar" | "doc-title" | "doc-tree" | "image" | "link" | "blockicon";

export interface HostMenuContext {
  location: MenuLocation;
  rootID?: string;
  selectedDocumentIDs?: readonly string[];
  selectedDocumentCount?: number;
  protyle?: any;
  targetElement?: HTMLElement;
  blockID?: string;
  /** Original host detail, for feature actions that need the full host context. */
  detail?: any;

  /** Resolved image element and URL when triggered from an image menu. */
  imageElement?: HTMLElement;
  imageURL?: string;
}

export type MenuContext = HostMenuContext;

export type MenuMatcher = (context: HostMenuContext) => boolean;

export interface OmniMenuItem {
  id: string;
  label: string;
  icon?: string;
  iconHTML?: string;
  disabled?: boolean;
  run: () => void | Promise<void>;
}

export type MenuProvider = (context: HostMenuContext) => readonly OmniMenuItem[];

export interface HostMenu {
  addItem(item: {
    id?: string;
    label: string;
    icon?: string;
    iconHTML?: string;
    disabled?: boolean;
    click?: () => void;
  }): unknown;
}

interface Entry {
  owner: string;
  id: string;
  location: MenuLocation;
  scope: FeatureScope;
  provider: MenuProvider;
  matcher?: MenuMatcher;
}

/**
 * @design This class only owns business menu contributions. It never creates the OmniKit
 * top-bar icon and never listens to host events; `MenuRouter` is the host adapter.
 * @invariant A contribution is rendered only while its scope is active and its owner is
 * runtime-running. Configuration alone never authorizes an action.
 * @invariant Contribution identity is `location/owner/id`: one feature may legitimately
 * expose the same action id in several host menus.
 * @safety Entries leave the registry when their scope expires, and an already-open host
 * menu re-checks authorization on click.
 */
export class MenuRegistry {
  private readonly entries: Entry[] = [];

  constructor(
    private readonly isFeatureRunning: (id: string) => boolean,
    private readonly reportError: (error: unknown) => void,
    private readonly logger?: Logger,
    private readonly notifyInactive?: () => void,
  ) {}

  contribute(
    scope: FeatureScope,
    owner: string,
    location: MenuLocation,
    id: string,
    provider: MenuProvider,
    matcherOrOptions?: MenuMatcher | { matcher?: MenuMatcher },
  ): void {
    if (!scope.active) return;
    if (this.entries.some(entry => entry.location === location && entry.owner === owner && entry.id === id)) {
      this.reportError(new Error(`菜单项重复：${location}/${owner}/${id}`));
      return;
    }
    const matcher = typeof matcherOrOptions === "function"
      ? matcherOrOptions
      : matcherOrOptions?.matcher;
    const entry: Entry = { scope, owner, location, id, provider, matcher };
    this.entries.push(entry);
    scope.own(() => {
      const index = this.entries.indexOf(entry);
      if (index >= 0) this.entries.splice(index, 1);
    });
  }

  /** Every host menu expansion reads live state; no menu DOM is cached. */
  render(location: MenuLocation, host: HostMenu, context: HostMenuContext): void {
    let declared = 0;
    let rendered = 0;
    const skippedFor: string[] = [];

    const selectedDocumentIDs = context.selectedDocumentIDs ?? (context.rootID ? [context.rootID] : []);
    const selectedDocumentCount = context.selectedDocumentCount ?? selectedDocumentIDs.length;
    const normalizedContext: HostMenuContext = {
      ...context,
      selectedDocumentIDs,
      selectedDocumentCount,
    };

    for (const entry of [...this.entries]) {
      if (entry.location !== location) continue;
      declared++;
      if (!entry.scope.active) { skippedFor.push(`${entry.owner}：功能作用域已停用`); continue; }
      if (!this.isFeatureRunning(entry.owner)) { skippedFor.push(`${entry.owner}：功能未运行`); continue; }
      if (entry.matcher) {
        let matched = false;
        try {
          matched = entry.matcher(normalizedContext);
        } catch (error) {
          this.reportError(error);
          skippedFor.push(`${entry.owner}：Matcher 抛错`);
          continue;
        }
        if (!matched) {
          skippedFor.push(`${entry.owner}：Matcher 条件不满足`);
          continue;
        }
      }

      let items: readonly OmniMenuItem[];
      try { items = entry.provider(normalizedContext); }
      catch (error) { this.reportError(error); continue; }

      const isTopbar = location === "topbar";
      for (const item of items) {
        rendered++;
        const disabled = item.disabled === true;
        const cleanLabel = item.label.startsWith("[OmniKit] ") ? item.label.slice("[OmniKit] ".length) : item.label;
        const label = isTopbar ? cleanLabel : (item.label.startsWith("[OmniKit] ") ? item.label : `[OmniKit] ${item.label}`);
        host.addItem({
          id: `omnikit-${entry.owner}-${item.id}`,
          label,
          icon: item.icon,
          iconHTML: item.iconHTML,
          disabled,
          click: () => {
            this.logger?.debug("点击菜单项", {
              owner: entry.owner,
              location,
              itemId: item.id,
              label: cleanLabel,
              active: entry.scope.active,
              running: this.isFeatureRunning(entry.owner),
              disabled,
            });
            // @invariant An already-open menu may outlive the contribution.
            if (!entry.scope.active || !this.isFeatureRunning(entry.owner)) {
              this.notifyInactive?.();
              return;
            }
            if (disabled) return;
            try {
              Promise.resolve(item.run()).catch(error => this.reportError(error));
            } catch (error) { this.reportError(error); }
          },
        });
      }
    }
    this.logger?.debug("菜单绘制完成", {
      location,
      声明项数: declared,
      绘制项数: rendered,
      跳过项: skippedFor,
      rootID: normalizedContext.rootID,
      hasImage: Boolean(normalizedContext.imageURL),
    });
  }
}
