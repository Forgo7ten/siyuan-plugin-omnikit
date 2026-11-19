import { test } from "node:test";
import assert from "node:assert/strict";
import { FeatureScope } from "../../../src/core/framework/FeatureScope.ts";
import { TitleCache } from "../../../src/features/titled-link/services/title-cache.ts";
import {
  TitledLinkController, isAutomaticLinkCandidate, isHttpUrl, mapWithConcurrency,
} from "../../../src/features/titled-link/TitledLinkController.ts";

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
  assert.equal(await newer, "updated");
  deferred[0](htmlResponse("Old title"));
  assert.equal(await older, "superseded");
  assert.deepEqual(notices, ["titledLink.updated"]);
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

test("manual execution succeeds with SiYuan IProtyle wrapper and notifies success", async () => withBatchDOMParser(async () => {
  const links = [new BatchLink("https://example.com/page", "https://example.com/page")];
  const block = new BatchBlock("block", links);
  const notices = [];
  const debugLogs = [];
  const transactions = [];
  const runner = {
    updateTransactionElement(element, oldHTML) {
      transactions.push({ element, oldHTML });
    },
  };
  const iProtyle = {
    block: { rootID: "root", box: "notebook" },
    getInstance() { return runner; },
  };
  const scope = new FeatureScope();
  const controller = new TitledLinkController({
    settings: {
      getFeature: () => ({ auto: { enabled: true }, replaceTitle: false, maxTitleLength: 80, fallbackToHostname: true }),
      getUserAgent: () => "UA",
    },
    logger: {
      warn() {},
      debug(message, meta) { debugLogs.push({ message, meta }); },
    },
  }, scope, {
    frontend: () => "desktop",
    notify: message => notices.push(message),
    translate: key => key,
    fetchImpl: async () => htmlResponse("Fetched Title"),
    kernel: {
      post: async path => path === "/api/block/getBlockInfo"
        ? { data: { rootID: "root", box: "notebook" } }
        : { data: { id: "block", dom: block.outerHTML } },
    },
  });

  const result = await controller.runManual(links[0], iProtyle);
  assert.equal(result, "updated");
  assert.equal(transactions.length, 1);
  assert.equal(links[0].textContent, "Fetched Title");
  assert.deepEqual(notices, ["titledLink.updated"]);
  assert.ok(debugLogs.some(log => log.message === "手动触发提取链接标题"));
  assert.ok(debugLogs.some(log => log.message === "开始处理链接标题"));
  assert.ok(debugLogs.some(log => log.message === "链接标题写入完成"));
  scope.dispose();
}));

test("manual execution warns and notifies failed when target cannot be captured", async () => {
  const disconnectedLink = {
    isConnected: false,
    textContent: "https://example.com/page",
    getAttribute: () => "https://example.com/page",
    closest: () => null,
  };
  const notices = [];
  const warnings = [];
  const scope = new FeatureScope();
  const controller = new TitledLinkController({
    settings: {
      getFeature: () => ({ auto: { enabled: true }, replaceTitle: false, maxTitleLength: 80, fallbackToHostname: true }),
      getUserAgent: () => "UA",
    },
    logger: {
      warn(message, meta) { warnings.push({ message, meta }); },
      debug() {},
    },
  }, scope, {
    frontend: () => "desktop",
    notify: message => notices.push(message),
    translate: key => key,
    fetchImpl: async () => htmlResponse("Title"),
    kernel: { post: async () => ({ data: {} }) },
  });

  const result = await controller.runManual(disconnectedLink, {});
  assert.equal(result, "failed");
  assert.deepEqual(notices, ["titledLink.failed"]);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0].message, /无法捕获链接目标信息/);
  assert.equal(warnings[0].meta.hasBlock, false);
  assert.equal(warnings[0].meta.hasUpdateTransaction, false);
  scope.dispose();
});

