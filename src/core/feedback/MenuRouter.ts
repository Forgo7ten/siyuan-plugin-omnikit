import type { Plugin } from "siyuan";
import type { Logger } from "../host/Logger.ts";
import type { HostMenuContext, MenuRegistry } from "./MenuRegistry.ts";
import { resolveEditorRootID } from "../host/ProtyleAdapter.ts";

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
 * Extract selected document IDs from SiYuan tree menu event details.
 * Supports single and multiple selection without filtering by business rules.
 */
export function extractDocTreeDocumentIDs(detail: any): string[] {
  if (!detail) return [];
  const ids: string[] = [];

  if (Array.isArray(detail.items)) {
    for (const item of detail.items) {
      if (item && typeof item.id === "string") {
        const itemType = item.type;
        if (itemType === "notebook" || itemType === "navigation-root" || detail.type === "notebook") {
          continue;
        }
        ids.push(item.id);
      }
    }
  } else if (detail.elements) {
    const elements = Array.from(detail.elements as ArrayLike<HTMLElement>);
    for (const el of elements) {
      const nodeType = el?.getAttribute?.("data-type");
      if (nodeType && (nodeType === "navigation-root" || nodeType === "notebook")) {
        continue;
      }
      const id = el?.getAttribute?.("data-node-id") ?? (el as any)?.dataset?.id;
      if (typeof id === "string" && id) {
        ids.push(id);
      }
    }
  } else if (detail.data?.id && typeof detail.data.id === "string") {
    ids.push(detail.data.id);
  } else if (detail.id && typeof detail.id === "string") {
    ids.push(detail.id);
  }

  return ids;
}

/**
 * Universal host event to context bridge.
 * Converts SiYuan host events into standardized HostMenuContext instances
 * and delegates business matching to Feature-registered matchers and providers.
 */
