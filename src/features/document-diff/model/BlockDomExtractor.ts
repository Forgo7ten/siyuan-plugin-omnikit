import type { SemanticUnit } from "./types.ts";

export interface DomNodeLike {
  readonly nodeType: number;
  readonly textContent: string | null;
  readonly childNodes: ArrayLike<DomNodeLike>;
  readonly parentElement: DomElementLike | null;
}

export interface DomElementLike extends DomNodeLike {
  readonly tagName: string;
  getAttribute(name: string): string | null;
  getAttributeNames(): string[];
  readonly children: ArrayLike<DomElementLike>;
}

const ELEMENT_NODE = 1;
const TEXT_NODE = 3;

export const CONTAINER_BLOCK_TYPES = new Set([
  "NodeDocument",
  "NodeList",
  "NodeListItem",
  "NodeBlockquote",
  "NodeCallout",
  "NodeSuperBlock",
  "NodeTabs",
  "NodeTabItem",
  "NodeMindmap",
  "NodeMindmapItem",
]);

const KNOWN_TEXT_LEAF_TYPES = new Set([
  "NodeParagraph",
  "NodeHeading",
]);

const MEDIA_OR_FRAME_BLOCK_TYPES = new Set([
  "NodeVideo",
  "NodeAudio",
  "NodeIFrame",
  "NodeWidget",
]);

const QUERY_EMBED_BLOCK_TYPES = new Set([
  "NodeBlockQueryEmbed",
  "NodeQueryEmbed",
]);

const VOLATILE_BLOCK_ATTRS = new Set([
  "id",
  "data-node-id",
  "data-node-index",
  "updated",
  "fold",
  "heading-fold",
  "parent-heading",
  "scroll",
  "class",
  "contenteditable",
  "spellcheck",
  "draggable",
  "data-render",
  "data-active",
  "data-tabs-editing",
  "data-av-id",
  "custom-riff-decks",
  "custom-avs",
  "av-names",
]);

const VOID_HTML_TAGS = new Set([
  "area", "base", "br", "col", "embed", "hr", "img", "input",
  "link", "meta", "param", "source", "track", "wbr",
]);

const ZERO_WIDTH_RE = /[\u200B\u2060\uFEFF]/g;
const BLOCK_ID_TOKEN_RE = /\b\d{14}-[a-zA-Z0-9]{7}\b/g;

function stripZeroWidth(value: string): string {
  return value.replace(/\r\n?/g, "\n").replace(ZERO_WIDTH_RE, "");
}

function decodeHtmlEntities(raw: string): string {
  if (!raw.includes("&")) return raw;
  return raw.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z0-9]+);/g, (full, entity: string) => {
    if (entity[0] === "#") {
      const isHex = entity[1] === "x" || entity[1] === "X";
      const code = Number.parseInt(entity.slice(isHex ? 2 : 1), isHex ? 16 : 10);
      if (Number.isInteger(code) && code >= 0 && code <= 0x10ffff) {
        try {
          return String.fromCodePoint(code);
        } catch {
          return full;
        }
      }
      return full;
    }
    switch (entity) {
      case "amp": return "&";
      case "lt": return "<";
      case "gt": return ">";
      case "quot": return '"';
      case "apos": return "'";
      case "nbsp": return "\u00A0";
      default: return full;
    }
  });
}

class LiteTextNode implements DomNodeLike {
  readonly nodeType = TEXT_NODE;
  readonly childNodes: readonly DomNodeLike[] = [];
  parentElement: LiteElementNode | null = null;
  constructor(readonly textContent: string) {}
}

class LiteElementNode implements DomElementLike {
  readonly nodeType = ELEMENT_NODE;
  readonly childList: Array<LiteElementNode | LiteTextNode> = [];
  parentElement: LiteElementNode | null = null;
  private readonly attrs = new Map<string, string>();

  constructor(readonly tagName: string, attrs?: ReadonlyMap<string, string>) {
    if (attrs) {
      for (const [k, v] of attrs) this.attrs.set(k, v);
    }
  }

  get childNodes(): ArrayLike<DomNodeLike> {
    return this.childList;
  }

  get children(): ArrayLike<DomElementLike> {
    return this.childList.filter((n): n is LiteElementNode => n.nodeType === ELEMENT_NODE);
  }

  get textContent(): string {
    return this.childList.map(c => c.textContent ?? "").join("");
  }

  getAttribute(name: string): string | null {
    return this.attrs.get(name.toLowerCase()) ?? null;
  }

  getAttributeNames(): string[] {
    return [...this.attrs.keys()];
  }

  append(child: LiteElementNode | LiteTextNode): void {
    child.parentElement = this;
    this.childList.push(child);
  }
}

/**
 * Fallback HTML fragment parser used only in non-DOM runtimes (such as Node unit tests).
 * In SiYuan's Chromium runtime, native `DOMParser` is always used first.
 */
