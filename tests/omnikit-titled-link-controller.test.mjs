import { test } from "node:test";
import assert from "node:assert/strict";
import { FeatureScope } from "../src/core/FeatureScope.ts";
import {
  TitledLinkController, isAutomaticLinkCandidate, isHttpUrl, mapWithConcurrency,
} from "../src/features/titled-link/TitledLinkController.ts";

test("automatic admission accepts only an empty or exact URL anchor", () => {
  assert.equal(isAutomaticLinkCandidate("", "https://example.com"), true);
  assert.equal(isAutomaticLinkCandidate("https://example.com", "https://example.com"), true);
  assert.equal(isAutomaticLinkCandidate("My title", "https://example.com"), false);
  assert.equal(isHttpUrl("https://example.com"), true);
  assert.equal(isHttpUrl("mailto:a@example.com"), false);
  assert.equal(isHttpUrl("javascript:alert(1)"), false);
});

test("batch worker pool never exceeds three active requests", async () => {
  let active = 0;
  let peak = 0;
  const result = await mapWithConcurrency([1, 2, 3, 4, 5], 3, async value => {
    active++;
    peak = Math.max(peak, active);
    await new Promise(resolve => setTimeout(resolve, 5));
    active--;
    return value * 2;
  });
  assert.equal(peak, 3);
  assert.deepEqual(result, [2, 4, 6, 8, 10]);
});

function fixture() {
  const url = "https://example.com/page";
  const link = {
    isConnected: true,
    textContent: url,
    getAttribute(name) { return { "data-type": "a", "data-href": url }[name] ?? null; },
    closest(selector) { return selector === "[data-node-id]" ? block : null; },
  };
  const block = {
    isConnected: true,
    outerHTML: '<div data-node-id="block"><span data-type="a">URL</span></div>',
    getAttribute(name) { return name === "data-node-id" ? "block" : null; },
    querySelectorAll(selector) { return selector === 'span[data-type~="a"]' ? [link] : []; },
  };
  const protyle = {
    block: { rootID: "root", box: "notebook" }, notebookId: "notebook",
    updateTransactionElement() {},
  };
  return { link, block, protyle, url };
}

function htmlResponse(title) {
  const bytes = new TextEncoder().encode(`<html><head><title>${title}</title></head></html>`);
  return {
    ok: true, status: 200, headers: { get: () => "text/html; charset=utf-8" },
    body: new ReadableStream({ start(controller) { controller.enqueue(bytes); controller.close(); } }),
  };
}

test("a newer manual request suppresses an older response and its notification", async () => {
  const { link, protyle } = fixture();
  const deferred = [];
  const notices = [];
  const scope = new FeatureScope();
  const controller = new TitledLinkController({
    settings: {
      getFeature: () => ({ auto: { enabled: true }, replaceTitle: false, maxTitleLength: 80, fallbackToHostname: true }),
      getUserAgent: () => "UA",
    },
    logger: { warn() {} },
  }, scope, {
    frontend: () => "desktop",
    notify: message => notices.push(message),
    translate: key => key,
    fetchImpl: () => new Promise(resolve => deferred.push(resolve)),
    kernel: { post: async () => ({ data: { rootID: "different", box: "notebook" } }) },
  });

  const older = controller.runManual(link, protyle);
  const newer = controller.runManual(link, protyle);
  for (let attempt = 0; attempt < 20 && deferred.length < 2; attempt++) {
    await new Promise(resolve => setTimeout(resolve, 2));
  }
  assert.equal(deferred.length, 2);
  deferred[1](htmlResponse("New title"));
  assert.equal(await newer, "conflict");
  deferred[0](htmlResponse("Old title"));
  assert.equal(await older, "superseded");
  assert.deepEqual(notices, ["titledLink.conflict"]);
  scope.dispose();
});

class BatchLink {
  constructor(href, text = href) {
    this.href = href;
    this.textContent = text;
    this.attributes = new Map([["data-type", "a"], ["data-href", href]]);
    this.isConnected = true;
    this.block = undefined;
  }
  getAttribute(name) { return this.attributes.get(name) ?? null; }
  setAttribute(name, value) { this.attributes.set(name, String(value)); }
  removeAttribute(name) { this.attributes.delete(name); }
  closest(selector) { return selector === "[data-node-id]" ? this.block : null; }
  get outerHTML() {
    const title = this.getAttribute("data-title");
    return `<span data-type="a" data-href="${this.href}"${title === null ? "" : ` data-title="${title}"`}>${this.textContent}</span>`;
  }
}

