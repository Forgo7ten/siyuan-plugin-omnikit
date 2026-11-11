import type { FeatureScope } from "./FeatureScope.ts";
import type { Logger } from "./Logger.ts";

export type MenuLocation = "topbar" | "doc-title" | "doc-tree" | "image";

export interface MenuContext {
  location: MenuLocation;
  rootID?: string;
  selectedDocumentCount?: number;
  imageElement?: HTMLElement;
  blockID?: string;
  imageURL?: string;
  /** Original host detail, for feature actions that need the full host context. */
  detail?: any;
}

export interface OmniMenuItem {
  id: string;
  label: string;
  icon?: string;
  iconHTML?: string;
  disabled?: boolean;
  run: () => void | Promise<void>;
}

export type MenuProvider = (context: MenuContext) => readonly OmniMenuItem[];

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
}

/**
 * @design This class only owns business menu contributions. It never creates the OmniKit
 * top-bar icon and never listens to host events; `MenuRouter` is the host adapter.
 * @invariant A contribution is rendered only while its scope is active and its owner is
 * runtime-running. Configuration alone never authorizes an action.
 * @invariant Contribution identity is `location/owner/id`: one feature may legitimately
 * expose the same action id in several host menus (for example a document action in the
 * title menu, the document tree and the top bar).
 * @safety Entries leave the registry when their scope expires, and an already-open host
 * menu re-checks authorization on click.
 * @safety A duplicate declaration is a programming error, not a runtime failure: it is
 * logged and skipped instead of aborting the whole feature activation.
 */
export class MenuRegistry {
  private readonly entries: Entry[] = [];

  constructor(
    private readonly isFeatureRunning: (id: string) => boolean,
    private readonly reportError: (error: unknown) => void,
    private readonly logger?: Logger,
  ) {}

  contribute(scope: FeatureScope, owner: string, location: MenuLocation, id: string, provider: MenuProvider): void {
    if (!scope.active) return;
    if (this.entries.some(entry => entry.location === location && entry.owner === owner && entry.id === id)) {
      this.reportError(new Error(`菜单项重复：${location}/${owner}/${id}`));
      return;
    }
    const entry: Entry = { scope, owner, location, id, provider };
    this.entries.push(entry);
    scope.own(() => {
      const index = this.entries.indexOf(entry);
      if (index >= 0) this.entries.splice(index, 1);
    });
  }

  /** Every host menu expansion reads live state; no menu DOM is cached. */
  render(location: MenuLocation, host: HostMenu, context: MenuContext): void {
    let declared = 0;
    let rendered = 0;
    const skippedFor: string[] = [];
    for (const entry of [...this.entries]) {
      if (entry.location !== location) continue;
      declared++;
      if (!entry.scope.active) { skippedFor.push(`${entry.owner}：功能作用域已停用`); continue; }
      if (!this.isFeatureRunning(entry.owner)) { skippedFor.push(`${entry.owner}：功能未运行`); continue; }

      let items: readonly OmniMenuItem[];
      try { items = entry.provider(context); }
      catch (error) { this.reportError(error); continue; }

      for (const item of items) {
        rendered++;
        const disabled = item.disabled === true;
        host.addItem({
          id: `omnikit-${entry.owner}-${item.id}`,
          label: item.label,
          icon: item.icon,
          iconHTML: item.iconHTML,
          disabled,
          click: () => {
            // @invariant An already-open menu may outlive the contribution.
            if (!entry.scope.active || !this.isFeatureRunning(entry.owner) || disabled) return;
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
      rootID: context.rootID,
      hasImage: Boolean(context.imageURL),
    });
  }

  list(owner: string): readonly OmniMenuItem[] {
    return this.entries
      .filter(entry => entry.owner === owner)
      .flatMap(entry => entry.provider({ location: entry.location }));
  }
}
