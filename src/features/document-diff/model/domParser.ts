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

export const ELEMENT_NODE = 1;
export const TEXT_NODE = 3;

const VOID_HTML_TAGS = new Set([
  "area", "base", "br", "col", "embed", "hr", "img", "input",
  "link", "meta", "param", "source", "track", "wbr",
]);

const ZERO_WIDTH_RE = /[\u200B\u2060\uFEFF]/g;

export function stripZeroWidth(value: string): string {
  return value.replace(/\r\n?/g, "\n").replace(ZERO_WIDTH_RE, "");
}

export function decodeHtmlEntities(raw: string): string {
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

export function parseBlockDomRoot(html: string): DomElementLike {
  if (typeof DOMParser !== "undefined") {
    const doc = new DOMParser().parseFromString(html, "text/html");
    return doc.body as unknown as DomElementLike;
  }
  return parseHtmlFragmentFallback(html);
}

export function hasClass(el: DomElementLike, className: string): boolean {
  const cls = el.getAttribute("class");
  if (!cls) return false;
  return cls.split(/\s+/).includes(className);
}

export function isEmbedContainer(el: DomElementLike): boolean {
  return hasClass(el, "protyle-wysiwyg__embed");
}

export function isInsideEmbed(el: DomElementLike, boundary: DomElementLike): boolean {
  let cur = el.parentElement;
  while (cur && cur !== boundary) {
    if (isEmbedContainer(cur)) return true;
    cur = cur.parentElement;
  }
  return false;
}

export function findDescendants(
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

export function findFirstDescendant(
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

export function normalizeInlineStyle(rawStyle: string, ignoreProps?: ReadonlySet<string>): string {
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