class BatchBlock {
  constructor(id, links) {
    this.id = id;
    this.links = links;
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
  get outerHTML() {
    return `<div data-node-id="${this.id}">${this.links.map(link => link.outerHTML).join("")}</div>`;
  }
}

function batchBlockFromHTML(html) {
  const id = html.match(/data-node-id="([^"]+)"/)?.[1] ?? "";
  const links = [...html.matchAll(/<span data-type="a" data-href="([^"]+)"(?: data-title="([^"]*)")?>(.*?)<\/span>/g)]
    .map(match => {
      const link = new BatchLink(match[1], match[3]);
      if (match[2] !== undefined) link.setAttribute("data-title", match[2]);
      return link;
    });
  return new BatchBlock(id, links);
}

async function withBatchDOMParser(run) {
  const previous = globalThis.DOMParser;
  globalThis.DOMParser = class {
    parseFromString(html) {
      const block = batchBlockFromHTML(html);
      return {
        querySelectorAll: selector => selector === "[data-node-id]" ? [block] : [],
      };
    }
  };
  try { return await run(); } finally { globalThis.DOMParser = previous; }
}

test("batch updates links in one block with one native transaction and one summary", async () => withBatchDOMParser(async () => {
  const links = [
    new BatchLink("https://example.com/first"),
    new BatchLink("https://example.com/second"),
  ];
  const block = new BatchBlock("block", links);
  const transactions = [];
  const protyle = {
    block: { rootID: "root", box: "notebook" }, notebookId: "notebook",
    updateTransactionElement(element, oldHTML) {
      transactions.push({ element, oldHTML, newHTML: element.outerHTML });
    },
  };
  const notices = [];
  const scope = new FeatureScope();
  const controller = new TitledLinkController({
    settings: {
      getFeature: () => ({ auto: { enabled: true }, replaceTitle: false, maxTitleLength: 80, fallbackToHostname: true }),
      getUserAgent: () => "UA",
    },
    logger: { warn() {} },
  }, scope, {
    frontend: () => "desktop",
    notify: message => notices.push(message),
    translate: key => key,
    fetchImpl: async url => htmlResponse(url.endsWith("first") ? "First title" : "Second title"),
    kernel: {
      post: async path => path === "/api/block/getBlockInfo"
        ? { data: { rootID: "root", box: "notebook" } }
        : { data: { id: "block", dom: block.outerHTML } },
    },
  });

  await controller.runBatch([block], protyle);

  assert.equal(transactions.length, 1);
  assert.equal(links[0].textContent, "First title");
  assert.equal(links[1].textContent, "Second title");
  assert.deepEqual(notices, ["titledLink.batchSummary"]);
  scope.dispose();
}));

test("batch mode reuses in-flight request for duplicate URLs", async () => withBatchDOMParser(async () => {
  const links = [
    new BatchLink("https://example.com/same"),
    new BatchLink("https://example.com/same"),
  ];
  const block = new BatchBlock("block", links);
  let fetchCount = 0;
  const scope = new FeatureScope();
  const controller = new TitledLinkController({
    settings: {
      getFeature: () => ({ auto: { enabled: true }, replaceTitle: false, maxTitleLength: 80, fallbackToHostname: true }),
      getUserAgent: () => "UA",
    },
    logger: { warn() {} },
  }, scope, {
    frontend: () => "desktop",
    notify: () => {},
    translate: key => key,
    fetchImpl: async () => {
      fetchCount++;
      await new Promise(resolve => setTimeout(resolve, 5));
      return htmlResponse("Shared Title");
    },
    kernel: {
      post: async path => path === "/api/block/getBlockInfo"
        ? { data: { rootID: "root", box: "notebook" } }
        : { data: { id: "block", dom: block.outerHTML } },
    },
  });

  const protyle = {
    block: { rootID: "root", box: "notebook" }, notebookId: "notebook",
    updateTransactionElement() {},
  };

  await controller.runBatch([block], protyle);
  assert.equal(fetchCount, 1, "Duplicate URLs in batch must share a single in-flight network request");
  assert.equal(links[0].textContent, "Shared Title");
  assert.equal(links[1].textContent, "Shared Title");
  scope.dispose();
}));
