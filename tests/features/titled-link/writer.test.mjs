import { test } from "node:test";
import assert from "node:assert/strict";
import { withBlockWriteLease } from "../../../src/core/host/BlockWriteLease.ts";
import { PROTECTED_CONTAINER_SELECTOR } from "../../../src/core/host/dom.ts";
import { resolveProtyleRunner } from "../../../src/core/host/ProtyleAdapter.ts";
import {
  captureLinkTarget,
  commitLinkTitle,
  commitLinkTitles,
  normalizeBlockForComparison,
} from "../../../src/features/titled-link/services/safe-writer.ts";

function matchesSimpleSelector(el, selector) {
  return selector.split(",").map(s => s.trim()).some(part => {
    if (!part) return false;
    if (part.startsWith(".")) {
      const classes = (el.getAttribute?.("class") ?? "").split(/\s+/).filter(Boolean);
      return classes.includes(part.slice(1));
    }
    const exactAttr = part.match(/^\[([a-zA-Z0-9_-]+)="([^"]*)"\]$/);
    if (exactAttr) return el.getAttribute?.(exactAttr[1]) === exactAttr[2];
    const bareAttr = part.match(/^\[([a-zA-Z0-9_-]+)\]$/);
    if (bareAttr) return el.getAttribute?.(bareAttr[1]) !== null;
    return false;
  });
}

class LinkElement {
  constructor(href, text, title = null) {
    this.attributes = new Map([["data-type", "a"], ["data-href", href]]);
    if (title !== null) this.attributes.set("data-title", title);
    this.textContent = text;
    this.isConnected = true;
    this.block = undefined;
  }
  getAttribute(name) { return this.attributes.get(name) ?? null; }
  setAttribute(name, value) { this.attributes.set(name, String(value)); }
  removeAttribute(name) { this.attributes.delete(name); }
  getAttributeNames() { return [...this.attributes.keys()]; }
  cloneNode() {
    const copy = new LinkElement(this.getAttribute("data-href") ?? "", this.textContent, this.getAttribute("data-title"));
    copy.attributes = new Map(this.attributes);
    return copy;
  }
  closest(selector) {
    if (matchesSimpleSelector(this, selector)) return this;
    if (this.block && matchesSimpleSelector(this.block, selector)) return this.block;
    return null;
  }
  get outerHTML() {
    const attrs = [...this.attributes.entries()].map(([k, v]) => ` ${k}="${v}"`).join("");
    return `<span${attrs}>${this.textContent}</span>`;
  }
}

class BlockElement {
  constructor(id, links, prefix = "", attributes = new Map(), transientCount = 0) {
    this.id = id;
    this.links = links;
    this.prefix = prefix;
    this.attributes = new Map([["data-node-id", id], ...attributes]);
    this.transientCount = transientCount;
    this.isConnected = true;
    for (const link of links) link.block = this;
  }
  get classList() {
    const self = this;
    const readTokens = () => (self.attributes.get("class") ?? "").split(/\s+/).filter(Boolean);
    return {
      remove(...names) {
        const next = readTokens().filter(t => !names.includes(t));
        self.attributes.set("class", next.join(" "));
      },
      get length() {
        return readTokens().length;
      },
    };
  }
  get style() {
    const self = this;
    return {
      removeProperty(prop) {
        if (!self.attributes.has("style")) return;
        const escaped = prop.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        const next = (self.attributes.get("style") ?? "")
          .replace(new RegExp(`(?:^|;)\\s*${escaped}\\s*:[^;]*`, "g"), "")
          .replace(/^;\s*/, "")
          .trim();
        self.attributes.set("style", next);
      },
    };
  }
  getAttribute(name) {
    if (name === "data-node-id") return this.attributes.get("data-node-id") ?? this.id ?? null;
    return this.attributes.get(name) ?? null;
  }
  setAttribute(name, value) {
    if (name === "data-node-id") this.id = String(value);
    this.attributes.set(name, String(value));
  }
  removeAttribute(name) {
    this.attributes.delete(name);
  }
  getAttributeNames() {
    return [...this.attributes.keys()];
  }
  cloneNode() {
    const clonedLinks = this.links.map(l => (typeof l.cloneNode === "function" ? l.cloneNode(true) : l));
    const attrCopy = new Map(this.attributes);
    attrCopy.delete("data-node-id");
    const copy = new BlockElement(this.id, clonedLinks, this.prefix, attrCopy, this.transientCount);
    copy.attributes = new Map(this.attributes);
    return copy;
  }
  closest(selector) {
    return matchesSimpleSelector(this, selector) ? this : null;
  }
  querySelectorAll(selector) {
    if (selector === 'span[data-type~="a"]' || selector === "*") return this.links;
    if (selector === "wbr, .protyle-heading-number") {
      return Array.from({ length: this.transientCount }, () => ({
        remove: () => { this.transientCount = Math.max(0, this.transientCount - 1); },
      }));
    }
    if (selector === "[parent-heading]") return this.links.filter(l => l.getAttribute("parent-heading") !== null);
    if (selector === "[updated]") return this.links.filter(l => l.getAttribute("updated") !== null);
    if (selector === "[data-node-id]") return [];
    return [];
  }
  querySelector(selector) { return this.querySelectorAll(selector)[0] ?? null; }
  get outerHTML() {
    const attrs = [...this.attributes.entries()].map(([k, v]) => ` ${k}="${v}"`).join("");
    const transient = "<wbr>".repeat(this.transientCount);
    return `<div${attrs}>${this.prefix}${this.links.map(link => link.outerHTML).join("")}${transient}</div>`;
  }
}

function parseBlock(html) {
  const tagMatch = html.match(/<div\b([^>]*)>/);
  const attrs = tagMatch?.[1] ?? "";
  const attrMap = new Map();
  for (const [, name, value] of attrs.matchAll(/([a-zA-Z0-9_-]+)="([^"]*)"/g)) {
    attrMap.set(name, value);
  }
  const id = attrMap.get("data-node-id");
  attrMap.delete("data-node-id");
  let inner = html.match(/<div\b[^>]*>([\s\S]*?)<\/div>/)?.[1] ?? "";
  let transientCount = 0;
  inner = inner.replace(/<wbr\s*\/?>/gi, () => { transientCount += 1; return ""; });
  inner = inner.replace(/<span\b[^>]*class="[^"]*\bprotyle-heading-number\b[^"]*"[^>]*>[\s\S]*?<\/span>/gi, () => {
    transientCount += 1;
    return "";
  });
  const firstSpan = inner.indexOf("<span");
  const prefix = firstSpan >= 0 ? inner.slice(0, firstSpan) : inner;
  const links = [...inner.matchAll(/<span\b([^>]*)>([\s\S]*?)<\/span>/g)].map(match => {
    const spanAttrs = new Map();
    for (const [, k, v] of match[1].matchAll(/([a-zA-Z0-9_-]+)="([^"]*)"/g)) {
      spanAttrs.set(k, v);
    }
    const link = new LinkElement(spanAttrs.get("data-href") ?? "", match[2], spanAttrs.get("data-title") ?? null);
    link.attributes = spanAttrs;
    return link;
  });
  return new BlockElement(id, links, prefix, attrMap, transientCount);
}

function installDOMParser(run) {
  const previous = globalThis.DOMParser;
  globalThis.DOMParser = class {
    parseFromString(html) {
      const block = parseBlock(html);
      return { querySelectorAll: selector => selector === "[data-node-id]" ? [block] : [] };
    }
  };
  return Promise.resolve().then(run).finally(() => { globalThis.DOMParser = previous; });
}

function fixture(count = 1) {
  const links = Array.from({ length: count }, (_, index) => new LinkElement(`https://example.com/${index}`, `https://example.com/${index}`));
  const block = new BlockElement("20260101000000-abcdefg", links);
  const transactions = [];
  const protyle = {
    block: { rootID: "20260101000000-rootabc", box: "notebook" },
    notebookId: "notebook",
    updateTransactionElement(element, oldHTML) { transactions.push({ element, oldHTML, newHTML: element.outerHTML }); },
  };
  return { links, block, protyle, transactions };
}

function kernelFor(block, overrides = {}) {
  const calls = [];
  return {
    calls,
    async post(path) {
      calls.push(path);
      if (path === "/api/block/getBlockInfo") {
        return { data: { rootID: overrides.rootID ?? "20260101000000-rootabc", box: overrides.box ?? "notebook" } };
      }
      return { data: { id: overrides.id ?? block.id, dom: overrides.dom ?? block.outerHTML } };
    },
  };
}