test("manual execution notifies failed when URL is not HTTP(S)", async () => {
  const jsLink = {
    isConnected: true,
    textContent: "javascript:void(0)",
    getAttribute(name) { return { "data-type": "a", "data-href": "javascript:void(0)" }[name] ?? null; },
    closest(selector) { return selector === "[data-node-id]" ? block : null; },
  };
  const block = {
    isConnected: true,
    outerHTML: '<div data-node-id="block"><span data-type="a" data-href="javascript:void(0)">javascript:void(0)</span></div>',
    getAttribute(name) { return name === "data-node-id" ? "block" : null; },
    querySelectorAll(selector) { return selector === 'span[data-type~="a"]' ? [jsLink] : []; },
  };
  const protyle = {
    block: { rootID: "root", box: "notebook" },
    notebookId: "notebook",
    updateTransactionElement() {},
  };
  const notices = [];
  const scope = new FeatureScope();
  const controller = new TitledLinkController({
    settings: {
      getFeature: () => ({ auto: { enabled: true }, replaceTitle: false, maxTitleLength: 80, fallbackToHostname: true }),
      getUserAgent: () => "UA",
    },
    logger: { warn() {}, debug() {} },
  }, scope, {
    frontend: () => "desktop",
    notify: message => notices.push(message),
    translate: key => key,
    fetchImpl: async () => htmlResponse("Title"),
    kernel: { post: async () => ({ data: {} }) },
  });

  const result = await controller.runManual(jsLink, protyle);
  assert.equal(result, "failed");
  assert.deepEqual(notices, ["titledLink.failed"]);
  scope.dispose();
});

test("batch captures snapshots synchronously before concurrency queue so >3 links tolerate concurrent typing", async () => withBatchDOMParser(async () => {
  const links = Array.from({ length: 5 }, (_, index) => new BatchLink(`https://example.com/${index}`));
  let prefix = "";
  const block = {
    id: "block",
    links,
    isConnected: true,
    getAttribute(name) { return name === "data-node-id" ? this.id : null; },
    querySelectorAll(selector) { return selector === 'span[data-type~="a"]' ? this.links : []; },
    querySelector(selector) { return this.querySelectorAll(selector)[0] ?? null; },
    get outerHTML() { return `<div data-node-id="${this.id}">${prefix}${this.links.map(l => l.outerHTML).join("")}</div>`; },
  };
  for (const link of links) link.block = block;

  const transactions = [];
  const protyle = {
    block: { rootID: "root", box: "notebook" },
    notebookId: "notebook",
    updateTransactionElement(element, oldHTML) { transactions.push({ element, oldHTML, newHTML: element.outerHTML }); },
  };
  const deferred = [];
  const notices = [];
  const scope = new FeatureScope();
  const controller = new TitledLinkController({
    settings: {
      getFeature: () => ({ auto: { enabled: true }, replaceTitle: false, maxTitleLength: 80, fallbackToHostname: true }),
      getUserAgent: () => "UA",
    },
    logger: { warn() {}, debug() {} },
  }, scope, {
    frontend: () => "desktop",
    notify: message => notices.push(message),
    translate: key => key,
    fetchImpl: url => new Promise(resolve => deferred.push({ url, resolve })),
    kernel: { post: async () => ({ data: { rootID: "root", box: "notebook" } }) },
  });

  const batchPromise = controller.runBatch([block], protyle);
  for (let attempt = 0; attempt < 20 && deferred.length < 3; attempt++) {
    await new Promise(resolve => setTimeout(resolve, 2));
  }
  assert.equal(deferred.length, 3);

  // User types in the block while links 4 and 5 are still waiting in the concurrency queue
  prefix = "user typed ";
  for (let i = 0; i < 3; i++) {
    deferred[i].resolve(htmlResponse(`Title ${i}`));
  }
  for (let attempt = 0; attempt < 20 && deferred.length < 5; attempt++) {
    await new Promise(resolve => setTimeout(resolve, 2));
  }
  assert.equal(deferred.length, 5);
  deferred[3].resolve(htmlResponse("Title 3"));
  deferred[4].resolve(htmlResponse("Title 4"));

  await batchPromise;
  assert.equal(transactions.length, 1);
  assert.match(transactions[0].oldHTML, /user typed /);
  for (let i = 0; i < 5; i++) {
    assert.equal(links[i].textContent, `Title ${i}`);
  }
  assert.deepEqual(notices, ["titledLink.batchSummary"]);
  scope.dispose();
}));