export function parseHtmlFragmentFallback(html: string): DomElementLike {
  const root = new LiteElementNode("BODY");
  const stack: LiteElementNode[] = [root];
  const tagRegex = /<!--[\s\S]*?-->|<\/?([a-zA-Z0-9:-]+)((?:\s+[^\s=/>]+(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s"'=>]+))?)*)\s*\/?>/g;
  let lastIndex = 0;
  let match: RegExpExecArray | null;

  while ((match = tagRegex.exec(html)) !== null) {
    if (match.index > lastIndex) {
      const text = decodeHtmlEntities(html.slice(lastIndex, match.index));
      if (text) stack[stack.length - 1]!.append(new LiteTextNode(text));
    }
    lastIndex = tagRegex.lastIndex;
    const rawToken = match[0];
    if (rawToken.startsWith("<!--")) continue;

    const rawName = match[1]!;
    const upperName = rawName.toUpperCase();
    const lowerName = rawName.toLowerCase();
    if (rawToken.startsWith("</")) {
      for (let i = stack.length - 1; i >= 1; i--) {
        if (stack[i]!.tagName === upperName) {
          stack.length = i;
          break;
        }
      }
      continue;
    }

    const attrPart = match[2] ?? "";
    const attrs = new Map<string, string>();
    const attrRegex = /([^\s=/>]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=>]+)))?/g;
    let attrMatch: RegExpExecArray | null;
    while ((attrMatch = attrRegex.exec(attrPart)) !== null) {
      const attrName = attrMatch[1]!.toLowerCase();
      const rawVal = attrMatch[2] ?? attrMatch[3] ?? attrMatch[4] ?? "";
      attrs.set(attrName, decodeHtmlEntities(rawVal));
    }

    const el = new LiteElementNode(upperName, attrs);
    stack[stack.length - 1]!.append(el);
    const selfClosing = rawToken.endsWith("/>") || VOID_HTML_TAGS.has(lowerName);
    if (!selfClosing) {
      stack.push(el);
    }
  }
  if (lastIndex < html.length) {
    const trailing = decodeHtmlEntities(html.slice(lastIndex));
    if (trailing) stack[stack.length - 1]!.append(new LiteTextNode(trailing));
  }
  return root;
}

function parseBlockDomRoot(html: string): DomElementLike {
  if (typeof DOMParser !== "undefined") {
    const doc = new DOMParser().parseFromString(html, "text/html");
    return doc.body as unknown as DomElementLike;
  }
  return parseHtmlFragmentFallback(html);
}

function hasClass(el: DomElementLike, className: string): boolean {
  const cls = el.getAttribute("class");
  if (!cls) return false;
  return cls.split(/\s+/).includes(className);
}

function isEmbedContainer(el: DomElementLike): boolean {
  return hasClass(el, "protyle-wysiwyg__embed");
}

function isInsideEmbed(el: DomElementLike, boundary: DomElementLike): boolean {
  let cur = el.parentElement;
  while (cur && cur !== boundary) {
    if (isEmbedContainer(cur)) return true;
    cur = cur.parentElement;
  }
  return false;
}

function findDescendants(
  root: DomElementLike,
  predicate: (el: DomElementLike) => boolean,
  skipSubtree?: (el: DomElementLike) => boolean,
): DomElementLike[] {
  const results: DomElementLike[] = [];
  const walk = (parent: DomElementLike): void => {
    const children = parent.children;
    for (let i = 0; i < children.length; i++) {
      const child = children[i]!;
      if (skipSubtree?.(child)) continue;
      if (predicate(child)) results.push(child);
      walk(child);
    }
  };
  walk(root);
  return results;
}

function findFirstDescendant(
  root: DomElementLike,
  predicate: (el: DomElementLike) => boolean,
): DomElementLike | undefined {
  const children = root.children;
  for (let i = 0; i < children.length; i++) {
    const child = children[i]!;
    if (predicate(child)) return child;
    const nested = findFirstDescendant(child, predicate);
    if (nested) return nested;
  }
  return undefined;
}

function normalizeInlineStyle(rawStyle: string, ignoreProps?: ReadonlySet<string>): string {
  if (!rawStyle.trim()) return "";
  const entries: string[] = [];
  for (const part of rawStyle.split(";")) {
    const colonIdx = part.indexOf(":");
    if (colonIdx <= 0) continue;
    const prop = part.slice(0, colonIdx).trim().toLowerCase();
    const val = part.slice(colonIdx + 1).trim();
    if (!prop || !val || ignoreProps?.has(prop)) continue;
    entries.push(`${prop}:${val}`);
  }
  entries.sort();
  return entries.join(";");
}

const CODE_BLOCK_RUNTIME_STYLE_PROPS = new Set(["line-height", "display"]);

function customBlockAttributes(el: DomElementLike): string {
  const type = el.getAttribute("data-type") ?? "";
  const pairs: string[] = [];
  for (const name of el.getAttributeNames()) {
    const lower = name.toLowerCase();
    if (VOLATILE_BLOCK_ATTRS.has(lower) || lower.startsWith("custom-sy-av-s-text")) continue;
    if (lower === "style") {
      const normalizedStyle = normalizeInlineStyle(
        el.getAttribute(name) ?? "",
        type === "NodeCodeBlock" ? CODE_BLOCK_RUNTIME_STYLE_PROPS : undefined,
      );
      if (normalizedStyle) {
        pairs.push(`style=${normalizedStyle}`);
      }
      continue;
    }
    if (
      lower.startsWith("custom-") ||
      lower === "alias" ||
      lower === "memo" ||
      lower === "name" ||
      lower === "bookmark" ||
      lower === "data-sb-layout" ||
      lower === "data-av-type" ||
      lower === "data-info" ||
      lower === "data-marker"
    ) {
      pairs.push(`${lower}=${el.getAttribute(name) ?? ""}`);
    }
  }
  pairs.sort();
  return pairs.join(";");
}

