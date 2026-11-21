import { test } from "node:test";
import assert from "node:assert/strict";
import { withBlockWriteLease } from "../../../src/core/host/BlockWriteLease.ts";
import { PROTECTED_CONTAINER_SELECTOR } from "../../../src/core/host/dom.ts";
import {
  captureLinkTarget,
  commitLinkTitle,
  commitLinkTitles,
  resolveTitledLinkProtyle,
} from "../../../src/features/titled-link/services/safe-writer.ts";

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
  closest(selector) { return selector === "[data-node-id]" ? this.block : null; }
  get outerHTML() {
    const title = this.getAttribute("data-title");
    return `<span data-type="a" data-href="${this.getAttribute("data-href")}"${title === null ? "" : ` data-title="${title}"`}>${this.textContent}</span>`;
  }
}

class BlockElement {
  constructor(id, links, prefix = "", attributes = new Map()) {
    this.id = id;
    this.links = links;
    this.prefix = prefix;
    this.attributes = attributes;
    this.isConnected = true;
    for (const link of links) link.block = this;
  }
  getAttribute(name) {
    if (name === "data-node-id") return this.id;
    return this.attributes.get(name) ?? null;
  }
  removeAttribute(name) {
    this.attributes.delete(name);
  }
  querySelectorAll(selector) {
    if (selector === 'span[data-type~="a"]') return this.links;
    if (selector === "[parent-heading]") return this.links.filter(l => l.getAttribute("parent-heading") !== null);
    if (selector === "[updated]") return this.links.filter(l => l.getAttribute("updated") !== null);
    if (selector === "[data-node-id]") return [];
    return [];
  }
  querySelector(selector) { return this.querySelectorAll(selector)[0] ?? null; }
  get outerHTML() {
    const extraAttrs = [...this.attributes.entries()].map(([k, v]) => ` ${k}="${v}"`).join("");
    return `<div data-node-id="${this.id}"${extraAttrs}>${this.prefix}${this.links.map(link => link.outerHTML).join("")}</div>`;
  }
}

function parseBlock(html) {
  const tagMatch = html.match(/<div\b([^>]*)>/);
  const attrs = tagMatch?.[1] ?? "";
  const id = attrs.match(/data-node-id="([^"]+)"/)?.[1];
  const attrMap = new Map();
  for (const [, name, value] of attrs.matchAll(/\b(updated|parent-heading)="([^"]*)"/g)) {
    attrMap.set(name, value);
  }
  const inner = html.match(/<div\b[^>]*>([\s\S]*?)<\/div>/)?.[1] ?? "";
  const firstSpan = inner.indexOf("<span");
  const prefix = firstSpan >= 0 ? inner.slice(0, firstSpan) : inner;
  const links = [...inner.matchAll(/<span data-type="a" data-href="([^"]+)"(?: data-title="([^"]*)")?>(.*?)<\/span>/g)]
    .map(match => new LinkElement(match[1], match[3], match[2] ?? null));
  return new BlockElement(id, links, prefix, attrMap);
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

test("resolveTitledLinkProtyle supports direct instance, IProtyle getInstance, and rejects invalid targets", () => {
  const direct = { updateTransactionElement() {} };
  assert.equal(resolveTitledLinkProtyle(direct), direct);

  const inner = { updateTransactionElement() {} };
  const iProtyle = { getInstance: () => inner };
  assert.equal(resolveTitledLinkProtyle(iProtyle), inner);

  const nested = { protyle: { updateTransactionElement() {} } };
  assert.equal(resolveTitledLinkProtyle(nested), nested.protyle);

  assert.equal(resolveTitledLinkProtyle(null), null);
  assert.equal(resolveTitledLinkProtyle(undefined), null);
  assert.equal(resolveTitledLinkProtyle({}), null);
  assert.equal(resolveTitledLinkProtyle({ getInstance: () => null }), null);
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
      if (path === "/api/block/getBlockInfo") return { code: -1, data: null, msg: "error" };
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
        if (path === "/api/block/updateBlock") return { code: 1, msg: "rejected", data: null };
        return { code: 0, data: {} };
      },
    };
    assert.equal(await commitLinkTitle(baseTarget, "Resolved", { replaceTitle: false, kernel }), "failed");
    assert.equal(domReads, 1);
  }

  // 6. Rejected or not-sent error thrown by KernelClient on updateBlock -> "failed" without re-reading getBlockDOM
  for (const outcome of ["rejected", "not-sent"]) {
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
    assert.equal(await commitLinkTitle(baseTarget, "Resolved", { replaceTitle: false, kernel }), "failed");
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