test("captures an occurrence and commits through the native undo transaction", async () => installDOMParser(async () => {
  const { links, block, protyle, transactions } = fixture();
  const target = captureLinkTarget(links[0], protyle);
  assert.ok(target);
  assert.equal(target.ordinal, 0);
  const original = block.outerHTML;
  const kernel = kernelFor(block);

  assert.equal(await commitLinkTitle(target, "Example", { replaceTitle: true, kernel }), "updated");
  assert.equal(links[0].textContent, "Example");
  assert.equal(links[0].getAttribute("data-title"), "Example");
  assert.deepEqual(kernel.calls, []);
  assert.equal(transactions.length, 1);
  assert.equal(transactions[0].oldHTML, original);
  assert.match(transactions[0].newHTML, />Example<\/span>/);
}));

test("user typing in active editor does not conflict and preserves typing in native transaction", async () => installDOMParser(async () => {
  const { links, block, protyle, transactions } = fixture();
  const target = captureLinkTarget(links[0], protyle);
  const kernel = kernelFor(block);
  block.prefix = "user typing ";

  assert.equal(await commitLinkTitle(target, "Example", { replaceTitle: false, kernel }), "updated");
  assert.equal(links[0].textContent, "Example");
  assert.equal(kernel.calls.length, 0);
  assert.equal(transactions.length, 1);
  assert.match(transactions[0].oldHTML, /user typing /);
  assert.match(transactions[0].newHTML, /user typing /);
  assert.match(transactions[0].newHTML, />Example<\/span>/);
}));

test("rejects live occurrence edits when link text was modified concurrently", async () => installDOMParser(async () => {
  const { links, block, protyle, transactions } = fixture();
  const target = captureLinkTarget(links[0], protyle);
  const kernel = kernelFor(block);
  links[0].textContent = "user edited link";

  assert.equal(await commitLinkTitle(target, "Example", { replaceTitle: false, kernel }), "conflict");
  assert.equal(links[0].textContent, "user edited link");
  assert.equal(transactions.length, 0);
}));

test("rejects live occurrence edits when link was removed from block", async () => installDOMParser(async () => {
  const { links, block, protyle, transactions } = fixture();
  const target = captureLinkTarget(links[0], protyle);
  links[0].isConnected = false;

  assert.equal(await commitLinkTitle(target, "Example", { replaceTitle: false }), "conflict");
  assert.equal(transactions.length, 0);
}));

test("non-active background mode updates block via updateBlock and trusts code: 0", async () => installDOMParser(async () => {
  const { links, block, protyle } = fixture();
  const target = {
    ...captureLinkTarget(links[0], protyle),
    protyle: null,
  };
  const updateCalls = [];
  const kernel = {
    calls: [],
    async post(path, body) {
      this.calls.push(path);
      if (path === "/api/block/getBlockInfo") {
        return { data: { rootID: "20260101000000-rootabc", box: "notebook" }, code: 0 };
      }
      if (path === "/api/block/getBlockDOM") {
        return { data: { id: block.id, dom: block.outerHTML }, code: 0 };
      }
      if (path === "/api/block/updateBlock") {
        updateCalls.push(body);
        return { code: 0, data: null };
      }
      return { data: {}, code: 0 };
    },
  };

  assert.equal(await commitLinkTitle(target, "Example", { replaceTitle: true, kernel }), "updated");
  assert.deepEqual(kernel.calls, ["/api/block/getBlockInfo", "/api/block/getBlockDOM", "/api/block/updateBlock"]);
  assert.equal(updateCalls.length, 1);
  assert.equal(updateCalls[0].id, block.id);
  assert.equal(updateCalls[0].dataType, "dom");
  assert.equal(updateCalls[0].lockType, true);
  assert.match(updateCalls[0].data, />Example<\/span>/);
}));

test("non-active background mode rejects when persisted occurrence changed", async () => installDOMParser(async () => {
  const { links, block, protyle } = fixture();
  const target = {
    ...captureLinkTarget(links[0], protyle),
    protyle: null,
  };
  const stale = `<div data-node-id="${block.id}"><span data-type="a" data-href="https://changed.example/">changed</span></div>`;

  assert.equal(await commitLinkTitle(target, "Example", {
    replaceTitle: false,
    kernel: kernelFor(block, { dom: stale }),
  }), "conflict");
}));

test("allows sequential plugin-owned writes in one block while retaining per-occurrence checks", async () => installDOMParser(async () => {
  const { links, block, protyle, transactions } = fixture(2);
  const first = captureLinkTarget(links[0], protyle);
  const second = captureLinkTarget(links[1], protyle);
  assert.equal(await commitLinkTitle(first, "First", { replaceTitle: false }), "updated");
  assert.equal(await commitLinkTitle(second, "Second", { replaceTitle: false }), "updated");
  assert.equal(transactions.length, 2);
  assert.equal(links[0].textContent, "First");
  assert.equal(links[1].textContent, "Second");
}));

test("commits same-block title updates with one native transaction in active editor", async () => installDOMParser(async () => {
  const { links, block, protyle, transactions } = fixture(2);
  const first = captureLinkTarget(links[0], protyle);
  const second = captureLinkTarget(links[1], protyle);
  const kernel = kernelFor(block);
  const original = block.outerHTML;

  assert.deepEqual(await commitLinkTitles([
    { target: first, title: "First" },
    { target: second, title: "Second" },
  ], { replaceTitle: false, kernel }), ["updated", "updated"]);
  assert.deepEqual(kernel.calls, []);
  assert.equal(transactions.length, 1);
  assert.equal(transactions[0].oldHTML, original);
  assert.equal(links[0].textContent, "First");
  assert.equal(links[1].textContent, "Second");
}));

test("abandons the whole group when an occurrence conflicts in active editor", async () => installDOMParser(async () => {
  const { links, block, protyle, transactions } = fixture(2);
  const first = captureLinkTarget(links[0], protyle);
  const second = captureLinkTarget(links[1], protyle);
  links[1].textContent = "user edited text";

  assert.deepEqual(await commitLinkTitles([
    { target: first, title: "First" },
    { target: second, title: "Second" },
  ], { replaceTitle: false }), ["conflict", "conflict"]);
  assert.equal(transactions.length, 0);
  assert.equal(links[0].textContent, "https://example.com/0");
  assert.equal(links[1].textContent, "user edited text");
}));

test("commits same-block title updates with one updateBlock in non-active mode", async () => installDOMParser(async () => {
  const { links, block, protyle } = fixture(2);
  const first = { ...captureLinkTarget(links[0], protyle), protyle: null };
  const second = { ...captureLinkTarget(links[1], protyle), protyle: null };
  const updateCalls = [];
  const kernel = {
    calls: [],
    async post(path, body) {
      this.calls.push(path);
      if (path === "/api/block/getBlockInfo") {
        return { data: { rootID: "20260101000000-rootabc", box: "notebook" }, code: 0 };
      }
      if (path === "/api/block/getBlockDOM") {
        return { data: { id: block.id, dom: block.outerHTML }, code: 0 };
      }
      if (path === "/api/block/updateBlock") {
        updateCalls.push(body);
        return { code: 0, data: null };
      }
      return { data: {}, code: 0 };
    },
  };

  assert.deepEqual(await commitLinkTitles([
    { target: first, title: "First" },
    { target: second, title: "Second" },
  ], { replaceTitle: false, kernel }), ["updated", "updated"]);
  assert.deepEqual(kernel.calls, ["/api/block/getBlockInfo", "/api/block/getBlockDOM", "/api/block/updateBlock"]);
  assert.equal(updateCalls.length, 1);
  assert.match(updateCalls[0].data, />First<\/span>/);
  assert.match(updateCalls[0].data, />Second<\/span>/);
}));

test("abandons the whole group when a persisted occurrence conflicts in non-active mode", async () => installDOMParser(async () => {
  const { links, block, protyle } = fixture(2);
  const first = { ...captureLinkTarget(links[0], protyle), protyle: null };
  const second = { ...captureLinkTarget(links[1], protyle), protyle: null };
  const stale = `<div data-node-id="${block.id}"><span data-type="a" data-href="${links[0].getAttribute("data-href")}">${links[0].textContent}</span><span data-type="a" data-href="https://changed.example/">changed</span></div>`;

  assert.deepEqual(await commitLinkTitles([
    { target: first, title: "First" },
    { target: second, title: "Second" },
  ], { replaceTitle: false, kernel: kernelFor(block, { dom: stale }) }), ["conflict", "conflict"]);
}));

