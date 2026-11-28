import type { LinkActionResult, LinkOccurrenceTarget, TitledLinkProtyle } from "../policy/types.ts";
import { isInsideProtectedContainer } from "../../../core/host/dom.ts";
import type { KernelClient } from "../../../core/host/KernelClient.ts";
import {
  resolveEditorRootID,
  resolveNotebookID,
  resolveProtyleRunner,
} from "../../../core/host/ProtyleAdapter.ts";

export type LinkWriterKernel = Pick<KernelClient, "post">;

export interface CommitLinkTitleOptions {
  replaceTitle: boolean;
  signal?: AbortSignal;
  kernel?: LinkWriterKernel;
  isComposing?: (protyle?: unknown) => boolean;
  imeTimeoutMs?: number;
  imePollMs?: number;
  isCurrent?: () => boolean;
}

/** One title update in a block-level write group. */
export interface GroupedLinkTitleUpdate {
  readonly target: LinkOccurrenceTarget;
  readonly title: string;
  readonly isCurrent?: () => boolean;
}

const TRANSIENT_COMPARISON_ATTRIBUTES = [
  "parent-heading",
  "updated",
  "data-node-index",
  "data-eof",
  "data-editing",
  "select-start",
  "select-end",
  "data-heading-number",
] as const;

const TRANSIENT_COMPARISON_CLASSES = [
  "protyle-wysiwyg--select",
  "protyle-wysiwyg--hl",
  "protyle-wysiwyg--select-mode",
  "protyle-wysiwyg--attr",
  "protyle-heading-number--active",
  "av__pulse",
] as const;

export function isUpdateCurrent(update: GroupedLinkTitleUpdate, options: CommitLinkTitleOptions): boolean {
  const check = update.isCurrent ?? options.isCurrent;
  return check ? check() : true;
}

export function mapUpdatesByCurrent(
  updates: readonly GroupedLinkTitleUpdate[],
  options: CommitLinkTitleOptions,
  activeValue: LinkActionResult,
): LinkActionResult[] {
  return updates.map(u => (isUpdateCurrent(u, options) ? activeValue : "superseded"));
}

export function linkElements(block: HTMLElement): HTMLElement[] {
  return [...block.querySelectorAll<HTMLElement>('span[data-type~="a"]')];
}

/** Capture one occurrence before asynchronous title fetching begins. */
export function captureLinkTarget(
  link: HTMLElement,
  protyle: any,
  blockHTMLCache?: Map<HTMLElement, string>,
): LinkOccurrenceTarget | null {
  if (isInsideProtectedContainer(link)) return null;
  const runner = resolveProtyleRunner(protyle) as TitledLinkProtyle | null;
  const block = link.closest<HTMLElement>("[data-node-id]");
  const blockID = block?.getAttribute("data-node-id") ?? "";
  const rootID = resolveEditorRootID(protyle);
  const notebook = resolveNotebookID(protyle);
  const href = link.getAttribute("data-href");
  if (
    !block ||
    !blockID ||
    typeof rootID !== "string" ||
    !rootID ||
    typeof notebook !== "string" ||
    !notebook ||
    typeof href !== "string" ||
    !href
  ) {
    return null;
  }
  const ordinal = linkElements(block).indexOf(link);
  if (ordinal < 0) return null;
  const text = link.textContent ?? "";
  let originalBlockHTML = blockHTMLCache?.get(block);
  if (originalBlockHTML === undefined) {
    originalBlockHTML = block.outerHTML;
    blockHTMLCache?.set(block, originalBlockHTML);
  }
  return {
    protyle: runner ?? undefined,
    notebook,
    rootID,
    blockID,
    ordinal,
    linkElement: link,
    blockElement: block,
    originalHref: href,
    originalText: text,
    originalTitle: link.getAttribute("data-title"),
    originalBlockHTML,
  };
}

export function parseBlockFromDOM(html: string, blockID: string): HTMLElement | null {
  if (typeof DOMParser === "undefined") return null;
  const parsed = new DOMParser().parseFromString(html, "text/html");
  const block = [...parsed.querySelectorAll<HTMLElement>("[data-node-id]")]
    .find(element => element.getAttribute("data-node-id") === blockID);
  if (!block || block.querySelector("[data-node-id]")) return null;
  return block;
}

/** Remove kernel render-only attributes (e.g. parent-heading) before persisting block DOM via updateBlock. */
export function stripRenderOnlyAttributes(root: HTMLElement): void {
  root.removeAttribute("parent-heading");
  for (const element of root.querySelectorAll<HTMLElement>("[parent-heading]")) {
    element.removeAttribute("parent-heading");
  }
}

function normalizeElementAttributes(el: HTMLElement): void {
  for (const attr of TRANSIENT_COMPARISON_ATTRIBUTES) {
    el.removeAttribute(attr);
  }

  if (el.getAttribute("class") !== null) {
    if (el.classList) {
      el.classList.remove(...TRANSIENT_COMPARISON_CLASSES);
      if (el.classList.length === 0) {
        el.removeAttribute("class");
      }
    } else {
      const remaining = (el.getAttribute("class") ?? "")
        .split(/\s+/)
        .filter(token => token.length > 0 && !(TRANSIENT_COMPARISON_CLASSES as readonly string[]).includes(token));
      if (remaining.length === 0) {
        el.removeAttribute("class");
      } else {
        el.setAttribute("class", remaining.join(" "));
      }
    }
  }

  if (el.getAttribute("style") !== null) {
    if (el.style?.removeProperty) {
      el.style.removeProperty("--b3-protyle-heading-number-width");
    } else {
      const cleaned = (el.getAttribute("style") ?? "")
        .replace(/(?:^|;)\s*--b3-protyle-heading-number-width\s*:[^;]*/g, "")
        .replace(/^;\s*/, "")
        .trim();
      if (cleaned) {
        el.setAttribute("style", cleaned);
      } else {
        el.removeAttribute("style");
      }
    }
    if ((el.getAttribute("style") ?? "").trim() === "") {
      el.removeAttribute("style");
    }
  }

  if (typeof el.getAttributeNames === "function") {
    const names = el.getAttributeNames();
    if (names.length > 1) {
      const sorted = [...names].sort();
      const entries = sorted.map(name => [name, el.getAttribute(name) ?? ""] as const);
      for (const name of names) {
        el.removeAttribute(name);
      }
      for (const [name, value] of entries) {
        el.setAttribute(name, value);
      }
    }
  }
}

/**
 * Produce a canonical HTML string from a cloned copy for baseline / post-write equivalence checks only.
 * Never mutates `root`; strips editor-only transient nodes, classes, styles, and volatile attributes.
 */
export function normalizeBlockForComparison(root: HTMLElement): string {
  if (typeof root.cloneNode !== "function") {
    return root.outerHTML;
  }
  const clone = root.cloneNode(true) as HTMLElement;
  for (const transientNode of clone.querySelectorAll("wbr, .protyle-heading-number")) {
    transientNode.remove();
  }
  const elements: HTMLElement[] = [clone, ...clone.querySelectorAll<HTMLElement>("*")];
  for (const element of elements) {
    normalizeElementAttributes(element);
  }
  return clone.outerHTML;
}
