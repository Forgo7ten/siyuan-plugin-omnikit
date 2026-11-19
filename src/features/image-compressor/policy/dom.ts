import { imageSourceAttribute, trySource } from "./source.ts";
export interface Ref {
  blockID: string; raw: string; key: string;
  kind: "image" | "link"; attribute: string; element: Element;
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
    if (element.closest("pre, code, script, style, [data-type='NodeCodeBlock'], [data-type='NodeBlockQueryEmbed'], .protyle-wysiwyg__embed")) continue;
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