test("fallback hostname results are never written to TitleCache in manual or auto mode", async () => {
  const prevSiyuan = globalThis.siyuan;
  const prevGetSelection = globalThis.getSelection;
  const prevElement = globalThis.Element;
  try {
    // 1. Manual fallback does not write to cache
    {
      const { link, protyle, url } = fixture();
      const cache = new TitleCache();
      const notices = [];
      const scope = new FeatureScope();
      const controller = new TitledLinkController({
        settings: {
          getFeature: () => ({ auto: { enabled: true }, replaceTitle: false, maxTitleLength: 80, fallbackToHostname: true }),
          getUserAgent: () => "UA",
        },
        logger: { warn() {}, debug() {} },
      }, scope, {
        frontend: () => "desktop",
        notify: message => notices.push(message),
        translate: key => key,
        cache,
        fetchImpl: async () => { throw new Error("network down"); },
        kernel: { post: async () => ({ data: {} }) },
      });

      const result = await controller.runManual(link, protyle);
      assert.equal(result, "updated");
      assert.equal(link.textContent, "example.com");
      assert.deepEqual(notices, ["titledLink.fallbackUsed"]);
      assert.equal(cache.get(url), undefined);
      assert.equal(cache.size, 0);
      scope.dispose();
    }

    // 2. Auto fallback does not write to cache, allowing subsequent paste to fetch real title
    {
      class MockElement {}
      globalThis.Element = MockElement;
      globalThis.siyuan = { config: { editor: { pasteURLAutoConvert: true } } };

      const url = "https://example.com/auto-fallback";
      const anchor = new MockElement();
      const links = [];
      const block = {
        isConnected: true,
        outerHTML: '<div data-node-id="b1"></div>',
        getAttribute: name => (name === "data-node-id" ? "b1" : null),
        querySelectorAll: selector => (selector === 'span[data-type~="a"]' ? links : []),
      };
      anchor.closest = selector => (selector === "[data-node-id]" ? block : null);
      globalThis.getSelection = () => ({ isCollapsed: true, anchorNode: anchor });

      const link = {
        isConnected: true,
        textContent: url,
        getAttribute: name => ({ "data-type": "a", "data-href": url }[name] ?? null),
        closest: selector => (selector === "[data-node-id]" ? block : null),
      };
      const protyle = {
        block: { rootID: "root", box: "notebook" },
        notebookId: "notebook",
        wysiwyg: {
          element: {
            isConnected: true,
            contains: el => el === block,
            querySelector: selector => (selector === '[data-node-id="b1"]' ? block : null),
          },
        },
        updateTransactionElement() {},
      };

      const cache = new TitleCache();
      let shouldFail = true;
      const scope = new FeatureScope();
      const controller = new TitledLinkController({
        settings: {
          getFeature: () => ({ auto: { enabled: true }, replaceTitle: false, maxTitleLength: 80, fallbackToHostname: true }),
          getUserAgent: () => "UA",
        },
        logger: { warn() {}, debug() {} },
      }, scope, {
        frontend: () => "desktop",
        notify: () => {},
        translate: key => key,
        cache,
        fetchImpl: async () => {
          if (shouldFail) throw new Error("temporary failure");
          return htmlResponse("Recovered Real Title");
        },
        kernel: { post: async () => ({ data: {} }) },
      });

      controller.scheduleAutoPaste({ textPlain: url, protyle });
      links.push(link);
      await new Promise(resolve => setTimeout(resolve, 230));
      assert.equal(link.textContent, "example.com");
      assert.equal(cache.get(url), undefined);
      assert.equal(cache.size, 0);

      // Reset link text and paste again when network recovers
      shouldFail = false;
      const secondLink = {
        isConnected: true,
        textContent: url,
        getAttribute: name => ({ "data-type": "a", "data-href": url }[name] ?? null),
        closest: selector => (selector === "[data-node-id]" ? block : null),
      };
      controller.scheduleAutoPaste({ textPlain: url, protyle });
      links.push(secondLink);
      await new Promise(resolve => setTimeout(resolve, 230));
      assert.equal(secondLink.textContent, "Recovered Real Title");
      assert.equal(cache.get(url), "Recovered Real Title");
      scope.dispose();
    }
  } finally {
    globalThis.siyuan = prevSiyuan;
    globalThis.getSelection = prevGetSelection;
    globalThis.Element = prevElement;
  }
});