export function installMenuRouter(plugin: Plugin, menus: MenuRegistry, logger?: Logger): () => void {
  const titleHandler = (event: CustomEvent<any>) => {
    const detail = event.detail;
    if (!detail?.menu) return;
    const rootID = resolveEditorRootID(detail);
    const selectedDocumentIDs = rootID ? [rootID] : [];
    logger?.debug("打开文档标题菜单", { 文档根ID: rootID });
    menus.render("doc-title", detail.menu, {
      location: "doc-title",
      rootID,
      selectedDocumentIDs,
      selectedDocumentCount: selectedDocumentIDs.length,
      protyle: detail.protyle,
      targetElement: detail.element,
      detail,
    });
  };

  const treeHandler = (event: CustomEvent<any>) => {
    const detail = event.detail;
    if (!detail?.menu) return;
    const selectedDocumentIDs = extractDocTreeDocumentIDs(detail);
    const selectedDocumentCount = selectedDocumentIDs.length;
    const rootID = selectedDocumentCount === 1 ? selectedDocumentIDs[0] : undefined;
    const targetElement = detail.elements?.[0] ?? detail.element;
    const protyle = detail.protyle;

    logger?.debug("打开文档树菜单", { selectedDocumentIDs, selectedDocumentCount, rootID });
    menus.render("doc-tree", detail.menu, {
      location: "doc-tree",
      rootID,
      selectedDocumentIDs,
      selectedDocumentCount,
      targetElement,
      protyle,
      detail,
    });
  };

  const imageHandler = (event: CustomEvent<any>) => {
    const detail = event.detail;
    if (!detail?.menu) return;
    const targetElement = detail.element as HTMLElement | undefined;
    const rootID = resolveEditorRootID(detail);
    const protyle = detail.protyle;
    const blockID = targetElement?.closest?.("[data-node-id]")?.getAttribute?.("data-node-id") ?? protyle?.block?.id;
    const selectedDocumentIDs = rootID ? [rootID] : [];

    const image = targetElement?.tagName?.toLowerCase() === "img"
      ? (targetElement as HTMLImageElement)
      : (targetElement?.querySelector?.("img") as HTMLImageElement | null);
    const imageURL = image?.getAttribute("data-src") || image?.getAttribute("src") || undefined;

    logger?.debug("打开图片菜单", { rootID, blockID, imageURL });
    menus.render("image", detail.menu, {
      location: "image",
      rootID,
      selectedDocumentIDs,
      selectedDocumentCount: selectedDocumentIDs.length,
      targetElement,
      protyle,
      blockID,
      imageElement: image ?? undefined,
      imageURL,
      detail,
    });
  };

  const linkHandler = (event: CustomEvent<any>) => {
    const detail = event.detail;
    if (!detail?.menu) return;
    const targetElement = detail.element as HTMLElement | undefined;
    const rootID = resolveEditorRootID(detail);
    const protyle = detail.protyle;
    const blockID = targetElement?.closest?.("[data-node-id]")?.getAttribute?.("data-node-id") ?? protyle?.block?.id;
    const selectedDocumentIDs = rootID ? [rootID] : [];

    logger?.debug("打开链接菜单", { rootID, blockID });
    menus.render("link", detail.menu, {
      location: "link",
      rootID,
      selectedDocumentIDs,
      selectedDocumentCount: selectedDocumentIDs.length,
      targetElement,
      protyle,
      blockID,
      detail,
    });
  };

  const blockIconHandler = (event: CustomEvent<any>) => {
    const detail = event.detail;
    if (!detail?.menu) return;
    const rootID = resolveEditorRootID(detail);
    const selectedDocumentIDs = rootID ? [rootID] : [];
    const protyle = detail.protyle;
    const targetElement = Array.isArray(detail.blockElements) ? detail.blockElements[0] : detail.element;
    const blockID = targetElement?.getAttribute?.("data-node-id") ?? protyle?.block?.id;

    logger?.debug("打开块图标菜单", { rootID, blockID });
    menus.render("blockicon", detail.menu, {
      location: "blockicon",
      rootID,
      selectedDocumentIDs,
      selectedDocumentCount: selectedDocumentIDs.length,
      targetElement,
      protyle,
      blockID,
      detail,
    });
  };

  plugin.eventBus.on("click-editortitleicon", titleHandler);
  plugin.eventBus.on("open-menu-doctree", treeHandler);
  plugin.eventBus.on("open-menu-image", imageHandler);
  plugin.eventBus.on("open-menu-link", linkHandler);
  plugin.eventBus.on("click-blockicon", blockIconHandler);

  return () => {
    plugin.eventBus.off("click-editortitleicon", titleHandler);
    plugin.eventBus.off("open-menu-doctree", treeHandler);
    plugin.eventBus.off("open-menu-image", imageHandler);
    plugin.eventBus.off("open-menu-link", linkHandler);
    plugin.eventBus.off("click-blockicon", blockIconHandler);
  };
}

/**
 * Backward compatibility helper for analyzing a doc tree target expecting a single document.
 */
export function analyzeDocTreeTarget(detail: any): { target?: SingleDocumentTarget; reason?: string } {
  if (!detail?.menu) return { reason: "no-menu" };

  const items = Array.isArray(detail.items) ? detail.items : undefined;
  const elements = detail.elements ? Array.from(detail.elements as ArrayLike<HTMLElement>) : undefined;

  if (items && items.length !== 1) return { reason: `multi-selection:${items.length}` };
  if (elements && elements.length !== 1) return { reason: `multi-selection:${elements.length}` };
  if (!items && !elements) return { reason: "no-target" };

  if (detail.type && detail.type !== "doc") return { reason: `not-a-document:${detail.type}` };

  const element = elements?.[0];
  const nodeType = element?.getAttribute?.("data-type");
  if (nodeType && nodeType !== "navigation-file") return { reason: `not-a-document-node:${nodeType}` };

  const ids = extractDocTreeDocumentIDs(detail);
  if (ids.length !== 1) return { reason: ids.length === 0 ? "no-id" : `multi-selection:${ids.length}` };
  return { target: { rootID: ids[0] } };
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

/** Backward compatibility helper for image menu target resolution. */
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
    rootID: resolveEditorRootID(detail),
  };
}
