import { isInsideProtectedContainer } from "../../../core/host/dom.ts";
import { imageSourceAttribute, trySource } from "./source.ts";

export interface Ref {
  blockID: string;
  raw: string;
  key: string;
  kind: "image" | "link";
  attribute: string;
  element: Element;
}

export interface LinkCandidate {
  element: Element;
  attribute: "data-href" | "href";
}

export function findLinkCandidates(root: ParentNode): LinkCandidate[] {
  const candidates: LinkCandidate[] = [];
  for (const element of root.querySelectorAll("a[href], span[data-href]")) {
    if (isInsideProtectedContainer(element)) continue;
    if (element.tagName === "SPAN") {
      if (!element.getAttribute("data-type")?.split(/\s+/).includes("a")) continue;
      candidates.push({ element, attribute: "data-href" });
    } else if (element.tagName === "A") {
      candidates.push({ element, attribute: "href" });
    }
  }
  return candidates;
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
    if (isInsideProtectedContainer(element)) continue;
    let raw: string | undefined;
    let attribute: string;
    let kind: Ref["kind"];
    if (element.tagName === "IMG") {
      raw = imageSourceAttribute(element as HTMLImageElement);
      attribute = element.hasAttribute("data-src") ? "data-src" : "src";
      kind = "image";
    } else {
      if (element.tagName === "SPAN" && !element.getAttribute("data-type")?.split(/\s+/).includes("a")) continue;
      attribute = element.tagName === "A" ? "href" : "data-href";
      raw = element.getAttribute(attribute) || undefined;
      kind = "link";
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
