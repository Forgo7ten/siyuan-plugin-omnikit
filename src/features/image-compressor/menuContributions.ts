import type { FeatureContext } from "../../core/FeatureContext.ts";
import type { FeatureScope } from "../../core/FeatureScope.ts";
import type { MenuContext, MenuLocation, MenuProvider } from "../../core/MenuRegistry.ts";

/**
 * @design Declarations only: every action arrives through `deps`, so this module never
 * imports the SiYuan runtime and stays loadable by the test harness.
 */
export interface ImageMenuDeps {
  scope: FeatureScope;
  context: FeatureContext;
  t: (key: string, values?: Record<string, string | number>) => string;
  icon: string;
  label: (ctx: MenuContext) => string;
  compressImage: (ctx: MenuContext) => Promise<void>;
  toggleDocument: (ctx: MenuContext) => Promise<void>;
  runBatch: (ctx: MenuContext) => Promise<void>;
}

export interface ImageMenuContribution {
  location: MenuLocation;
  id: string;
  provider: MenuProvider;
}

/**
 * @design Menu providers are pure and synchronous: labels come from the cached settings
 * tree, while reading/compressing/uploading only starts inside `run()`.
 * @invariant All providers are registered through the feature scope by the caller.
 */
export function imageMenuContributions(deps: ImageMenuDeps): ImageMenuContribution[] {
  const toggle = (ctx: MenuContext) => [{
    id: "toggle-document",
    label: deps.label(ctx),
    icon: deps.icon,
    run: () => deps.toggleDocument(ctx),
  }];

  return [
    {
      location: "image",
      id: "compress-image",
      provider: ctx => [{
        id: "compress-image",
        label: deps.t("menu.compressImage"),
        icon: deps.icon,
        run: () => deps.compressImage(ctx),
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
      provider: ctx => (ctx.rootID ? toggle(ctx) : []),
    },
    {
      location: "topbar",
      id: "toggle-document",
      provider: ctx => (ctx.rootID ? toggle(ctx) : []),
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