test("waits for IME composition and returns ime-timeout on timeout or aborted on signal", async () => installDOMParser(async () => {
  const first = fixture();
  const target = captureLinkTarget(first.links[0], first.protyle);
  assert.equal(await commitLinkTitle(target, "Example", {
    replaceTitle: false,
    isComposing: () => true,
    imeTimeoutMs: 5,
    imePollMs: 1,
  }), "ime-timeout");
  assert.equal(first.transactions.length, 0);

  const second = fixture();
  const abortedTarget = captureLinkTarget(second.links[0], second.protyle);
  const controller = new AbortController();
  controller.abort();
  assert.equal(await commitLinkTitle(abortedTarget, "Example", {
    replaceTitle: false,
    signal: controller.signal,
  }), "aborted");
  assert.equal(second.transactions.length, 0);
}));

test("abandons grouped commit when any target in the batch has a mismatched baseline snapshot", async () => installDOMParser(async () => {
  const { links, block, protyle } = fixture(2);
  const first = captureLinkTarget(links[0], protyle);
  const second = captureLinkTarget(links[1], protyle);
  // Simulate second target having a different originalBlockHTML baseline
  const alteredSecond = { ...second, originalBlockHTML: `${second.originalBlockHTML} ` };

  const results = await commitLinkTitles([
    { target: first, title: "First" },
    { target: alteredSecond, title: "Second" },
  ], { replaceTitle: false });
  assert.deepEqual(results, ["conflict", "conflict"]);
}));

test("resolveProtyleRunner supports direct instance, IProtyle getInstance, event detail, and rejects invalid targets", () => {
  const direct = { updateTransactionElement() {} };
  assert.equal(resolveProtyleRunner(direct), direct);

  const inner = { updateTransactionElement() {} };
  const iProtyle = { getInstance: () => inner };
  assert.equal(resolveProtyleRunner(iProtyle), inner);
  assert.equal(resolveProtyleRunner({ detail: { protyle: iProtyle } }), inner);

  const nested = { protyle: { updateTransactionElement() {} } };
  assert.equal(resolveProtyleRunner(nested), nested.protyle);

  assert.equal(resolveProtyleRunner(null), null);
  assert.equal(resolveProtyleRunner(undefined), null);
  assert.equal(resolveProtyleRunner({}), null);
  assert.equal(resolveProtyleRunner({ getInstance: () => null }), null);
});

test("resolves and commits via SiYuan IProtyle wrapper", async () => installDOMParser(async () => {
  const links = [new LinkElement("https://example.com/item", "https://example.com/item")];
  const block = new BlockElement("20260101000000-block123", links);
  const transactions = [];
  const runner = {
    updateTransactionElement(element, oldHTML) {
      transactions.push({ element, oldHTML, newHTML: element.outerHTML });
    },
  };
  const iProtyle = {
    block: { rootID: "20260101000000-root123", box: "notebook-123" },
    getInstance() { return runner; },
  };
  const target = captureLinkTarget(links[0], iProtyle);
  assert.ok(target);
  assert.equal(target.rootID, "20260101000000-root123");
  assert.equal(target.notebook, "notebook-123");
  assert.equal(target.protyle, runner);

  const kernel = kernelFor(block, { rootID: "20260101000000-root123", box: "notebook-123" });
  const result = await commitLinkTitle(target, "Resolved Title", { replaceTitle: true, kernel });
  assert.equal(result, "updated");
  assert.equal(links[0].textContent, "Resolved Title");
  assert.equal(transactions.length, 1);
  assert.match(transactions[0].newHTML, />Resolved Title<\/span>/);
}));

test("safely handles kernel pre-write read failures and invalid responses in non-active mode as failed", async () => installDOMParser(async () => {
  const { links, block, protyle } = fixture();
  const target = { ...captureLinkTarget(links[0], protyle), protyle: null };
  const throwingKernel = {
    post: async () => { throw new Error("Network timeout or connection refused"); },
  };
  assert.equal(await commitLinkTitle(target, "Example", { replaceTitle: false, kernel: throwingKernel }), "failed");

  const invalidInfoKernel = {
    async post(path) {
      if (path === "/api/block/getBlockInfo") {
        throw Object.assign(new Error("error"), { outcome: "rejected", code: -1 });
      }
      return { code: 0, data: {} };
    },
  };
  assert.equal(await commitLinkTitle(target, "Example", { replaceTitle: false, kernel: invalidInfoKernel }), "failed");

  const emptyDomKernel = {
    async post(path) {
      if (path === "/api/block/getBlockInfo") return { code: 0, data: { rootID: "20260101000000-rootabc", box: "notebook" } };
      if (path === "/api/block/getBlockDOM") return { code: 0, data: { id: block.id, dom: "" } };
      return { code: 0, data: {} };
    },
  };
  assert.equal(await commitLinkTitle(target, "Example", { replaceTitle: false, kernel: emptyDomKernel }), "failed");

  const unparseableDomKernel = {
    async post(path) {
      if (path === "/api/block/getBlockInfo") return { code: 0, data: { rootID: "20260101000000-rootabc", box: "notebook" } };
      if (path === "/api/block/getBlockDOM") return { code: 0, data: { id: block.id, dom: "<div>broken</div>" } };
      return { code: 0, data: {} };
    },
  };
  assert.equal(await commitLinkTitle(target, "Example", { replaceTitle: false, kernel: unparseableDomKernel }), "failed");
}));

test("safely propagates AbortError during non-active kernel calls as aborted", async () => installDOMParser(async () => {
  const { links, block, protyle } = fixture();
  const target = { ...captureLinkTarget(links[0], protyle), protyle: null };
  const controller = new AbortController();
  const abortingKernel = {
    post: async () => {
      controller.abort();
      const err = new Error("This operation was aborted");
      err.name = "AbortError";
      throw err;
    },
  };
  const result = await commitLinkTitle(target, "Example", {
    replaceTitle: false,
    kernel: abortingKernel,
    signal: controller.signal,
  });
  assert.equal(result, "aborted");
}));

test("active editor never falls back to updateBlock when link is removed from DOM", async () => installDOMParser(async () => {
  const { links, block, protyle, transactions } = fixture();
  const target = captureLinkTarget(links[0], protyle);
  const kernel = kernelFor(block);
  links[0].isConnected = false;

  const result = await commitLinkTitle(target, "Example", { replaceTitle: false, kernel });
  assert.equal(result, "conflict");
  assert.deepEqual(kernel.calls, []);
  assert.equal(transactions.length, 0);
}));

test("nested Protyle.protyle switches to inactive updateBlock when rootID changes or editor is destroyed", async () => installDOMParser(async () => {
  const links = [new LinkElement("https://example.com/item", "https://example.com/item")];
  const block = new BlockElement("20260101000000-block123", links);
  const transactions = [];
  const editorClassList = new Set(["protyle"]);
  const protyleWrapper = {
    destroyed: false,
    protyle: {
      element: { isConnected: true, classList: { contains: name => editorClassList.has(name) } },
      wysiwyg: { element: { isConnected: true } },
      block: { rootID: "20260101000000-docA", box: "notebook-1" },
      notebookId: "notebook-1",
    },
    updateTransactionElement(element, oldHTML) {
      transactions.push({ element, oldHTML });
    },
  };
  const target = captureLinkTarget(links[0], protyleWrapper);
  assert.ok(target);

  // Switch active document to docB while protyle reference remains non-null
  protyleWrapper.protyle.block.rootID = "20260101000000-docB";
  const updateCalls = [];
  const kernel = {
    calls: [],
    async post(path, body) {
      this.calls.push(path);
      if (path === "/api/block/getBlockInfo") return { data: { rootID: "20260101000000-docA", box: "notebook-1" }, code: 0 };
      if (path === "/api/block/getBlockDOM") return { data: { id: block.id, dom: block.outerHTML }, code: 0 };
      if (path === "/api/block/updateBlock") { updateCalls.push(body); return { code: 0, data: null }; }
      return { data: {}, code: 0 };
    },
  };

  const switchedResult = await commitLinkTitle(target, "Switched Title", { replaceTitle: false, kernel });
  assert.equal(switchedResult, "updated");
  assert.deepEqual(kernel.calls, ["/api/block/getBlockInfo", "/api/block/getBlockDOM", "/api/block/updateBlock"]);
  assert.equal(transactions.length, 0);
  assert.equal(updateCalls.length, 1);

  // Restore rootID, then destroy the editor (sets destroyed = true and removes .protyle class)
  protyleWrapper.protyle.block.rootID = "20260101000000-docA";
  protyleWrapper.destroyed = true;
  editorClassList.delete("protyle");
  kernel.calls = [];
  const destroyedResult = await commitLinkTitle(target, "Destroyed Title", { replaceTitle: false, kernel });
  assert.equal(destroyedResult, "updated");
  assert.deepEqual(kernel.calls, ["/api/block/getBlockInfo", "/api/block/getBlockDOM", "/api/block/updateBlock"]);
  assert.equal(transactions.length, 0);
}));

