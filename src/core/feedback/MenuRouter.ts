import type { Plugin } from "siyuan";
import type { Logger } from "../host/Logger.ts";
import type { MenuRegistry } from "./MenuRegistry.ts";
import { resolveEditorRootID } from "../host/ProtyleAdapter.ts";

function isNotebookDocTreeItem(item: any): boolean {
  if (!item || typeof item !== "object") return false;
  return item.type === "notebook"
    || item.type === "navigation-root"
    || item.type === "navigation-closed"
    || item.kind === "notebook"
    || item.path === "/";
}

function isNotebookDocTreeElement(el: any): boolean {
  const nodeType = el?.getAttribute?.("data-type");
  return nodeType === "navigation-root" || nodeType === "navigation-closed" || nodeType === "notebook";
}

function resolveClosestBlockID(targetElement: HTMLElement | undefined, protyle: any): string | undefined {
  return targetElement?.closest?.("[data-node-id]")?.getAttribute?.("data-node-id") ?? protyle?.block?.id;
}

/**
 * Extract selected document IDs from SiYuan tree menu event details.
 * Supports single and multiple selection without filtering by business rules.
 */
export function extractDocTreeDocumentIDs(detail: any): string[] {
  if (!detail || detail.type === "notebook" || detail.type === "notebooks") return [];
  const ids: string[] = [];

  if (Array.isArray(detail.items)) {
    for (const item of detail.items) {
      if (item && typeof item.id === "string" && item.id && !isNotebookDocTreeItem(item)) {
        ids.push(item.id);
      }
    }
  } else if (detail.elements) {
    for (const el of Array.from(detail.elements as ArrayLike<HTMLElement>)) {
      if (isNotebookDocTreeElement(el)) continue;
      const id = el?.getAttribute?.("data-node-id");
      if (typeof id === "string" && id) {
        ids.push(id);
      }
    }
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
    logger?.debug("打开文档标题菜单", { 文档根ID: rootID });
    menus.render("doc-title", detail.menu, {
      location: "doc-title",
      rootID,
      protyle: detail.protyle,
      detail,
    });
  };

  const treeHandler = (event: CustomEvent<any>) => {
    const detail = event.detail;
    if (!detail?.menu) return;
    const selectedDocumentIDs = extractDocTreeDocumentIDs(detail);
    const selectedDocumentCount = selectedDocumentIDs.length;
    const rootID = detail.type !== "items" && selectedDocumentCount === 1 ? selectedDocumentIDs[0] : undefined;
    const rawElements = detail.elements ? Array.from(detail.elements as ArrayLike<HTMLElement>) : [];
    const targetElement = detail.type === "notebook" || detail.type === "notebooks"
      ? undefined
      : (rawElements.find(el => !isNotebookDocTreeElement(el)) ?? (detail.elements ? undefined : detail.element));

    logger?.debug("打开文档树菜单", { detailType: detail.type, selectedDocumentIDs, selectedDocumentCount, rootID });
    menus.render("doc-tree", detail.menu, {
      location: "doc-tree",
      rootID,
      selectedDocumentIDs,
      selectedDocumentCount,
      targetElement,
      protyle: detail.protyle,
      detail,
    });
  };

  const imageHandler = (event: CustomEvent<any>) => {
    const detail = event.detail;
    if (!detail?.menu) return;
    const targetElement = detail.element as HTMLElement | undefined;
    const rootID = resolveEditorRootID(detail);
    const protyle = detail.protyle;
    const blockID = resolveClosestBlockID(targetElement, protyle);

    const image = targetElement?.tagName?.toLowerCase() === "img"
      ? (targetElement as HTMLImageElement)
      : (targetElement?.querySelector?.("img") as HTMLImageElement | null);
    const imageURL = image?.getAttribute("data-src") || image?.getAttribute("src") || undefined;

    logger?.debug("打开图片菜单", { rootID, blockID, imageURL });
    menus.render("image", detail.menu, {
      location: "image",
      rootID,
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
    const blockID = resolveClosestBlockID(targetElement, protyle);

    logger?.debug("打开链接菜单", { rootID, blockID });
    menus.render("link", detail.menu, {
      location: "link",
      rootID,
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
    const protyle = detail.protyle;
    const targetElement = Array.isArray(detail.blockElements) ? detail.blockElements[0] : detail.element;
    const blockID = targetElement?.getAttribute?.("data-node-id") ?? protyle?.block?.id;

    logger?.debug("打开块图标菜单", { rootID, blockID });
    menus.render("blockicon", detail.menu, {
      location: "blockicon",
      rootID,
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
