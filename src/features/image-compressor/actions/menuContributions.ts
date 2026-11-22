import type { MenuContext, MenuLocation, MenuProvider } from "../../../core/feedback/MenuRegistry.ts";

/**
 * @design Declarations only: every action arrives through `deps`, so this module never
 * imports the SiYuan runtime and stays loadable by the test harness.
 */
export interface ImageMenuDeps {
  t: (key: string, values?: Record<string, string | number>) => string;
  icon: string;
  isAllowlisted: (ctx: MenuContext) => boolean;
  compressQuick: (ctx: MenuContext) => Promise<void>;
  compressCustom: (ctx: MenuContext) => Promise<void>;
  toggleDocument: (ctx: MenuContext) => Promise<void>;
  runBatch: (ctx: MenuContext) => Promise<void>;
}

export interface ImageMenuContribution {
  location: MenuLocation;
  id: string;
  provider: MenuProvider;
}

/**
 * @design Menu providers are pure and synchronous: whitelist state comes from the cached
 * settings tree, while reading/compressing/uploading only starts inside `run()`.
 * @invariant All providers are registered through the feature scope by the caller.
 */
export function imageMenuContributions(deps: ImageMenuDeps): ImageMenuContribution[] {
  const toggle = (ctx: MenuContext) => (ctx.rootID ? [{
    id: "toggle-document",
    label: deps.t("menu.whitelistDocument"),
    icon: deps.icon,
    checked: deps.isAllowlisted(ctx),
    run: () => deps.toggleDocument(ctx),
  }] : []);

  return [
    {
      location: "image",
      id: "compress-image",
      provider: ctx => [{
        id: "compress-image-quick",
        label: deps.t("menu.compressImageQuick"),
        icon: deps.icon,
        run: () => deps.compressQuick(ctx),
      }, {
        id: "compress-image-custom",
        label: deps.t("menu.compressImageCustom"),
        icon: deps.icon,
        run: () => deps.compressCustom(ctx),
      }],
    },
    { location: "doc-title", id: "toggle-document", provider: toggle },
    {
      location: "doc-title",
      id: "compress-document",
      provider: ctx => [{
        id: "compress-document",
        label: deps.t("menu.compressDocument"),
        icon: deps.icon,
        run: () => deps.runBatch(ctx),
      }],
    },
    {
      location: "doc-tree",
      id: "toggle-document",
      provider: toggle,
    },
    {
      location: "doc-tree",
      id: "compress-document",
      provider: ctx => (ctx.rootID ? [{
        id: "compress-document",
        label: deps.t("menu.compressDocument"),
        icon: deps.icon,
        run: () => deps.runBatch(ctx),
      }] : []),
    },
    {
      location: "topbar",
      id: "toggle-document",
      provider: toggle,
    },
    {
      location: "topbar",
      id: "compress-document",
      provider: ctx => [{
        id: "compress-document",
        label: deps.t("menu.compressDocument"),
        icon: deps.icon,
        disabled: !ctx.rootID,
        run: () => deps.runBatch(ctx),
      }],
    },
  ];
}