test("restores collapsed caret to end of link text without stealing non-collapsed or external selection", async () => installDOMParser(async () => {
  const prevSelection = globalThis.getSelection;
  const prevDocument = globalThis.document;
  try {
    const createRichFixture = () => {
      const outsideNode = { nodeType: 3, textContent: "outside" };
      const textNode = { nodeType: 3, textContent: "https://example.com/0" };
      const link = {
        attributes: new Map([["data-type", "a"], ["data-href", "https://example.com/0"]]),
        isConnected: true,
        block: undefined,
        _text: "https://example.com/0",
        firstChild: textNode,
        childNodes: [textNode],
        get textContent() { return this._text; },
        set textContent(value) {
          this._text = String(value);
          const child = { nodeType: 3, textContent: this._text };
          this.firstChild = this._text.length > 0 ? child : null;
          this.childNodes = this.firstChild ? [this.firstChild] : [];
        },
        getAttribute(name) { return this.attributes.get(name) ?? null; },
        setAttribute(name, value) { this.attributes.set(name, String(value)); },
        removeAttribute(name) { this.attributes.delete(name); },
        contains(node) { return node === this || node === this.firstChild || node === textNode; },
        closest(selector) { return selector === "[data-node-id]" ? this.block : null; },
        get outerHTML() { return `<span data-type="a" data-href="https://example.com/0">${this._text}</span>`; },
      };
      const block = new BlockElement("20260101000000-caret", [link]);
      const events = [];
      const protyle = {
        block: { rootID: "20260101000000-rootcaret", box: "notebook" },
        notebookId: "notebook",
        updateTransactionElement() { events.push("transaction"); },
      };
      return { link, block, protyle, textNode, outsideNode, events };
    };

    const installSelection = (range, events) => {
      let currentRange = range;
      const selection = {
        get rangeCount() { return currentRange ? 1 : 0; },
        getRangeAt() { return currentRange; },
        removeAllRanges() { events.push("removeAllRanges"); currentRange = null; },
        addRange(next) { events.push("addRange"); currentRange = next; },
      };
      globalThis.getSelection = () => selection;
      globalThis.document = {
        createRange() {
          return {
            startContainer: null,
            startOffset: 0,
            collapsed: false,
            setStart(node, offset) { this.startContainer = node; this.startOffset = offset; },
            collapse(toStart) { this.collapsed = toStart; },
          };
        },
      };
      return () => currentRange;
    };

    // 1. Collapsed caret inside link -> restored at end of new Text node before transaction
    {
      const { link, protyle, textNode, events } = createRichFixture();
      const getCurrent = installSelection({ collapsed: true, startContainer: textNode, endContainer: textNode }, events);
      const target = captureLinkTarget(link, protyle);
      assert.equal(await commitLinkTitle(target, "Restored Title", { replaceTitle: false }), "updated");
      assert.deepEqual(events, ["removeAllRanges", "addRange", "transaction"]);
      assert.equal(getCurrent().startContainer, link.firstChild);
      assert.equal(getCurrent().startOffset, "Restored Title".length);
      assert.equal(getCurrent().collapsed, true);
    }

    // 2. Non-collapsed selection inside link -> does not touch selection
    {
      const { link, protyle, textNode, events } = createRichFixture();
      installSelection({ collapsed: false, startContainer: textNode, endContainer: textNode }, events);
      const target = captureLinkTarget(link, protyle);
      assert.equal(await commitLinkTitle(target, "Selected Title", { replaceTitle: false }), "updated");
      assert.deepEqual(events, ["transaction"]);
    }

    // 3. Collapsed caret outside link -> does not steal focus
    {
      const { link, protyle, outsideNode, events } = createRichFixture();
      installSelection({ collapsed: true, startContainer: outsideNode, endContainer: outsideNode }, events);
      const target = captureLinkTarget(link, protyle);
      assert.equal(await commitLinkTitle(target, "External Title", { replaceTitle: false }), "updated");
      assert.deepEqual(events, ["transaction"]);
    }
  } finally {
    globalThis.getSelection = prevSelection;
    globalThis.document = prevDocument;
  }
}));

test("non-active mode enforces exact ordinal and rejects fuzzy match on duplicate URLs", async () => installDOMParser(async () => {
  const url = "https://example.com/dup";
  const links = [new LinkElement(url, url), new LinkElement(url, url)];
  const block = new BlockElement("20260101000000-dupblock", links);
  const targetSecond = { ...captureLinkTarget(links[1], {
    block: { rootID: "20260101000000-root", box: "notebook" },
    notebookId: "notebook",
    updateTransactionElement() {},
  }), protyle: null };
  assert.equal(targetSecond.ordinal, 1);

  // Persisted DOM now only has ordinal 0 with that URL (ordinal 1 was deleted/shifted)
  const shiftedDOM = `<div data-node-id="${block.id}"><span data-type="a" data-href="${url}">${url}</span></div>`;
  const updateCalls = [];
  const kernel = {
    async post(path, body) {
      if (path === "/api/block/getBlockInfo") return { data: { rootID: "20260101000000-root", box: "notebook" }, code: 0 };
      if (path === "/api/block/getBlockDOM") return { data: { id: block.id, dom: shiftedDOM }, code: 0 };
      if (path === "/api/block/updateBlock") { updateCalls.push(body); return { code: 0, data: null }; }
      return { data: {}, code: 0 };
    },
  };

  const result = await commitLinkTitle(targetSecond, "Should Not Overwrite Ordinal 0", { replaceTitle: false, kernel });
  assert.equal(result, "conflict");
  assert.equal(updateCalls.length, 0);
}));

test("non-active mode checks live rootID and box and makes zero updateBlock calls when block moved across docs", async () => installDOMParser(async () => {
  const { links, block, protyle } = fixture();
  const target = { ...captureLinkTarget(links[0], protyle), protyle: null };
  const calls = [];
  const kernel = {
    async post(path) {
      calls.push(path);
      if (path === "/api/block/getBlockInfo") {
        return { data: { rootID: "20260101000000-otherdoc", box: "notebook" }, code: 0 };
      }
      if (path === "/api/block/getBlockDOM") {
        return { data: { id: block.id, dom: block.outerHTML }, code: 0 };
      }
      return { code: 0, data: null };
    },
  };

  const result = await commitLinkTitle(target, "Moved Title", { replaceTitle: false, kernel });
  assert.equal(result, "conflict");
  assert.deepEqual(calls, ["/api/block/getBlockInfo"]);
}));

test("commitLinkTitle checks isCurrent inside write lease after IME wait and returns superseded without modifying DOM", async () => installDOMParser(async () => {
  const { links, protyle, transactions } = fixture();
  const target = captureLinkTarget(links[0], protyle);
  let composing = true;
  let current = true;
  setTimeout(() => {
    current = false;
    composing = false;
  }, 5);

  const result = await commitLinkTitle(target, "Stale Title", {
    replaceTitle: false,
    isComposing: () => composing,
    imePollMs: 1,
    imeTimeoutMs: 200,
    isCurrent: () => current,
  });

  assert.equal(result, "superseded");
  assert.equal(transactions.length, 0);
  assert.equal(links[0].textContent, "https://example.com/0");
}));

