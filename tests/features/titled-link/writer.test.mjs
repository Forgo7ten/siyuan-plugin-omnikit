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
  assert.deepEqual(kernel.calls, ["/api/block/getBlockInfo", "/api/block/getBlockDOM"]);
  assert.equal(transactions.length, 1);
  assert.equal(transactions[0].oldHTML, original);
  assert.match(transactions[0].newHTML, />Example<\/span>/);
}));

test("rejects live concurrent edits before any persisted read or transaction", async () => installDOMParser(async () => {
  const { links, block, protyle, transactions } = fixture();
  const target = captureLinkTarget(links[0], protyle);
  const kernel = kernelFor(block);
  block.prefix = "user typing";

  assert.equal(await commitLinkTitle(target, "Example", { replaceTitle: false, kernel }), "conflict");
  assert.equal(links[0].textContent, "https://example.com/0");
  assert.equal(kernel.calls.length, 0);
  assert.equal(transactions.length, 0);
}));

test("rejects persisted occurrence changes even when the live DOM still matches", async () => installDOMParser(async () => {
  const { links, block, protyle, transactions } = fixture();
  const target = captureLinkTarget(links[0], protyle);
  const stale = `<div data-node-id="${block.id}"><span data-type="a" data-href="https://changed.example/">changed</span></div>`;

  assert.equal(await commitLinkTitle(target, "Example", {
    replaceTitle: false,
    kernel: kernelFor(block, { dom: stale }),
  }), "conflict");
  assert.equal(transactions.length, 0);
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

test("commits same-block title updates with one persisted read and one native transaction", async () => installDOMParser(async () => {
  const { links, block, protyle, transactions } = fixture(2);
  const first = captureLinkTarget(links[0], protyle);
  const second = captureLinkTarget(links[1], protyle);
  const kernel = kernelFor(block);
  const original = block.outerHTML;

  assert.deepEqual(await commitLinkTitles([
    { target: first, title: "First" },
    { target: second, title: "Second" },
  ], { replaceTitle: false, kernel }), ["updated", "updated"]);
  assert.deepEqual(kernel.calls, ["/api/block/getBlockInfo", "/api/block/getBlockDOM"]);
  assert.equal(transactions.length, 1);
  assert.equal(transactions[0].oldHTML, original);
  assert.equal(links[0].textContent, "First");
  assert.equal(links[1].textContent, "Second");
}));

test("abandons the whole group when a persisted occurrence conflicts", async () => installDOMParser(async () => {
  const { links, block, protyle, transactions } = fixture(2);
  const first = captureLinkTarget(links[0], protyle);
  const second = captureLinkTarget(links[1], protyle);
  const stale = `<div data-node-id="${block.id}"><span data-type="a" data-href="${links[0].getAttribute("data-href")}">${links[0].textContent}</span><span data-type="a" data-href="https://changed.example/">changed</span></div>`;

  assert.deepEqual(await commitLinkTitles([
    { target: first, title: "First" },
    { target: second, title: "Second" },
  ], { replaceTitle: false, kernel: kernelFor(block, { dom: stale }) }), ["conflict", "conflict"]);
  assert.equal(transactions.length, 0);
  assert.equal(links[0].textContent, "https://example.com/0");
  assert.equal(links[1].textContent, "https://example.com/1");
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

test("safely handles kernel network failures in verifyPersisted as conflict", async () => installDOMParser(async () => {
  const { links, block, protyle, transactions } = fixture();
  const target = captureLinkTarget(links[0], protyle);
  const throwingKernel = {
    post: async () => { throw new Error("Network timeout or connection refused"); },
  };
  const result = await commitLinkTitle(target, "Example", { replaceTitle: false, kernel: throwingKernel });
  assert.equal(result, "conflict");
  assert.equal(transactions.length, 0);
}));

test("safely propagates AbortError during verifyPersisted as aborted", async () => installDOMParser(async () => {
  const { links, block, protyle, transactions } = fixture();
  const target = captureLinkTarget(links[0], protyle);
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
  assert.equal(transactions.length, 0);
}));
