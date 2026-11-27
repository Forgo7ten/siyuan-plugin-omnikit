import {
  ELEMENT_NODE,
  findDescendants,
  findFirstDescendant,
  hasClass,
  normalizeInlineStyle,
  stripZeroWidth,
  TEXT_NODE,
  type DomElementLike,
  type DomNodeLike,
} from "./domParser.ts";

export const VOLATILE_BLOCK_ATTRS = new Set([
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

const BLOCK_ID_TOKEN_RE = /\b\d{14}-[a-zA-Z0-9]{7}\b/g;
const SIYUAN_BLOCK_LINK_PREFIX = "siyuan://blocks/";

interface InlineRun {
  text: string;
  mark: string;
  isInlineMath?: boolean;
}

export function isDecoratedNonContentElement(el: DomElementLike): boolean {
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

export function extractBlockLinkTargetID(href: string): string | undefined {
  if (!href.startsWith(SIYUAN_BLOCK_LINK_PREFIX)) return undefined;
  const rest = href.slice(SIYUAN_BLOCK_LINK_PREFIX.length);
  const cut = rest.search(/[?#]/);
  const id = cut >= 0 ? rest.slice(0, cut) : rest;
  return /^\d{14}-[a-zA-Z0-9]{7}$/.test(id) ? id : undefined;
}

export function readImageAttributes(imgEl: DomElementLike | undefined, wrapperEl?: DomElementLike): string {
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

export function collectEditableRuns(
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

export function collectPlainTextWithoutLineNumbers(root: DomNodeLike): string {
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

export function extractCodeBlockLines(el: DomElementLike): string[] {
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

export function extractHtmlBlockContent(el: DomElementLike): string {
  const protyleHtml = findFirstDescendant(el, c => c.tagName.toUpperCase() === "PROTYLE-HTML");
  const content = protyleHtml?.getAttribute("data-content") ?? el.getAttribute("data-content") ?? "";
  return stripZeroWidth(content);
}

export function extractMediaBlockDescriptor(el: DomElementLike): { src: string; meta: string } {
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

export function normalizeQueryEmbedScript(
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

export function extractTableRows(
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

export function serializeConservativeSubtree(el: DomElementLike): string {
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