test("restores collapsed caret on rolled-back text node when updateTransactionElement throws", async () => installDOMParser(async () => {
  const prevSelection = globalThis.getSelection;
  const prevDocument = globalThis.document;
  try {
    let textNode = { nodeType: 3, textContent: "https://example.com/0" };
    let blockRef;
    const link = {
      attributes: new Map([["data-type", "a"], ["data-href", "https://example.com/0"]]),
      isConnected: true,
      get firstChild() { return textNode; },
      childNodes: { get length() { return 1; } },
      get textContent() { return textNode.textContent; },
      set textContent(value) { textNode = { nodeType: 3, textContent: String(value) }; },
      getAttribute(name) { return this.attributes.get(name) ?? null; },
      setAttribute(name, value) { this.attributes.set(name, String(value)); },
      removeAttribute(name) { this.attributes.delete(name); },
      closest: selector => (selector === "[data-node-id]" ? blockRef : null),
      contains: node => node === link || node === textNode,
      get outerHTML() { return `<span data-type="a" data-href="https://example.com/0">${this.textContent}</span>`; },
    };
    blockRef = new BlockElement("20260101000000-rollback", [link]);
    const protyle = {
      block: { rootID: "20260101000000-rootabc", box: "notebook" },
      notebookId: "notebook",
      async updateTransactionElement() { throw new Error("tx failed"); },
    };
    const appliedRanges = [];
    const initialNode = textNode;
    globalThis.getSelection = () => ({
      rangeCount: 1,
      getRangeAt: () => ({ collapsed: true, startContainer: initialNode, endContainer: initialNode, startOffset: 8 }),
      removeAllRanges() {},
      addRange(r) { appliedRanges.push(r); },
    });
    globalThis.document = {
      createRange: () => {
        const range = { node: null, offset: 0, setStart(n, o) { this.node = n; this.offset = o; }, collapse() {} };
        return range;
      },
    };

    const target = captureLinkTarget(link, protyle);
    const result = await commitLinkTitle(target, "New Title", { replaceTitle: false });
    assert.equal(result, "failed");
    assert.equal(link.textContent, "https://example.com/0");
    assert.equal(appliedRanges.length, 2);
    assert.equal(appliedRanges[1].node, textNode);
    assert.equal(appliedRanges[1].offset, 8);

    // Superseded and aborted cases keep their respective outcomes after rollback
    const superseded = await commitLinkTitle(target, "New Title", { replaceTitle: false, isCurrent: () => false });
    assert.equal(superseded, "superseded");
    assert.equal(link.textContent, "https://example.com/0");

    const controller = new AbortController();
    const abortingProtyle = {
      block: { rootID: "20260101000000-rootabc", box: "notebook" },
      notebookId: "notebook",
      async updateTransactionElement() {
        controller.abort();
        throw new Error("aborted tx");
      },
    };
    const abortTarget = captureLinkTarget(link, abortingProtyle);
    const aborted = await commitLinkTitle(abortTarget, "New Title", { replaceTitle: false, signal: controller.signal });
    assert.equal(aborted, "aborted");
    assert.equal(link.textContent, "https://example.com/0");
  } finally {
    globalThis.getSelection = prevSelection;
    globalThis.document = prevDocument;
  }
}));

test("drops render-only parent-heading before updateBlock", async () => {
  const prevDOMParser = globalThis.DOMParser;
  try {
    const links = [new LinkElement("https://example.com/0", "https://example.com/0")];
    const block = new BlockElement("20260101000000-abcdefg", links);
    const target = {
      ...captureLinkTarget(links[0], {
        block: { rootID: "20260101000000-rootabc", box: "notebook" },
        notebookId: "notebook",
        updateTransactionElement() {},
      }),
      protyle: null,
    };

    const persistedLink = new LinkElement("https://example.com/0", "https://example.com/0");
    persistedLink.setAttribute("parent-heading", "20260101000000-heading");
    const origLinkOuterHTML = Object.getOwnPropertyDescriptor(LinkElement.prototype, "outerHTML").get;
    Object.defineProperty(persistedLink, "outerHTML", {
      get() {
        const ph = this.getAttribute("parent-heading");
        const base = origLinkOuterHTML.call(this);
        return ph === null ? base : base.replace("<span ", `<span parent-heading="${ph}" `);
      },
    });
    const persistedBlock = new BlockElement(
      block.id,
      [persistedLink],
      "",
      new Map([["parent-heading", "20260101000000-heading"], ["updated", "20260101000000"]]),
    );
    globalThis.DOMParser = class {
      parseFromString() {
        return { querySelectorAll: selector => selector === "[data-node-id]" ? [persistedBlock] : [] };
      }
    };

    const updateCalls = [];
    const kernel = {
      async post(path, body) {
        if (path === "/api/block/getBlockInfo") return { data: { rootID: "20260101000000-rootabc", box: "notebook" }, code: 0 };
        if (path === "/api/block/getBlockDOM") return { data: { id: block.id, dom: persistedBlock.outerHTML }, code: 0 };
        if (path === "/api/block/updateBlock") { updateCalls.push(body); return { code: 0, data: null }; }
        return { data: {}, code: 0 };
      },
    };

    const result = await commitLinkTitle(target, "Clean Title", { replaceTitle: false, kernel });
    assert.equal(result, "updated");
    assert.equal(updateCalls.length, 1);
    assert.doesNotMatch(updateCalls[0].data, /parent-heading/);
    assert.match(updateCalls[0].data, /updated="20260101000000"/);
    assert.match(updateCalls[0].data, />Clean Title<\/span>/);
  } finally {
    globalThis.DOMParser = prevDOMParser;
  }
});

test("shares block write lease with Core withBlockWriteLease", async () => installDOMParser(async () => {
  const { links, block, protyle, transactions } = fixture();
  const target = captureLinkTarget(links[0], protyle);
  const events = [];
  let releaseLease;
  let markLeaseAcquired;
  const leaseAcquired = new Promise(resolve => { markLeaseAcquired = resolve; });
  const leaseGate = new Promise(resolve => { releaseLease = resolve; });

  const held = withBlockWriteLease("notebook", block.id, undefined, async () => {
    events.push("core:start");
    markLeaseAcquired();
    await leaseGate;
    events.push("core:end");
  });

  await leaseAcquired;
  const commitPromise = commitLinkTitle(target, "After Lease", { replaceTitle: false }).then(res => {
    events.push(`commit:${res}`);
    return res;
  });

  await new Promise(resolve => setTimeout(resolve, 10));
  assert.deepEqual(events, ["core:start"]);
  assert.equal(transactions.length, 0);

  releaseLease();
  await held;
  const result = await commitPromise;
  assert.equal(result, "updated");
  assert.deepEqual(events, ["core:start", "core:end", "commit:updated"]);
}));

test("refuses to capture links inside protected containers", () => {
  const protyle = {
    block: { rootID: "20260101000000-rootabc", box: "notebook" },
    notebookId: "notebook",
    updateTransactionElement() {},
  };
  const block = {
    getAttribute: name => (name === "data-node-id" ? "20260101000000-code" : null),
    querySelectorAll: () => [protectedLink],
    outerHTML: '<div data-node-id="20260101000000-code"></div>',
  };
  const protectedLink = {
    textContent: "https://example.com",
    getAttribute: name => ({ "data-type": "a", "data-href": "https://example.com" }[name] ?? null),
    closest(selector) {
      if (selector === PROTECTED_CONTAINER_SELECTOR) return {};
      if (selector === "[data-node-id]") return block;
      return null;
    },
  };
  assert.equal(captureLinkTarget(protectedLink, protyle), null);
});

test("rejects grouped update when duplicate ordinals are present", async () => installDOMParser(async () => {
  const { links, protyle, transactions } = fixture(1);
  const first = captureLinkTarget(links[0], protyle);
  const results = await commitLinkTitles([
    { target: first, title: "Title A" },
    { target: first, title: "Title B" },
  ], { replaceTitle: false });
  assert.deepEqual(results, ["conflict", "conflict"]);
  assert.equal(transactions.length, 0);
}));

test("commitLinkTitle waits for target editor IME without blocking when another editor is composing", async () => installDOMParser(async () => {
  const { links, protyle: protyleA } = fixture(1);
  const protyleB = {
    block: { rootID: "20260101000000-rootbbb", box: "notebook" },
    notebookId: "notebook",
    element: { isConnected: true },
    updateTransactionElement() {},
  };
  const targetA = captureLinkTarget(links[0], protyleA);
  let composingB = true;
  let checkedProtyle;

  const result = await commitLinkTitle(targetA, "Clean Title", {
    replaceTitle: false,
    isComposing: protyle => {
      checkedProtyle = protyle;
      return protyle === protyleB ? composingB : false;
    },
  });

  assert.equal(result, "updated");
  assert.equal(checkedProtyle, protyleA);
  composingB = false;
}));