test("manual request during IME wait supersedes queued batch write inside write lease", async () => {
  const prevSiyuan = globalThis.siyuan;
  const prevElement = globalThis.Element;
  try {
    globalThis.Element = class {};
    globalThis.siyuan = { config: { editor: { markdown: { autoSpace: false } } } };

    let link;
    const links = [];
    const block = {
      getAttribute: name => (name === "data-node-id" ? "20260101000000-blockime" : null),
      querySelectorAll: selector => (selector === 'span[data-type~="a"]' ? links : []),
      querySelector: () => null,
      get outerHTML() { return `<div data-node-id="20260101000000-blockime">${link.textContent}</div>`; },
    };
    const url = "https://example.com/ime-race";
    link = {
      isConnected: true,
      textContent: url,
      getAttribute: name => ({ "data-type": "a", "data-href": url }[name] ?? null),
      setAttribute() {},
      removeAttribute() {},
      closest: selector => (selector === "[data-node-id]" ? block : null),
    };
    links.push(link);

    const transactions = [];
    const protyle = {
      block: { rootID: "root", box: "notebook" },
      notebookId: "notebook",
      updateTransactionElement(_el, oldHTML) { transactions.push({ oldHTML, text: link.textContent }); },
    };

    let composing = false;
    let manualStarted = false;
    const scope = new FeatureScope();
    const notices = [];
    const controller = new TitledLinkController({
      settings: {
        getFeature: () => ({ auto: { enabled: true }, replaceTitle: false, maxTitleLength: 80, fallbackToHostname: true }),
        getUserAgent: () => "UA",
      },
      logger: { warn() {}, debug() {} },
    }, scope, {
      frontend: () => "desktop",
      notify: msg => notices.push(msg),
      translate: (key, values) => values ? `${key}:${JSON.stringify(values)}` : key,
      isComposing: () => composing,
      fetchImpl: async () => {
        if (!manualStarted) {
          composing = true;
          return htmlResponse("Old Batch Title");
        }
        return htmlResponse("Fresh Manual Title");
      },
      kernel: { post: async () => ({ data: { rootID: "root", box: "notebook" } }) },
    });

    const batchPromise = controller.runBatch([block], protyle);
    await new Promise(resolve => setTimeout(resolve, 15));
    manualStarted = true;
    const manualPromise = controller.runManual(link, protyle);
    await new Promise(resolve => setTimeout(resolve, 10));
    composing = false;
    const [, manualResult] = await Promise.all([batchPromise, manualPromise]);

    assert.equal(manualResult, "updated");
    assert.equal(link.textContent, "Fresh Manual Title");
    assert.equal(transactions.length, 1);
    assert.equal(transactions[0].text, "Fresh Manual Title");
    assert.ok(notices.includes('titledLink.batchSummary:{"total":1,"updated":0,"skipped":1}'));
    assert.ok(notices.includes("titledLink.updated"));
    scope.dispose();
  } finally {
    globalThis.siyuan = prevSiyuan;
    globalThis.Element = prevElement;
  }
});