function isDecoratedNonContentElement(el: DomElementLike): boolean {
  if (
    hasClass(el, "protyle-attr") ||
    hasClass(el, "protyle-action") ||
    hasClass(el, "protyle-attr--drag") ||
    hasClass(el, "protyle-linenumber__rows") ||
    hasClass(el, "protyle-icons") ||
    hasClass(el, "callout-info") ||
    hasClass(el, "tab-item-info")
  ) {
    return true;
  }
  if (el.getAttribute("contenteditable") === "false") {
    const dt = (el.getAttribute("data-type") ?? "").trim().split(/\s+/);
    if (!dt.includes("img") && !dt.includes("inline-math")) {
      return true;
    }
  }
  return false;
}

interface InlineRun {
  text: string;
  mark: string;
  isInlineMath?: boolean;
}

const SIYUAN_BLOCK_LINK_PREFIX = "siyuan://blocks/";

function extractBlockLinkTargetID(href: string): string | undefined {
  if (!href.startsWith(SIYUAN_BLOCK_LINK_PREFIX)) return undefined;
  const rest = href.slice(SIYUAN_BLOCK_LINK_PREFIX.length);
  const cut = rest.search(/[?#]/);
  const id = cut >= 0 ? rest.slice(0, cut) : rest;
  return /^\d{14}-[a-zA-Z0-9]{7}$/.test(id) ? id : undefined;
}

function readImageAttributes(imgEl: DomElementLike | undefined, wrapperEl?: DomElementLike): string {
  const src = imgEl?.getAttribute("data-src") ?? imgEl?.getAttribute("src") ?? "";
  const alt = imgEl?.getAttribute("alt") ?? "";
  // SiYuan `imageTitle.ts` moves `title` to `data-title` in live Protyle DOM.
  const title = imgEl?.getAttribute("data-title") ?? imgEl?.getAttribute("title") ?? "";
  const containerEl = wrapperEl
    ? (findFirstDescendant(wrapperEl, c => hasClass(c, "protyle-image-container")) ?? wrapperEl)
    : undefined;
  const widthStyle = normalizeInlineStyle(
    containerEl?.getAttribute("style") ??
      wrapperEl?.getAttribute("style") ??
      (imgEl?.getAttribute("width") ? `width:${imgEl.getAttribute("width")}` : ""),
  );
  return `img(${src}|${alt}|${title}|${widthStyle})`;
}

function collectEditableRuns(
  block: DomElementLike,
  maskRefsForSelfFingerprint: boolean,
  resolveRefTarget?: (refID: string) => { token: string; ambiguous: boolean },
  allowHeaderInfo = false,
): { text: string; lineMarks: string[]; targets: string[]; ambiguousRef: boolean } {
  const runs: InlineRun[] = [];
  const targets: string[] = [];
  let ambiguousRef = false;

  const walk = (node: DomNodeLike, activeMarks: readonly string[]): void => {
    if (node.nodeType === TEXT_NODE) {
      const val = stripZeroWidth(node.textContent ?? "");
      if (val.length > 0) {
        runs.push({ text: val, mark: activeMarks.join("+") });
      }
      return;
    }
    if (node.nodeType !== ELEMENT_NODE) return;
    const el = node as DomElementLike;
    if (el !== block && el.getAttribute("data-node-id")) return;
    if (!allowHeaderInfo && isDecoratedNonContentElement(el)) return;
    if (
      allowHeaderInfo &&
      (hasClass(el, "protyle-attr") ||
        hasClass(el, "protyle-action") ||
        hasClass(el, "protyle-attr--drag") ||
        hasClass(el, "protyle-icons"))
    ) {
      return;
    }

    const tag = el.tagName.toUpperCase();
    if (tag === "BR") {
      runs.push({ text: "\n", mark: activeMarks.join("+") });
      return;
    }
    if (tag === "IMG") {
      runs.push({ text: "", mark: [...activeMarks, readImageAttributes(el)].join("+") });
      return;
    }

    const dataType = (el.getAttribute("data-type") ?? "").trim();
    if (dataType) {
      const rawTypes = dataType.split(/\s+/).filter(Boolean);
      const types = rawTypes.filter(t => t !== "virtual-block-ref").sort();

      if (types.includes("inline-math")) {
        const formula = stripZeroWidth(el.getAttribute("data-content") ?? "");
        runs.push({
          text: "",
          mark: [...activeMarks, `inline-math(${formula})`].join("+"),
          isInlineMath: true,
        });
        return;
      }
      if (types.includes("img")) {
        const img = findFirstDescendant(el, c => c.tagName.toUpperCase() === "IMG");
        runs.push({
          text: "",
          mark: [...activeMarks, ...types, readImageAttributes(img, el)].join("+"),
        });
        return;
      }

      if (types.length === 0) {
        // Pure runtime `virtual-block-ref` wrapper: unwrap transparently as plain text.
        const children = el.childNodes;
        for (let i = 0; i < children.length; i++) {
          walk(children[i]!, activeMarks);
        }
        return;
      }

      const markExtras: string[] = [...types];
      if (types.includes("a")) {
        const href = el.getAttribute("data-href") ?? "";
        const aTitle = el.getAttribute("data-title") ?? "";
        const blockTarget = extractBlockLinkTargetID(href);
        if (blockTarget) {
          if (maskRefsForSelfFingerprint) {
            markExtras.push(`a(siyuan://blocks/#SELF|${aTitle})`);
          } else if (resolveRefTarget) {
            const resolved = resolveRefTarget(blockTarget);
            if (resolved.ambiguous) ambiguousRef = true;
            targets.push(`link:${resolved.token}`);
            markExtras.push(`a(${resolved.token}|${aTitle})`);
          } else {
            markExtras.push(`a(${href}|${aTitle})`);
          }
        } else {
          markExtras.push(`a(${href}|${aTitle})`);
        }
      }

      if (types.includes("block-ref")) {
        const refID = el.getAttribute("data-id") ?? "";
        const refSub = el.getAttribute("data-subtype") ?? "";
        if (maskRefsForSelfFingerprint) {
          markExtras.push(`block-ref(#SELF|${refSub})`);
        } else if (resolveRefTarget && refID) {
          const resolved = resolveRefTarget(refID);
          if (resolved.ambiguous) ambiguousRef = true;
          targets.push(`ref:${resolved.token}:${refSub}`);
          markExtras.push(`block-ref(${resolved.token}|${refSub})`);
        } else {
          markExtras.push(`block-ref(${refID}|${refSub})`);
        }
      }

      if (types.includes("inline-memo")) {
        markExtras.push(`memo(${el.getAttribute("data-inline-memo-content") ?? ""})`);
      }

      if (types.includes("file-annotation-ref")) {
        markExtras.push(`file-annotation-ref(${el.getAttribute("data-id") ?? ""})`);
      }

      const nextMarks = [...activeMarks, markExtras.join(":")];
      const children = el.childNodes;
      for (let i = 0; i < children.length; i++) {
        walk(children[i]!, nextMarks);
      }
      return;
    }

    const children = el.childNodes;
    for (let i = 0; i < children.length; i++) {
      walk(children[i]!, activeMarks);
    }
  };

  if (allowHeaderInfo) {
    const children = block.childNodes;
    for (let i = 0; i < children.length; i++) {
      walk(children[i]!, []);
    }
  } else {
    const editableRoots = findDescendants(
      block,
      el => el.getAttribute("contenteditable") === "true" && !isDecoratedNonContentElement(el),
      el => (el !== block && Boolean(el.getAttribute("data-node-id"))) || isDecoratedNonContentElement(el),
    );

    if (editableRoots.length > 0) {
      for (const rootEl of editableRoots) {
        const children = rootEl.childNodes;
        for (let i = 0; i < children.length; i++) {
          walk(children[i]!, []);
        }
      }
    } else {
      const children = block.childNodes;
      for (let i = 0; i < children.length; i++) {
        walk(children[i]!, []);
      }
    }
  }

  // `mathRender.ts:102` injects a synthetic trailing `\n` right after a block-ending `inline-math` span in live DOM.
  if (
    runs.length >= 2 &&
    runs[runs.length - 1]!.text === "\n" &&
    runs[runs.length - 1]!.mark === "" &&
    runs[runs.length - 2]!.isInlineMath
  ) {
    runs.pop();
  }

  // Partition text and inline marks per logical '\n'-delimited line.
  const lineTexts: string[] = [""];
  const lineMarkBuckets: string[][] = [[]];
  for (const run of runs) {
    if (run.text.length === 0) {
      if (run.mark) {
        const curOffset = lineTexts[lineTexts.length - 1]!.length;
        lineMarkBuckets[lineMarkBuckets.length - 1]!.push(`@${curOffset}:${run.mark}`);
      }
      continue;
    }
    const parts = run.text.split("\n");
    for (let idx = 0; idx < parts.length; idx++) {
      if (idx > 0) {
        lineTexts.push("");
        lineMarkBuckets.push([]);
      }
      const chunk = parts[idx]!;
      const curOffset = lineTexts[lineTexts.length - 1]!.length;
      lineTexts[lineTexts.length - 1] += chunk;
      if (run.mark && chunk.length > 0) {
        lineMarkBuckets[lineMarkBuckets.length - 1]!.push(`${curOffset}+${chunk.length}:${run.mark}`);
      }
    }
  }

  return {
    text: lineTexts.join("\n"),
    lineMarks: lineMarkBuckets.map(bucket => bucket.join(",")),
    targets,
    ambiguousRef,
  };
}

function containerDescriptor(el: DomElementLike): string {
  const type = el.getAttribute("data-type") ?? "";
  const subtype = el.getAttribute("data-subtype") ?? "";
  const taskDone =
    (type === "NodeListItem" || type === "NodeMindmapItem") && subtype === "t"
      ? (hasClass(el, "protyle-task--done") ? "done" : "todo")
      : "";
  const sbLayout = el.getAttribute("data-sb-layout") ?? "";

  let headerLabel = "";
  if (type === "NodeCallout") {
    const infoEl = findFirstDescendant(el, c => hasClass(c, "callout-info"));
    if (infoEl) {
      const parsedCallout = collectEditableRuns(infoEl, true, undefined, true);
      headerLabel = `${parsedCallout.text}|${parsedCallout.lineMarks.join("/")}`;
    }
  } else if (type === "NodeTabItem") {
    const tabTitleEl = findFirstDescendant(el, c => hasClass(c, "tab-item-title"));
    if (tabTitleEl) {
      const parsedTab = collectEditableRuns(tabTitleEl, true, undefined, true);
      headerLabel = `${parsedTab.text}|${parsedTab.lineMarks.join("/")}`;
    }
  }

  const attrs = customBlockAttributes(el);
  return `${type}:${subtype}:${taskDone}:${sbLayout}:${headerLabel}:${attrs}`;
}

function ancestorContext(el: DomElementLike, boundary: DomElementLike): string {
  const parts: string[] = [];
  let cur = el.parentElement;
  while (cur && cur !== boundary) {
    const nodeID = cur.getAttribute("data-node-id");
    const type = cur.getAttribute("data-type");
    if (nodeID && type && type !== "NodeDocument") {
      parts.push(containerDescriptor(cur));
    }
    cur = cur.parentElement;
  }
  parts.reverse();
  return parts.join(">");
}

function extractBlockHeaderFormat(el: DomElementLike): string {
  const type = el.getAttribute("data-type") ?? "Unknown";
  const subtype = el.getAttribute("data-subtype") ?? "";
  const codeLang = type === "NodeCodeBlock"
    ? (findFirstDescendant(el, c => hasClass(c, "protyle-action__language"))?.textContent?.trim() ?? "")
    : "";
  const mathFormula = type === "NodeMathBlock" ? stripZeroWidth(el.getAttribute("data-content") ?? "") : "";
  const attrs = customBlockAttributes(el);
  return `${subtype}|${codeLang}|${mathFormula}|${attrs}`;
}

function collectPlainTextWithoutLineNumbers(root: DomNodeLike): string {
  if (root.nodeType === TEXT_NODE) {
    return root.textContent ?? "";
  }
  if (root.nodeType !== ELEMENT_NODE) return "";
  const el = root as DomElementLike;
  if (hasClass(el, "protyle-linenumber__rows")) return "";
  if (el.tagName.toUpperCase() === "BR") return "\n";
  let out = "";
  const children = el.childNodes;
  for (let i = 0; i < children.length; i++) {
    out += collectPlainTextWithoutLineNumbers(children[i]!);
  }
  return out;
}

function extractCodeBlockLines(el: DomElementLike): string[] {
  const hljs = findFirstDescendant(el, c => hasClass(c, "hljs"));
  if (hasClass(el, "render-node") || !hljs) {
    // Render/diagram code blocks (`mermaid`, `echarts`, `mindmap`, `plantuml`, `graphviz`, `flowchart`, `abc`)
    // store their source code in `data-content` without a `.hljs` child.
    const renderSource = stripZeroWidth(el.getAttribute("data-content") ?? "");
    return renderSource.split("\n");
  }
  const editableCode = findFirstDescendant(hljs, c => c.getAttribute("contenteditable") === "true") ?? hljs;
  const raw = stripZeroWidth(collectPlainTextWithoutLineNumbers(editableCode));
  const normalized = raw.endsWith("\n") ? raw.slice(0, -1) : raw;
  return normalized.split("\n");
}

function extractHtmlBlockContent(el: DomElementLike): string {
  const protyleHtml = findFirstDescendant(el, c => c.tagName.toUpperCase() === "PROTYLE-HTML");
  const content = protyleHtml?.getAttribute("data-content") ?? el.getAttribute("data-content") ?? "";
  return stripZeroWidth(content);
}

function extractMediaBlockDescriptor(el: DomElementLike): { src: string; meta: string } {
  const mediaEl = findFirstDescendant(
    el,
    c => {
      const tag = c.tagName.toUpperCase();
      return tag === "VIDEO" || tag === "AUDIO" || tag === "IFRAME" || Boolean(c.getAttribute("data-src") || c.getAttribute("src"));
    },
  );
  const src = mediaEl?.getAttribute("data-src") ?? mediaEl?.getAttribute("src") ?? el.getAttribute("data-src") ?? el.getAttribute("src") ?? "";
  const poster = mediaEl?.getAttribute("poster") ?? "";
  const title = mediaEl?.getAttribute("data-title") ?? mediaEl?.getAttribute("title") ?? el.getAttribute("data-title") ?? "";
  const mediaStyle = normalizeInlineStyle(mediaEl?.getAttribute("style") ?? "");
  const wrapper = findFirstDescendant(el, c => hasClass(c, "iframe-content") && c !== mediaEl);
  const wrapperStyle = normalizeInlineStyle(wrapper?.getAttribute("style") ?? "");
  return {
    src,
    meta: `poster=${poster}|title=${title}|mstyle=${mediaStyle}|wstyle=${wrapperStyle}`,
  };
}

function normalizeQueryEmbedScript(
  rawScript: string,
  maskForSelf: boolean,
  knownInternalIDs: ReadonlySet<string>,
  rootID: string,
  resolveRefTarget?: (refID: string) => { token: string; ambiguous: boolean },
): { script: string; targets: string[]; ambiguous: boolean } {
  const targets: string[] = [];
  let ambiguous = false;
  const cleaned = stripZeroWidth(rawScript);
  const script = cleaned.replace(BLOCK_ID_TOKEN_RE, match => {
    if (maskForSelf) {
      return match === rootID || knownInternalIDs.has(match) ? "#SELF" : match;
    }
    if (!resolveRefTarget) return match;
    const resolved = resolveRefTarget(match);
    if (resolved.ambiguous) ambiguous = true;
    targets.push(`query:${resolved.token}`);
    return `{{${resolved.token}}}`;
  });
  return { script, targets, ambiguous };
}

function extractTableRows(
  tableBlock: DomElementLike,
  maskRefsForSelfFingerprint: boolean,
  resolveRefTarget?: (refID: string) => { token: string; ambiguous: boolean },
): Array<{ text: string; format: string; target: string; ambiguous: boolean }> {
  const rows = findDescendants(
    tableBlock,
    c => c.tagName.toUpperCase() === "TR" && c.getAttribute("data-sy-table-virtual-rows") === null,
  );
  return rows.map(tr => {
    const cells = findDescendants(
      tr,
      c => c.tagName.toUpperCase() === "TH" || c.tagName.toUpperCase() === "TD",
      c => c !== tr && c.tagName.toUpperCase() === "TR",
    );
    const cellTexts: string[] = [];
    const cellFormats: string[] = [];
    const rowTargets: string[] = [];
    let rowAmbiguous = false;

    for (const cell of cells) {
      const tag = cell.tagName.toUpperCase();
      const align = cell.getAttribute("align") ?? normalizeInlineStyle(cell.getAttribute("style") ?? "");
      const colspan = cell.getAttribute("colspan") ?? "1";
      const rowspan = cell.getAttribute("rowspan") ?? "1";
      const parsed = collectEditableRuns(cell, maskRefsForSelfFingerprint, resolveRefTarget);
      if (parsed.ambiguousRef) rowAmbiguous = true;
      cellTexts.push(parsed.text.replace(/\n/g, "⏎"));
      cellFormats.push(`${tag}:${align}:${colspan}x${rowspan}[${parsed.lineMarks.join("/")}]`);
      rowTargets.push(...parsed.targets);
    }

    return {
      text: cellTexts.join("\t"),
      format: cellFormats.join("||"),
      target: rowTargets.join("|"),
      ambiguous: rowAmbiguous,
    };
  });
}

function isAtomicBlock(el: DomElementLike): boolean {
  const type = el.getAttribute("data-type") ?? "";
  if (!CONTAINER_BLOCK_TYPES.has(type)) return true;
  // Empty container without nested block children still acts as a leaf unit.
  const nestedBlock = findFirstDescendant(el, c => Boolean(c.getAttribute("data-node-id")));
  return !nestedBlock;
}

function serializeConservativeSubtree(el: DomElementLike): string {
  const walk = (node: DomNodeLike): string => {
    if (node.nodeType === TEXT_NODE) {
      return stripZeroWidth(node.textContent ?? "");
    }
    if (node.nodeType !== ELEMENT_NODE) return "";
    const cur = node as DomElementLike;
    if (hasClass(cur, "protyle-attr") || hasClass(cur, "protyle-action") || hasClass(cur, "protyle-icons")) {
      return "";
    }
    const attrPairs: string[] = [];
    for (const name of cur.getAttributeNames()) {
      const lower = name.toLowerCase();
      if (VOLATILE_BLOCK_ATTRS.has(lower) || lower.startsWith("custom-sy-av-s-text")) continue;
      attrPairs.push(`${lower}=${cur.getAttribute(name) ?? ""}`);
    }
    attrPairs.sort();
    const childOut: string[] = [];
    const children = cur.childNodes;
    for (let i = 0; i < children.length; i++) {
      const part = walk(children[i]!);
      if (part) childOut.push(part);
    }
    return `<${cur.tagName.toLowerCase()} ${attrPairs.join(" ")}>${childOut.join("")}</${cur.tagName.toLowerCase()}>`;
  };
  return walk(el);
}

/**
 * Computes a same-document parity signature for a single atomic block inside `boundary`.
 * Used both when building kernel snapshots and when verifying live editor DOM in `VisibleParity`.
 */
export function computeBlockParitySignature(el: DomElementLike, boundary: DomElementLike): string {
  const type = el.getAttribute("data-type") ?? "Unknown";
  const context = ancestorContext(el, boundary);
  const baseFormat = extractBlockHeaderFormat(el);

  if (type === "NodeCodeBlock") {
    const codeLines = extractCodeBlockLines(el);
    return JSON.stringify([type, context, baseFormat, codeLines]);
  }
  if (type === "NodeTable") {
    const rows = extractTableRows(el, false);
    return JSON.stringify([type, context, baseFormat, rows]);
  }
  if (type === "NodeMathBlock" || type === "NodeThematicBreak" || type === "NodeCustomBlock") {
    return JSON.stringify([type, context, baseFormat, stripZeroWidth(el.getAttribute("data-content") ?? "")]);
  }
  if (type === "NodeHTMLBlock") {
    return JSON.stringify([type, context, baseFormat, extractHtmlBlockContent(el)]);
  }
  if (MEDIA_OR_FRAME_BLOCK_TYPES.has(type)) {
    const media = extractMediaBlockDescriptor(el);
    return JSON.stringify([type, context, baseFormat, media.src, media.meta]);
  }
  if (QUERY_EMBED_BLOCK_TYPES.has(type)) {
    return JSON.stringify([type, context, baseFormat, stripZeroWidth(el.getAttribute("data-content") ?? "")]);
  }
  if (type === "NodeAttributeView") {
    return JSON.stringify([type, context, baseFormat, el.getAttribute("data-av-id") ?? ""]);
  }
  if (!KNOWN_TEXT_LEAF_TYPES.has(type) && !CONTAINER_BLOCK_TYPES.has(type)) {
    return JSON.stringify([type, context, baseFormat, serializeConservativeSubtree(el)]);
  }

  const parsed = collectEditableRuns(el, false);
  return JSON.stringify([type, context, baseFormat, parsed.text, parsed.lineMarks]);
}

export interface ExtractBlockDomOptions {
  avSignatures?: ReadonlyMap<string, string>;
}

export interface ExtractedDocumentDom {
  units: SemanticUnit[];
  parityByBlockID: Map<string, string>;
  rootBlockIndexByBlockID: Map<string, number>;
  rootBlockIDs: string[];
}

const MAX_SAFE_DOM_CHARS = 1_000_000;

/**
 * Parses SiYuan BlockDOM into block-ID-neutral `SemanticUnit[]` with two-pass
 * internal reference fingerprint normalization, per-block parity signatures,
 * and 1-based top-level root block ordinal indices for virtualized scroll sync.
 */
export function extractBlockDomUnits(
  rootID: string,
  blockDomHtml: string,
  options?: ExtractBlockDomOptions,
): ExtractedDocumentDom {
  const parityByBlockID = new Map<string, string>();
  const rootBlockIndexByBlockID = new Map<string, number>();
  const rootBlockIDs: string[] = [];
  if (blockDomHtml.length > MAX_SAFE_DOM_CHARS) {
    return {
      units: [
        {
          kind: "OversizedDocument",
          context: "",
          text: "",
          format: "",
          target: "",
          line: 0,
          reliable: false,
          unresolvedReason: "Document exceeds synchronous DOM parse budget",
        },
      ],
      parityByBlockID,
      rootBlockIndexByBlockID,
      rootBlockIDs,
    };
  }

  if (!blockDomHtml.trim()) {
    return { units: [], parityByBlockID, rootBlockIndexByBlockID, rootBlockIDs };
  }

  const root = parseBlockDomRoot(blockDomHtml);
  const allBlocks = findDescendants(
    root,
    el => Boolean(el.getAttribute("data-node-id")) && !isInsideEmbed(el, root),
    el => isEmbedContainer(el),
  );

  if (allBlocks.length === 0) {
    return {
      units: [
        {
          kind: "UnparsedDocument",
          context: "",
          text: "",
          format: "",
          target: "",
          line: 0,
          reliable: false,
          unresolvedReason: "Unable to locate SiYuan block nodes in document DOM",
        },
      ],
      parityByBlockID,
      rootBlockIndexByBlockID,
      rootBlockIDs,
    };
  }

  // Record 1-based top-level root child block indices (aligned with SiYuan's `GetBlockIndex` / `GetDoc` index).
  let docContainer: DomElementLike = root;
  if (
    root.children.length === 1 &&
    root.children[0]!.getAttribute("data-node-id") === rootID
  ) {
    docContainer = root.children[0]!;
  }
  const rootIndexByTopElement = new Map<DomElementLike, number>();
  for (let i = 0; i < docContainer.children.length; i++) {
    const child = docContainer.children[i]!;
    const cid = child.getAttribute("data-node-id");
    if (cid && cid !== rootID) {
      rootBlockIDs.push(cid);
      const ordinal = rootBlockIDs.length;
      rootIndexByTopElement.set(child, ordinal);
      rootBlockIndexByBlockID.set(cid, ordinal);
    }
  }

  const knownInternalIDs = new Set<string>();
  for (const el of allBlocks) {
    const id = el.getAttribute("data-node-id");
    if (!id || id === rootID) continue;
    knownInternalIDs.add(id);
    if (!rootBlockIndexByBlockID.has(id)) {
      let cur: DomElementLike | null = el;
      let resolvedOrdinal: number | undefined;
      while (cur && cur !== docContainer && cur !== root) {
        const hit = rootIndexByTopElement.get(cur);
        if (hit !== undefined) {
          resolvedOrdinal = hit;
          break;
        }
        cur = cur.parentElement;
      }
      if (resolvedOrdinal === undefined) {
        rootBlockIDs.push(id);
        resolvedOrdinal = rootBlockIDs.length;
        rootIndexByTopElement.set(el, resolvedOrdinal);
      }
      rootBlockIndexByBlockID.set(id, resolvedOrdinal);
    }
  }

  // Pass 1: Build masked self-fingerprints for every block (including containers) so internal refs
  // rewritten by SiYuan's conflict duplication (`remapDuplicateDocTreeReferences`) can pair by content.
  const selfFingerprintByID = new Map<string, string>();
  const fingerprintFrequency = new Map<string, number>();

  for (const el of allBlocks) {
    const id = el.getAttribute("data-node-id");
    if (!id || id === rootID) continue;
    const type = el.getAttribute("data-type") ?? "Unknown";
    const context = ancestorContext(el, root);
    const header = extractBlockHeaderFormat(el);
    let bodyKey = "";
    if (type === "NodeCodeBlock") {
      bodyKey = extractCodeBlockLines(el).join("\n");
    } else if (type === "NodeTable") {
      bodyKey = JSON.stringify(extractTableRows(el, true));
    } else if (type === "NodeHTMLBlock") {
      bodyKey = extractHtmlBlockContent(el);
    } else if (MEDIA_OR_FRAME_BLOCK_TYPES.has(type)) {
      const m = extractMediaBlockDescriptor(el);
      bodyKey = `${m.src}||${m.meta}`;
    } else if (QUERY_EMBED_BLOCK_TYPES.has(type)) {
      bodyKey = normalizeQueryEmbedScript(
        el.getAttribute("data-content") ?? "",
        true,
        knownInternalIDs,
        rootID,
      ).script;
    } else if (type === "NodeAttributeView") {
      const avID = el.getAttribute("data-av-id") ?? "";
      bodyKey = options?.avSignatures?.get(avID) ?? avID;
    } else if (type === "NodeMathBlock" || type === "NodeThematicBreak" || type === "NodeCustomBlock") {
      bodyKey = stripZeroWidth(el.getAttribute("data-content") ?? "");
    } else if (CONTAINER_BLOCK_TYPES.has(type)) {
      const childRun = collectEditableRuns(el, true);
      const childCount = findDescendants(el, c => Boolean(c.getAttribute("data-node-id"))).length;
      bodyKey = `${containerDescriptor(el)}#${childCount}#${childRun.text}`;
    } else if (!KNOWN_TEXT_LEAF_TYPES.has(type)) {
      bodyKey = serializeConservativeSubtree(el);
    } else {
      const run = collectEditableRuns(el, true);
      bodyKey = `${run.text}||${run.lineMarks.join("/")}`;
    }
    const fp = JSON.stringify([type, context, header, bodyKey]);
    selfFingerprintByID.set(id, fp);
    fingerprintFrequency.set(fp, (fingerprintFrequency.get(fp) ?? 0) + 1);
  }

  const resolveRefTarget = (refID: string): { token: string; ambiguous: boolean } => {
    if (refID === rootID) {
      return { token: "internal:document-root", ambiguous: false };
    }
    const targetFp = selfFingerprintByID.get(refID);
    if (targetFp === undefined) {
      return { token: `external:${refID}`, ambiguous: false };
    }
    if ((fingerprintFrequency.get(targetFp) ?? 0) !== 1) {
      return { token: "internal:ambiguous", ambiguous: true };
    }
    return { token: `internal:${targetFp}`, ambiguous: false };
  };

  // Pass 2: Emit ordered leaf units and live-DOM parity signatures.
  const units: SemanticUnit[] = [];
  for (const el of allBlocks) {
    const id = el.getAttribute("data-node-id");
    const type = el.getAttribute("data-type") ?? "Unknown";
    if (!id || id === rootID || !isAtomicBlock(el)) continue;

    parityByBlockID.set(id, computeBlockParitySignature(el, root));
    const context = ancestorContext(el, root);
    const headerFormat = extractBlockHeaderFormat(el);

    if (type === "NodeCodeBlock") {
      const codeLines = extractCodeBlockLines(el);
      codeLines.forEach((lineText, lineIndex) => {
        units.push({
          blockID: id,
          kind: type,
          context,
          text: lineText,
          format: headerFormat,
          target: "",
          line: lineIndex,
          reliable: true,
        });
      });
      continue;
    }

    if (type === "NodeTable") {
      const rows = extractTableRows(el, false, resolveRefTarget);
      if (rows.length === 0) {
        units.push({
          blockID: id,
          kind: type,
          context,
          text: "",
          format: headerFormat,
          target: "",
          line: 0,
          reliable: true,
        });
      } else {
        rows.forEach((row, rowIndex) => {
          units.push({
            blockID: id,
            kind: "NodeTableRow",
            context: `${context}>Table`,
            text: row.text,
            format: `${headerFormat}|${row.format}`,
            target: row.target,
            line: rowIndex,
            tableRowIndex: rowIndex,
            reliable: !row.ambiguous,
            ...(row.ambiguous ? { unresolvedReason: "Ambiguous internal block reference in table" } : {}),
          });
        });
      }
      continue;
    }

    if (type === "NodeMathBlock" || type === "NodeThematicBreak" || type === "NodeCustomBlock") {
      units.push({
        blockID: id,
        kind: type,
        context,
        text: stripZeroWidth(el.getAttribute("data-content") ?? ""),
        format: headerFormat,
        target: "",
        line: 0,
        reliable: true,
      });
      continue;
    }

    if (type === "NodeHTMLBlock") {
      units.push({
        blockID: id,
        kind: type,
        context,
        text: extractHtmlBlockContent(el),
        format: headerFormat,
        target: "",
        line: 0,
        reliable: true,
      });
      continue;
    }

    if (MEDIA_OR_FRAME_BLOCK_TYPES.has(type)) {
      const media = extractMediaBlockDescriptor(el);
      units.push({
        blockID: id,
        kind: type,
        context,
        text: media.src,
        format: `${headerFormat}|${media.meta}`,
        target: "",
        line: 0,
        reliable: true,
      });
      continue;
    }

    if (QUERY_EMBED_BLOCK_TYPES.has(type)) {
      const normalized = normalizeQueryEmbedScript(
        el.getAttribute("data-content") ?? "",
        false,
        knownInternalIDs,
        rootID,
        resolveRefTarget,
      );
      units.push({
        blockID: id,
        kind: type,
        context,
        text: normalized.script,
        format: headerFormat,
        target: normalized.targets.join("|"),
        line: 0,
        reliable: !normalized.ambiguous,
        ...(normalized.ambiguous
          ? { unresolvedReason: "Query embed references multiple identical internal blocks" }
          : {}),
      });
      continue;
    }

    if (type === "NodeAttributeView") {
      const avID = el.getAttribute("data-av-id") ?? "";
      const avSig = options?.avSignatures?.get(avID);
      units.push({
        blockID: id,
        kind: type,
        context,
        text: avSig ?? avID,
        format: headerFormat,
        target: "",
        line: 0,
        reliable: avSig !== undefined,
        ...(avSig === undefined
          ? { unresolvedReason: "Attribute view content requires verification" }
          : {}),
      });
      continue;
    }

    if (!KNOWN_TEXT_LEAF_TYPES.has(type) && !CONTAINER_BLOCK_TYPES.has(type)) {
      units.push({
        blockID: id,
        kind: type,
        context,
        text: serializeConservativeSubtree(el),
        format: headerFormat,
        target: "",
        line: 0,
        reliable: false,
        unresolvedReason: "Complex or unrecognized block type requires manual verification",
      });
      continue;
    }

    const parsed = collectEditableRuns(el, false, resolveRefTarget);
    const lines = parsed.text.split("\n");
    const targetStr = parsed.targets.join("|");
    lines.forEach((lineText, lineIndex) => {
      const lineMark = parsed.lineMarks[lineIndex] ?? "";
      units.push({
        blockID: id,
        kind: type,
        context,
        text: lineText,
        format: `${headerFormat}||${lineMark}`,
        target: targetStr,
        line: lineIndex,
        reliable: !parsed.ambiguousRef,
        ...(parsed.ambiguousRef
          ? { unresolvedReason: "Internal block reference matches multiple identical blocks" }
          : {}),
      });
    });
  }

  return { units, parityByBlockID, rootBlockIndexByBlockID, rootBlockIDs };
}
