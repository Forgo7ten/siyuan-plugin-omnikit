import { imageSourceAttribute, trySource } from "./source.ts";
export interface Ref {
  blockID: string; raw: string; key: string;
  kind: "image" | "link"; attribute: string; element: Element;
}
export interface Mapping {
  key: string; oldPath: string; newPath: string;
  selection?: { blockID: string; expectedCount: number; imageIndices: number[] };
}
export interface BlockPatch {
  id: string; rootID: string; notebook: string;
  before: string; after: string; changes: number;
  oldKeys: string[]; expectedOldCounts: Record<string, number>; expectedNewCounts: Record<string, number>;
}
function template(dom: string): HTMLTemplateElement {
  if (!dom.trim()) throw new Error("Empty block DOM");
  const t = document.createElement("template");
  t.innerHTML = dom; // Inert, disconnected; no live editor DOM is changed.
  return t;
}
function refsIn(root: ParentNode, origin: string): Ref[] {
  const result: Ref[] = [];
  for (const element of root.querySelectorAll("img, a[href], span[data-href]")) {
    if (element.closest("pre, code, script, style, [data-type='NodeCodeBlock'], [data-type='NodeBlockQueryEmbed']")) continue;
    let raw: string | undefined, attribute: string, kind: Ref["kind"];
    if (element.tagName === "IMG") {
      raw = imageSourceAttribute(element as HTMLImageElement);
      attribute = element.hasAttribute("data-src") ? "data-src" : "src"; kind = "image";
    } else {
      if (element.tagName === "SPAN" && !element.getAttribute("data-type")?.split(/\s+/).includes("a")) continue;
      attribute = element.tagName === "A" ? "href" : "data-href";
      raw = element.getAttribute(attribute) || undefined; kind = "link";
    }
    if (!raw) continue;
    const source = trySource(raw, origin);
    if (!source) continue;
    const blockID = element.closest("[data-node-id]")?.getAttribute("data-node-id");
    if (!blockID) throw new Error("Reference has no owning block");
    result.push({ blockID, raw, key: source.key, kind, attribute, element });
  }
  return result;
}
export function scanDOM(dom: string, origin: string): Omit<Ref, "element">[] {
  return refsIn(template(dom).content, origin).map(({ element: _e, ...ref }) => ref);
}
export function buildBlockPatch(
  dom: string, id: string, rootID: string, notebook: string,
  mappings: readonly Mapping[], origin: string,
): BlockPatch | undefined {
  const t = template(dom);
  const roots = [...t.content.querySelectorAll("[data-node-id]")].filter(e => e.getAttribute("data-node-id") === id);
  if (roots.length !== 1) throw new Error("Block DOM identity mismatch");
  const block = roots[0];
  // Do not submit a parent snapshot containing child blocks: update each owner separately.
  if (block.querySelector("[data-node-id]")) throw new Error("Container block mutation refused");
  const list = refsIn(t.content, origin).filter(r => r.blockID === id);
  const byKey = new Map(mappings.map(m => [m.key, m]));
  for (const mapping of mappings) {
    if (!mapping.selection) continue;
    const selected = mapping.selection;
    const images = list.filter(r => r.kind === "image" && r.key === mapping.key);
    if (selected.blockID !== id || images.length !== selected.expectedCount
        || new Set(selected.imageIndices).size !== selected.imageIndices.length
        || selected.imageIndices.some(i => !Number.isSafeInteger(i) || i < 0 || i >= images.length))
      throw new Error("Selected image occurrences changed");
  }
  let changes = 0;
  const oldKeys = new Set<string>();
  for (const ref of list) {
    const mapping = byKey.get(ref.key);
    if (!mapping) continue;
    if (mapping.selection) {
      const imageIndex = list.filter(r => r.kind === "image" && r.key === ref.key).indexOf(ref);
      if (ref.kind !== "image" || !mapping.selection.imageIndices.includes(imageIndex)) continue;
    }
    const target = trySource(mapping.newPath, origin);
    if (!target || target.kind !== "asset") throw new Error("Replacement must be a local asset");
    ref.element.setAttribute(ref.attribute, mapping.newPath);
    // Keep a separate thumbnail untouched; update src only when it denotes the SAME source.
    if (ref.kind === "image" && ref.attribute === "data-src") {
      const src = ref.element.getAttribute("src");
      if (src && trySource(src, origin)?.key === ref.key) ref.element.setAttribute("src", mapping.newPath);
    }
    changes++; oldKeys.add(ref.key);
  }
  if (!changes) return undefined;
  const after = t.innerHTML;
  const expectedNewCounts: Record<string, number> = {};
  for (const mapping of mappings) {
    const key = trySource(mapping.newPath, origin)?.key;
    if (key) expectedNewCounts[key] = scanDOM(after, origin).filter(r => r.blockID === id && r.key === key).length;
  }
  const expectedOldCounts: Record<string, number> = {};
  for (const key of oldKeys) expectedOldCounts[key] = scanDOM(after, origin).filter(r => r.blockID === id && r.key === key).length;
  return { id, rootID, notebook, before: dom, after, changes, oldKeys: [...oldKeys], expectedOldCounts, expectedNewCounts };
}
export function patchWasApplied(dom: string, patch: BlockPatch, origin: string): boolean {
  const refs = scanDOM(dom, origin).filter(r => r.blockID === patch.id);
  return patch.oldKeys.every(key => refs.filter(r => r.key === key).length === patch.expectedOldCounts[key])
    && Object.entries(patch.expectedNewCounts).every(([key, n]) => refs.filter(r => r.key === key).length === n);
}
