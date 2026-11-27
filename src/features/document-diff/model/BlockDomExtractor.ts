import {
  findDescendants,
  findFirstDescendant,
  hasClass,
  isEmbedContainer,
  isInsideEmbed,
  normalizeInlineStyle,
  parseBlockDomRoot,
  parseHtmlFragmentFallback,
  stripZeroWidth,
  type DomElementLike,
  type DomNodeLike,
} from "./domParser.ts";
import {
  collectEditableRuns,
  extractCodeBlockLines,
  extractHtmlBlockContent,
  extractMediaBlockDescriptor,
  extractTableRows,
  normalizeQueryEmbedScript,
  serializeConservativeSubtree,
  VOLATILE_BLOCK_ATTRS,
} from "./inlineRuns.ts";
import type { SemanticUnit } from "./types.ts";

export { parseHtmlFragmentFallback, type DomElementLike, type DomNodeLike };

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

function isAtomicBlock(el: DomElementLike): boolean {
  const type = el.getAttribute("data-type") ?? "";
  if (!CONTAINER_BLOCK_TYPES.has(type)) return true;
  // Empty container without nested block children still acts as a leaf unit.
  const nestedBlock = findFirstDescendant(el, c => Boolean(c.getAttribute("data-node-id")));
  return !nestedBlock;
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