test("non-active mode rejects when persisted block changed outside the target link", async () => {
  const prevDOMParser = globalThis.DOMParser;
  try {
    const url = "https://example.com/item";
    const originalHTML = `<div data-node-id="20260101000000-blkbase">prefix <span data-type="a" data-href="${url}">${url}</span></div>`;
    const changedHTML = `<div data-node-id="20260101000000-blkbase">edited <span data-type="a" data-href="${url}">${url}</span></div>`;

    const parseRich = html => {
      const id = html.match(/data-node-id="([^"]+)"/)?.[1];
      const prefix = html.match(/<div data-node-id="[^"]+">(.*?)<span data-type="a"/)?.[1] ?? "";
      const linkMatch = html.match(/<span data-type="a" data-href="([^"]+)">(.*?)<\/span>/);
      const link = new LinkElement(linkMatch[1], linkMatch[2]);
      return new BlockElement(id, [link], prefix);
    };

    const capturedBlock = parseRich(originalHTML);
    const target = {
      ...captureLinkTarget(capturedBlock.links[0], {
        block: { rootID: "20260101000000-rootbase", box: "notebook" },
        notebookId: "notebook",
        updateTransactionElement() {},
      }),
      protyle: null,
    };

    globalThis.DOMParser = class {
      parseFromString(html) {
        const parsed = parseRich(html);
        return { querySelectorAll: selector => selector === "[data-node-id]" ? [parsed] : [] };
      }
    };

    const updateCalls = [];
    const kernel = {
      async post(path, body) {
        if (path === "/api/block/getBlockInfo") return { data: { rootID: "20260101000000-rootbase", box: "notebook" }, code: 0 };
        if (path === "/api/block/getBlockDOM") return { data: { id: "20260101000000-blkbase", dom: changedHTML }, code: 0 };
        if (path === "/api/block/updateBlock") { updateCalls.push(body); return { code: 0, data: null }; }
        return { code: 0, data: {} };
      },
    };

    assert.equal(await commitLinkTitle(target, "New Title", { replaceTitle: false, kernel }), "conflict");
    assert.equal(updateCalls.length, 0);
  } finally {
    globalThis.DOMParser = prevDOMParser;
  }
});

test("non-active mode re-reads getBlockDOM only when updateBlock throws unknown and classifies outcomes accurately", async () => installDOMParser(async () => {
  const { links, block, protyle } = fixture();
  const baseTarget = { ...captureLinkTarget(links[0], protyle), protyle: null };

  // 1. Unknown updateBlock error + verify read shows title persisted -> "updated"
  {
    let domReads = 0;
    const kernel = {
      async post(path) {
        if (path === "/api/block/getBlockInfo") return { data: { rootID: "20260101000000-rootabc", box: "notebook" }, code: 0 };
        if (path === "/api/block/getBlockDOM") {
          domReads += 1;
          const dom = domReads === 1
            ? block.outerHTML
            : `<div data-node-id="${block.id}" updated="20260101000001"><span data-type="a" data-href="https://example.com/0">Resolved</span></div>`;
          return { data: { id: block.id, dom }, code: 0 };
        }
        if (path === "/api/block/updateBlock") throw new Error("timeout waiting response");
        return { code: 0, data: {} };
      },
    };
    assert.equal(await commitLinkTitle(baseTarget, "Resolved", { replaceTitle: false, kernel }), "updated");
    assert.equal(domReads, 2);
  }

  // 2. Unknown updateBlock error + verify read still matches baseline -> "unknown" (never retry)
  {
    let domReads = 0;
    let updateCalls = 0;
    const kernel = {
      async post(path) {
        if (path === "/api/block/getBlockInfo") return { data: { rootID: "20260101000000-rootabc", box: "notebook" }, code: 0 };
        if (path === "/api/block/getBlockDOM") {
          domReads += 1;
          return { data: { id: block.id, dom: block.outerHTML }, code: 0 };
        }
        if (path === "/api/block/updateBlock") {
          updateCalls += 1;
          throw new Error("timeout waiting response");
        }
        return { code: 0, data: {} };
      },
    };
    assert.equal(await commitLinkTitle(baseTarget, "Resolved", { replaceTitle: false, kernel }), "unknown");
    assert.equal(domReads, 2);
    assert.equal(updateCalls, 1);
  }

  // 3. Unknown updateBlock error + verify read shows concurrent edit -> "conflict"
  {
    let domReads = 0;
    const kernel = {
      async post(path) {
        if (path === "/api/block/getBlockInfo") return { data: { rootID: "20260101000000-rootabc", box: "notebook" }, code: 0 };
        if (path === "/api/block/getBlockDOM") {
          domReads += 1;
          const dom = domReads === 1
            ? block.outerHTML
            : `<div data-node-id="${block.id}"><span data-type="a" data-href="https://example.com/0">User Edited</span></div>`;
          return { data: { id: block.id, dom }, code: 0 };
        }
        if (path === "/api/block/updateBlock") throw new Error("timeout waiting response");
        return { code: 0, data: {} };
      },
    };
    assert.equal(await commitLinkTitle(baseTarget, "Resolved", { replaceTitle: false, kernel }), "conflict");
  }

  // 4. Unknown updateBlock error + verify read fails -> "unknown"
  {
    let domReads = 0;
    const kernel = {
      async post(path) {
        if (path === "/api/block/getBlockInfo") return { data: { rootID: "20260101000000-rootabc", box: "notebook" }, code: 0 };
        if (path === "/api/block/getBlockDOM") {
          domReads += 1;
          if (domReads === 1) return { data: { id: block.id, dom: block.outerHTML }, code: 0 };
          throw new Error("still disconnected");
        }
        if (path === "/api/block/updateBlock") throw new Error("timeout waiting response");
        return { code: 0, data: {} };
      },
    };
    assert.equal(await commitLinkTitle(baseTarget, "Resolved", { replaceTitle: false, kernel }), "unknown");
  }

  // 5. Explicit kernel rejection (code: 1) -> "failed" without extra getBlockDOM read
  {
    let domReads = 0;
    const kernel = {
      async post(path) {
        if (path === "/api/block/getBlockInfo") return { data: { rootID: "20260101000000-rootabc", box: "notebook" }, code: 0 };
        if (path === "/api/block/getBlockDOM") {
          domReads += 1;
          return { data: { id: block.id, dom: block.outerHTML }, code: 0 };
        }
        if (path === "/api/block/updateBlock") {
          throw Object.assign(new Error("rejected"), { outcome: "rejected", code: 1 });
        }
        return { code: 0, data: {} };
      },
    };
    assert.equal(await commitLinkTitle(baseTarget, "Resolved", { replaceTitle: false, kernel }), "failed");
    assert.equal(domReads, 1);
  }

  // 6. KernelClient rejected -> "failed", not-sent -> "aborted", both without re-reading getBlockDOM
  for (const [outcome, expected] of [["rejected", "failed"], ["not-sent", "aborted"]]) {
    let domReads = 0;
    const kernel = {
      async post(path) {
        if (path === "/api/block/getBlockInfo") return { data: { rootID: "20260101000000-rootabc", box: "notebook" }, code: 0 };
        if (path === "/api/block/getBlockDOM") {
          domReads += 1;
          return { data: { id: block.id, dom: block.outerHTML }, code: 0 };
        }
        if (path === "/api/block/updateBlock") {
          const err = new Error(`kernel ${outcome}`);
          err.outcome = outcome;
          err.code = outcome === "rejected" ? -1 : undefined;
          throw err;
        }
        return { code: 0, data: {} };
      },
    };
    assert.equal(await commitLinkTitle(baseTarget, "Resolved", { replaceTitle: false, kernel }), expected);
    assert.equal(domReads, 1);
  }

  // 7. Unknown updateBlock error when initial block had updated attr -> payload keeps original updated, verify strips updated and returns "updated"
  {
    const linkWithUpdated = new LinkElement("https://example.com/0", "https://example.com/0");
    const blockWithUpdated = new BlockElement(
      "20260101000000-updblk",
      [linkWithUpdated],
      "",
      new Map([["updated", "20260101000000"]]),
    );
    const targetWithUpdated = {
      ...captureLinkTarget(linkWithUpdated, {
        block: { rootID: "20260101000000-rootabc", box: "notebook" },
        notebookId: "notebook",
        updateTransactionElement() {},
      }),
      protyle: null,
    };
    let domReads = 0;
    const sentPayloads = [];
    const kernel = {
      async post(path, body) {
        if (path === "/api/block/getBlockInfo") return { data: { rootID: "20260101000000-rootabc", box: "notebook" }, code: 0 };
        if (path === "/api/block/getBlockDOM") {
          domReads += 1;
          const dom = domReads === 1
            ? blockWithUpdated.outerHTML
            : `<div data-node-id="${blockWithUpdated.id}" updated="20260101000009"><span data-type="a" data-href="https://example.com/0">Committed</span></div>`;
          return { data: { id: blockWithUpdated.id, dom }, code: 0 };
        }
        if (path === "/api/block/updateBlock") {
          sentPayloads.push(body);
          throw new Error("network lost");
        }
        return { code: 0, data: {} };
      },
    };
    assert.equal(await commitLinkTitle(targetWithUpdated, "Committed", { replaceTitle: false, kernel }), "updated");
    assert.equal(domReads, 2);
    assert.match(sentPayloads[0].data, /updated="20260101000000"/);
  }

  // 8. Concurrent non-link edit on same block during unknown updateBlock -> "conflict" (even if link text stayed at baseline)
  {
    let domReads = 0;
    const kernel = {
      async post(path) {
        if (path === "/api/block/getBlockInfo") return { data: { rootID: "20260101000000-rootabc", box: "notebook" }, code: 0 };
        if (path === "/api/block/getBlockDOM") {
          domReads += 1;
          const dom = domReads === 1
            ? block.outerHTML
            : `<div data-node-id="${block.id}">concurrent text <span data-type="a" data-href="https://example.com/0">https://example.com/0</span></div>`;
          return { data: { id: block.id, dom }, code: 0 };
        }
        if (path === "/api/block/updateBlock") throw new Error("timeout waiting response");
        return { code: 0, data: {} };
      },
    };
    assert.equal(await commitLinkTitle(baseTarget, "Resolved", { replaceTitle: false, kernel }), "conflict");
  }
}));

