import type { Plugin } from "siyuan";
import type { Logger } from "./Logger.ts";
import type { MenuContext, MenuRegistry } from "./MenuRegistry.ts";

export interface SingleDocumentTarget {
  rootID: string;
}

export interface ImageMenuTarget {
  element: HTMLImageElement;
  url: string;
  blockID?: string;
  rootID?: string;
}

/**
 * @compat Event names exist since 3.8.0. The detail shapes below must be verified against
 * real 3.8.0 / 3.8.9 frontends; adapters never guess a target from the first `.protyle`.
 * @invariant The core installs one listener per host event, independent of feature count.
 */
export function installMenuRouter(plugin: Plugin, menus: MenuRegistry, logger?: Logger): () => void {
  const titleHandler = (event: CustomEvent<any>) => {
    const detail = event.detail;
    const rootID = detail?.protyle?.block?.rootID ?? detail?.editor?.protyle?.block?.rootID;
    if (!rootID || !detail?.menu) {
      logger?.debug("忽略文档标题菜单事件", { 文档根ID: rootID, 存在菜单: Boolean(detail?.menu) });
      return;
    }
    logger?.debug("打开文档标题菜单", { 文档根ID: rootID });
    menus.render("doc-title", detail.menu, { location: "doc-title", rootID, selectedDocumentCount: 1, detail });
  };

  const treeHandler = (event: CustomEvent<any>) => {
    const detail = event.detail;
    const analysis = analyzeDocTreeTarget(detail);
    if (!analysis.target) {
      // @compat The rejection reason is the only way to tell a multi-selection from an
      // unknown detail shape; log the raw shape instead of failing silently.
      logger?.debug("忽略文档树菜单事件", { 原因: translateTreeReason(analysis.reason), 事件信息: describeDocTreeDetail(detail) });
      return;
    }
    logger?.debug("打开文档树菜单", { 文档根ID: analysis.target.rootID });
    menus.render("doc-tree", detail.menu, { location: "doc-tree", rootID: analysis.target.rootID, selectedDocumentCount: 1, detail });
  };

  const imageHandler = (event: CustomEvent<any>) => {
    const detail = event.detail;
    const target = resolveImageMenuTarget(detail);
    if (!target || !detail?.menu) {
      logger?.debug("忽略图片菜单事件", { 存在图片目标: Boolean(target), 存在菜单: Boolean(detail?.menu) });
      return;
    }
    logger?.debug("打开图片菜单", { 图片资源: target.url, 图片块ID: target.blockID, 文档根ID: target.rootID });
    menus.render("image", detail.menu, {
      location: "image",
      rootID: target.rootID,
      imageElement: target.element,
      imageURL: target.url,
      blockID: target.blockID,
      detail,
    });
  };

  plugin.eventBus.on("click-editortitleicon", titleHandler);
  plugin.eventBus.on("open-menu-doctree", treeHandler);
  plugin.eventBus.on("open-menu-image", imageHandler);

  return () => {
    plugin.eventBus.off("click-editortitleicon", titleHandler);
    plugin.eventBus.off("open-menu-doctree", treeHandler);
    plugin.eventBus.off("open-menu-image", imageHandler);
  };
}

function translateTreeReason(reason?: string): string | undefined {
  if (!reason) return undefined;
  if (reason === "no-menu") return "缺少菜单";
  if (reason.startsWith("multi-selection:")) return `选中了多个项目：${reason.slice("multi-selection:".length)}`;
  if (reason.startsWith("not-a-document:")) return `目标不是文档：${reason.slice("not-a-document:".length)}`;
  if (reason.startsWith("not-a-document-node:")) return `目标节点不是文档：${reason.slice("not-a-document-node:".length)}`;
  if (reason === "no-target") return "没有目标项目";
  if (reason === "no-id") return "缺少文档ID";
  return reason;
}

/**
 * @safety Only a single, explicitly identified document file may receive write actions.
 * Multi-selection (`items`/`elements` length != 1), notebooks (`navigation-root`) and
 * unresolved nodes are rejected before any menu is rendered.
 */
export function analyzeDocTreeTarget(detail: any): { target?: SingleDocumentTarget; reason?: string } {
  if (!detail?.menu) return { reason: "no-menu" };

  const items = Array.isArray(detail.items) ? detail.items : undefined;
  const elements = detail.elements ? Array.from(detail.elements as ArrayLike<HTMLElement>) : undefined;

  // Any explicit multi-selection signal rejects the whole menu, not just extra entries.
  if (items && items.length !== 1) return { reason: `multi-selection:${items.length}` };
  if (elements && elements.length !== 1) return { reason: `multi-selection:${elements.length}` };
  if (!items && !elements) return { reason: "no-target" };

  // Newer builds expose an explicit target type; notebooks and mixed selections never pass.
  if (detail.type && detail.type !== "doc") return { reason: `not-a-document:${detail.type}` };

  const element = elements?.[0];
  const nodeType = element?.getAttribute?.("data-type");
  if (nodeType && nodeType !== "navigation-file") return { reason: `not-a-document-node:${nodeType}` };

  const idFromItem = items?.[0]?.id;
  const idFromElement = element?.getAttribute("data-node-id") ?? element?.dataset?.id;
  const rootID = idFromItem || idFromElement;
  if (typeof rootID !== "string" || !rootID) return { reason: "no-id" };
  return { target: { rootID } };
}

export function resolveSingleDocTreeItem(detail: any): SingleDocumentTarget | undefined {
  return analyzeDocTreeTarget(detail).target;
}

/** Compact, log-safe summary of an unknown host detail shape. */
export function describeDocTreeDetail(detail: any): Record<string, unknown> {
  const items = Array.isArray(detail?.items) ? detail.items : undefined;
  const elements = detail?.elements ? Array.from(detail.elements as ArrayLike<HTMLElement>) : undefined;
  return {
    keys: detail && typeof detail === "object" ? Object.keys(detail) : undefined,
    items: items?.length,
    elements: elements?.length,
    type: detail?.type,
    nodeType: elements?.[0]?.getAttribute?.("data-type"),
    hasMenu: Boolean(detail?.menu),
  };
}

/**
 * @compat Image menus differ between versions: `detail.element` may be the image itself or
 * a container. Only an `<img>` with a local source becomes a target.
 */
export function resolveImageMenuTarget(detail: any): ImageMenuTarget | undefined {
  const element = detail?.element as HTMLElement | undefined;
  if (!element) return undefined;
  const image = element.tagName?.toLowerCase() === "img"
    ? element as unknown as HTMLImageElement
    : element.querySelector?.("img") as HTMLImageElement | null;
  if (!image) return undefined;
  const url = image.getAttribute("data-src") || image.getAttribute("src") || "";
  if (!url) return undefined;
  return {
    element: image,
    url,
    blockID: image.closest("[data-node-id]")?.getAttribute("data-node-id") ?? undefined,
    rootID: detail?.protyle?.block?.rootID ?? detail?.editor?.protyle?.block?.rootID ?? undefined,
  };
}
