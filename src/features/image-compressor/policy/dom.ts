import { isInsideProtectedContainer } from "../../../core/host/dom.ts";
import { imageSourceAttribute, trySource, type ImageSource } from "./source.ts";

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

export function parseSingleLeafBlock(dom: string, blockID: string): Element | undefined {
  if (!dom.trim()) return undefined;
  const template = document.createElement("template");
  template.innerHTML = dom;
  const children = [...template.content.children];
  if (children.length !== 1) return undefined;
  const root = children[0];
  if (root.getAttribute("data-node-id") !== blockID) return undefined;
  return root.querySelector("[data-node-id]") ? undefined : root;
}

export function scanImageRefs(dom: string, origin: string): Array<{ blockID: string; source: ImageSource }> {
  if (!dom.trim()) return [];
  const t = document.createElement("template");
  t.innerHTML = dom; // Inert, disconnected; no live editor DOM is changed.
  const result: Array<{ blockID: string; source: ImageSource }> = [];
  for (const element of t.content.querySelectorAll("img")) {
    if (isInsideProtectedContainer(element)) continue;
    const raw = imageSourceAttribute(element);
    if (!raw) continue;
    const source = trySource(raw, origin);
    if (!source) continue;
    const blockID = element.closest("[data-node-id]")?.getAttribute("data-node-id");
    if (!blockID) continue;
    result.push({ blockID, source });
  }
  return result;
}