test("non-active mode preserves mixed updated, unchanged, and superseded outcomes on unknown updateBlock verification", async () => installDOMParser(async () => {
  const links = [
    new LinkElement("https://example.com/0", "https://example.com/0"),
    new LinkElement("https://example.com/1", "Already Titled"),
    new LinkElement("https://example.com/2", "https://example.com/2"),
  ];
  const block = new BlockElement("20260101000000-mixed", links, "", new Map([["updated", "20260101000000"]]));
  const mockProtyle = {
    block: { rootID: "20260101000000-rootmix", box: "notebook" },
    notebookId: "notebook",
    updateTransactionElement() {},
  };
  const targets = links.map(link => ({ ...captureLinkTarget(link, mockProtyle), protyle: null }));

  // 1. Re-read matches baseline -> "updated" becomes "unknown", "unchanged" stays "unchanged", "superseded" stays "superseded"
  {
    const kernel = {
      async post(path) {
        if (path === "/api/block/getBlockInfo") return { data: { rootID: "20260101000000-rootmix", box: "notebook" }, code: 0 };
        if (path === "/api/block/getBlockDOM") return { data: { id: block.id, dom: block.outerHTML }, code: 0 };
        if (path === "/api/block/updateBlock") throw new Error("timeout waiting response");
        return { code: 0, data: {} };
      },
    };
    const results = await commitLinkTitles([
      { target: targets[0], title: "New Title" },
      { target: targets[1], title: "Already Titled" },
      { target: targets[2], title: "Ignored", isCurrent: () => false },
    ], { replaceTitle: false, kernel });
    assert.deepEqual(results, ["unknown", "unchanged", "superseded"]);
  }

  // 2. Re-read matches expected with updated attr changed -> "updated", "unchanged", "superseded"
  {
    let domReads = 0;
    const kernel = {
      async post(path) {
        if (path === "/api/block/getBlockInfo") return { data: { rootID: "20260101000000-rootmix", box: "notebook" }, code: 0 };
        if (path === "/api/block/getBlockDOM") {
          domReads += 1;
          const dom = domReads === 1
            ? block.outerHTML
            : `<div data-node-id="${block.id}" updated="20260101000005"><span data-type="a" data-href="https://example.com/0">New Title</span><span data-type="a" data-href="https://example.com/1">Already Titled</span><span data-type="a" data-href="https://example.com/2">https://example.com/2</span></div>`;
          return { data: { id: block.id, dom }, code: 0 };
        }
        if (path === "/api/block/updateBlock") throw new Error("timeout waiting response");
        return { code: 0, data: {} };
      },
    };
    const results = await commitLinkTitles([
      { target: targets[0], title: "New Title" },
      { target: targets[1], title: "Already Titled" },
      { target: targets[2], title: "Ignored", isCurrent: () => false },
    ], { replaceTitle: false, kernel });
    assert.deepEqual(results, ["updated", "unchanged", "superseded"]);
  }
}));

test("inactive editor or editor switched mid-IME-wait skips IME blocking and writes via background updateBlock", async () => installDOMParser(async () => {
  const links = [new LinkElement("https://example.com/0", "https://example.com/0")];
  const block = new BlockElement("20260101000000-imebg", links);
  const editorClassList = new Set(["protyle"]);
  const makeProtyle = () => ({
    destroyed: false,
    protyle: {
      element: { isConnected: true, classList: { contains: name => editorClassList.has(name) } },
      wysiwyg: { element: { isConnected: true } },
      block: { rootID: "20260101000000-docA", box: "notebook" },
      notebookId: "notebook",
    },
    updateTransactionElement() { throw new Error("Must not use active transaction on inactive editor"); },
  });

  // Case 1: Already switched to docB on same tab while IME is active -> skips isComposing check completely
  {
    const protyle = makeProtyle();
    const target = captureLinkTarget(links[0], protyle);
    protyle.protyle.block.rootID = "20260101000000-docB";
    let composingChecks = 0;
    const kernel = {
      calls: [],
      async post(path) {
        this.calls.push(path);
        if (path === "/api/block/getBlockInfo") return { data: { rootID: "20260101000000-docA", box: "notebook" }, code: 0 };
        if (path === "/api/block/getBlockDOM") return { data: { id: block.id, dom: block.outerHTML }, code: 0 };
        if (path === "/api/block/updateBlock") return { code: 0, data: null };
        return { code: 0, data: {} };
      },
    };
    const res = await commitLinkTitle(target, "Background Title", {
      replaceTitle: false,
      kernel,
      isComposing: () => { composingChecks += 1; return true; },
      imeTimeoutMs: 500,
      imePollMs: 10,
    });
    assert.equal(res, "updated");
    assert.equal(composingChecks, 0, "inactive editor must not wait for IME");
    assert.deepEqual(kernel.calls, ["/api/block/getBlockInfo", "/api/block/getBlockDOM", "/api/block/updateBlock"]);
  }

  // Case 2: Editor switches to docB mid-IME-wait -> exits IME wait immediately and commits via updateBlock
  {
    const protyle = makeProtyle();
    const target = captureLinkTarget(links[0], protyle);
    let checks = 0;
    const kernel = {
      calls: [],
      async post(path) {
        this.calls.push(path);
        if (path === "/api/block/getBlockInfo") return { data: { rootID: "20260101000000-docA", box: "notebook" }, code: 0 };
        if (path === "/api/block/getBlockDOM") return { data: { id: block.id, dom: block.outerHTML }, code: 0 };
        if (path === "/api/block/updateBlock") return { code: 0, data: null };
        return { code: 0, data: {} };
      },
    };
    const res = await commitLinkTitle(target, "Switched Mid-IME", {
      replaceTitle: false,
      kernel,
      isComposing: () => {
        checks += 1;
        if (checks >= 2) protyle.protyle.block.rootID = "20260101000000-docB";
        return true;
      },
      imeTimeoutMs: 2000,
      imePollMs: 2,
    });
    assert.equal(res, "updated");
    assert.ok(checks >= 2 && checks <= 3, `expected early exit once switched, got ${checks} checks`);
    assert.deepEqual(kernel.calls, ["/api/block/getBlockInfo", "/api/block/getBlockDOM", "/api/block/updateBlock"]);
  }
}));

