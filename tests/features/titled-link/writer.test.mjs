import { test } from "node:test";
import assert from "node:assert/strict";
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
  constructor(id, links, prefix = "") {
    this.id = id;
    this.links = links;
    this.prefix = prefix;
    this.isConnected = true;
    for (const link of links) link.block = this;
  }
  getAttribute(name) { return name === "data-node-id" ? this.id : null; }
  querySelectorAll(selector) {
    if (selector === 'span[data-type~="a"]') return this.links;
    if (selector === "[data-node-id]") return [];
    return [];
  }
  querySelector(selector) { return this.querySelectorAll(selector)[0] ?? null; }
  get outerHTML() { return `<div data-node-id="${this.id}">${this.prefix}${this.links.map(link => link.outerHTML).join("")}</div>`; }
}

function parseBlock(html) {
  const id = html.match(/data-node-id="([^"]+)"/)?.[1];
  const links = [...html.matchAll(/<span data-type="a" data-href="([^"]+)"(?: data-title="([^"]*)")?>(.*?)<\/span>/g)]
    .map(match => new LinkElement(match[1], match[3], match[2] ?? null));
  return new BlockElement(id, links);
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

test("waits for IME composition and aborts safely on timeout or signal", async () => installDOMParser(async () => {
  const first = fixture();
  const target = captureLinkTarget(first.links[0], first.protyle);
  assert.equal(await commitLinkTitle(target, "Example", {
    replaceTitle: false,
    isComposing: () => true,
    imeTimeoutMs: 5,
    imePollMs: 1,
  }), "conflict");
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

test("safely handles kernel network failures in non-active mode as conflict", async () => installDOMParser(async () => {
  const { links, block, protyle } = fixture();
  const target = { ...captureLinkTarget(links[0], protyle), protyle: null };
  const throwingKernel = {
    post: async () => { throw new Error("Network timeout or connection refused"); },
  };
  const result = await commitLinkTitle(target, "Example", { replaceTitle: false, kernel: throwingKernel });
  assert.equal(result, "conflict");
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
    assert.equal(result, "conflict");
    assert.equal(link.textContent, "https://example.com/0");
    assert.equal(appliedRanges.length, 2);
    assert.equal(appliedRanges[1].node, textNode);
    assert.equal(appliedRanges[1].offset, 8);
  } finally {
    globalThis.getSelection = prevSelection;
    globalThis.document = prevDocument;
  }
}));