test("non-active mode unwraps cause-chained KernelOutcome and AbortError via Core helpers", async () => installDOMParser(async () => {
  const { links, block, protyle } = fixture();
  const target = { ...captureLinkTarget(links[0], protyle), protyle: null };

  // Wrapped cause with not-sent -> aborted without re-reading getBlockDOM
  let domReads = 0;
  const notSentWrappedKernel = {
    async post(path) {
      if (path === "/api/block/getBlockInfo") return { data: { rootID: "20260101000000-rootabc", box: "notebook" }, code: 0 };
      if (path === "/api/block/getBlockDOM") {
        domReads += 1;
        return { data: { id: block.id, dom: block.outerHTML }, code: 0 };
      }
      if (path === "/api/block/updateBlock") {
        const inner = Object.assign(new Error("cancelled"), { outcome: "not-sent", name: "AbortError" });
        throw new Error("wrapped", { cause: inner });
      }
      return { code: 0, data: {} };
    },
  };
  assert.equal(await commitLinkTitle(target, "Resolved", { replaceTitle: false, kernel: notSentWrappedKernel }), "aborted");
  assert.equal(domReads, 1);

  // Pre-write read throwing cause-wrapped AbortError -> aborted
  const abortCauseKernel = {
    async post() {
      const inner = Object.assign(new Error("aborted"), { name: "AbortError" });
      throw new Error("read failed", { cause: inner });
    },
  };
  assert.equal(await commitLinkTitle(target, "Resolved", { replaceTitle: false, kernel: abortCauseKernel }), "aborted");
}));

test("C-BUG-01: active read-only editor or locked block returns failed immediately without mutating DOM or falling back to updateBlock", async () => installDOMParser(async () => {
  // 1. Active editor locked via protyle.disabled = true after target capture
  {
    const { links, block, protyle, transactions } = fixture(2);
    const first = captureLinkTarget(links[0], protyle);
    const second = captureLinkTarget(links[1], protyle);
    protyle.disabled = true;
    const kernel = kernelFor(block);

    const results = await commitLinkTitles([
      { target: first, title: "Blocked 1" },
      { target: second, title: "Superseded 2", isCurrent: () => false },
    ], { replaceTitle: true, kernel });

    assert.deepEqual(results, ["failed", "superseded"]);
    assert.equal(transactions.length, 0, "must not submit transaction on disabled editor");
    assert.deepEqual(kernel.calls, [], "must never bypass read-only lock via background updateBlock");
    assert.equal(links[0].textContent, "https://example.com/0");
  }

  // 2. Active editor with block contenteditable="false" or custom-sy-readonly="true"
  {
    const links = [new LinkElement("https://example.com/ro", "https://example.com/ro")];
    const block = new BlockElement(
      "20260101000000-roblock",
      links,
      "",
      new Map([["contenteditable", "false"]]),
    );
    const transactions = [];
    const protyle = {
      protyle: {
        disabled: false,
        wysiwyg: { element: { isConnected: true, getAttribute: () => "true" } },
        block: { rootID: "20260101000000-rootro", box: "notebook" },
        notebookId: "notebook",
      },
      updateTransactionElement(el, old) { transactions.push({ el, old }); },
    };
    const target = captureLinkTarget(links[0], protyle);
    const kernel = kernelFor(block, { rootID: "20260101000000-rootro" });

    assert.equal(await commitLinkTitle(target, "Should Fail", { replaceTitle: false, kernel }), "failed");
    assert.equal(transactions.length, 0);
    assert.deepEqual(kernel.calls, []);
    assert.equal(links[0].textContent, "https://example.com/ro");
  }
}));

test("C-BUG-02: captureLinkTarget and inactive writer reject links inside .av and NodeAttributeView containers", async () => installDOMParser(async () => {
  const protyle = {
    block: { rootID: "20260101000000-rootav", box: "notebook" },
    notebookId: "notebook",
    updateTransactionElement() {},
  };
  const avLink = new LinkElement("https://example.com/av", "https://example.com/av");
  const avBlock = new BlockElement(
    "20260101000000-avblk",
    [avLink],
    "",
    new Map([["data-type", "NodeAttributeView"], ["class", "av"]]),
  );
  assert.equal(captureLinkTarget(avLink, protyle), null);

  // If block turned into NodeAttributeView in persisted kernel DOM before inactive write, reject as conflict
  const normalLinks = [new LinkElement("https://example.com/av", "https://example.com/av")];
  const normalBlock = new BlockElement("20260101000000-avblk", normalLinks);
  const inactiveTarget = { ...captureLinkTarget(normalLinks[0], protyle), protyle: null, originalBlockHTML: undefined };
  const kernel = kernelFor(normalBlock, { rootID: "20260101000000-rootav", dom: avBlock.outerHTML });
  assert.equal(await commitLinkTitle(inactiveTarget, "Title", { replaceTitle: false, kernel }), "conflict");
}));

test("C-BUG-03: live snapshot with protyle-wysiwyg--select, protyle-wysiwyg--hl, data-eof, data-node-index, wbr, heading number, and reordered attributes succeeds in background updateBlock without false conflict", async () => installDOMParser(async () => {
  const url = "https://example.com/gutter-batch";
  const liveHTML =
    `<div class="p protyle-wysiwyg--select protyle-wysiwyg--hl" data-eof="true" data-node-index="0" select-start="true" data-editing="1" updated="20260101000000" style="--b3-protyle-heading-number-width: 24px;" data-type="NodeParagraph" data-node-id="20260101000000-gutter">` +
    `<span class="protyle-heading-number protyle-heading-number--active">1. </span>` +
    `intro <span data-href="${url}" data-type="a">${url}</span><wbr></div>`;
  const cleanKernelHTML =
    `<div data-node-id="20260101000000-gutter" data-type="NodeParagraph" class="p" updated="20260101000005">` +
    `intro <span data-type="a" data-href="${url}">${url}</span></div>`;

  const liveBlock = parseBlock(liveHTML);
  const protyle = {
    destroyed: false,
    block: { rootID: "20260101000000-rootgut", box: "notebook" },
    notebookId: "notebook",
    updateTransactionElement() { throw new Error("editor already closed"); },
  };
  const target = captureLinkTarget(liveBlock.links[0], protyle);
  assert.ok(target);
  assert.match(target.originalBlockHTML, /protyle-wysiwyg--select/);
  assert.match(target.originalBlockHTML, /<wbr>/);

  // Simulate closing tab mid-fetch -> switches to commitInactiveTitles
  protyle.destroyed = true;
  const updatePayloads = [];
  const kernel = {
    calls: [],
    async post(path, body) {
      this.calls.push(path);
      if (path === "/api/block/getBlockInfo") {
        return { data: { rootID: "20260101000000-rootgut", box: "notebook" }, code: 0 };
      }
      if (path === "/api/block/getBlockDOM") {
        return { data: { id: "20260101000000-gutter", dom: cleanKernelHTML }, code: 0 };
      }
      if (path === "/api/block/updateBlock") {
        updatePayloads.push(body);
        return { code: 0, data: null };
      }
      return { code: 0, data: {} };
    },
  };

  const result = await commitLinkTitle(target, "Gutter Background Title", { replaceTitle: true, kernel });
  assert.equal(result, "updated");
  assert.deepEqual(kernel.calls, ["/api/block/getBlockInfo", "/api/block/getBlockDOM", "/api/block/updateBlock"]);
  assert.equal(updatePayloads.length, 1);
  assert.match(updatePayloads[0].data, />Gutter Background Title<\/span>/);
  assert.match(updatePayloads[0].data, /updated="20260101000005"/);
  assert.doesNotMatch(updatePayloads[0].data, /protyle-wysiwyg--select|data-eof|data-node-index/);

  // Also verify transient-only class="" and style="" are removed cleanly in normalizeBlockForComparison
  const onlyTransientBlock = parseBlock(
    `<div data-node-id="20260101000000-emptycs" class="protyle-wysiwyg--select protyle-wysiwyg--hl" style="--b3-protyle-heading-number-width: 18px;"><span data-type="a" data-href="${url}">${url}</span></div>`,
  );
  const bareBlock = parseBlock(
    `<div data-node-id="20260101000000-emptycs"><span data-href="${url}" data-type="a">${url}</span></div>`,
  );
  assert.equal(normalizeBlockForComparison(onlyTransientBlock), normalizeBlockForComparison(bareBlock));
}));
