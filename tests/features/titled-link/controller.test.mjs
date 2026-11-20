import { test } from "node:test";
import assert from "node:assert/strict";
import { FeatureScope } from "../../../src/core/framework/FeatureScope.ts";
import { TitleCache } from "../../../src/features/titled-link/services/title-cache.ts";
import {
  AUTO_PASTE_DELAY_MS,
  TitledLinkController,
  isAutomaticLinkCandidate,
  isHttpUrl,
  mapWithConcurrency,
} from "../../../src/features/titled-link/TitledLinkController.ts";
import { DEFAULT_MAX_TITLE_LENGTH } from "../../../src/features/titled-link/policy/types.ts";

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
  removeAttribute() {}
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
    assert.ok(notices.includes('titledLink.batchSummary:{"total":1,"updated":0,"conflict":0,"failed":0,"unknown":0}'));
    assert.ok(notices.includes("titledLink.updated"));
    scope.dispose();
  } finally {
    globalThis.siyuan = prevSiyuan;
    globalThis.Element = prevElement;
  }
});

test("truncates static file names and hostname fallback at fixed limit 80, skips cache for both, and strips control chars", async () => {
  assert.equal(DEFAULT_MAX_TITLE_LENGTH, 80);
  assert.equal(AUTO_PASTE_DELAY_MS, 200);

  // 1. Static file name > 80 graphemes with replaceTitle: true and manual cache skip
  {
    const longFile = `${"a".repeat(86)}.pdf`;
    const url = `https://example.com/files/${longFile}`;
    const link = new BatchLink(url, url);
    new BatchBlock("b1", [link]);
    const protyle = { block: { rootID: "root", box: "notebook" }, notebookId: "notebook", updateTransactionElement() {} };
    const cache = new TitleCache();
    const scope = new FeatureScope();
    const controller = new TitledLinkController({
      settings: {
        getFeature: () => ({ auto: { enabled: true }, replaceTitle: true, fallbackToHostname: true }),
        getUserAgent: () => "UA",
      },
      logger: { warn() {}, debug() {} },
    }, scope, {
      frontend: () => "desktop",
      notify: () => {},
      translate: key => key,
      cache,
      fetchImpl: async () => assert.fail("static file must not fetch"),
      kernel: { post: async () => ({ data: {} }) },
    });

    assert.equal(await controller.runManual(link, protyle), "updated");
    assert.equal(link.textContent.length, 80);
    assert.equal(link.textContent, `${"a".repeat(77)}...`);
    assert.equal(link.getAttribute("data-title"), `${"a".repeat(77)}...`);
    assert.equal(cache.size, 0);
    scope.dispose();
  }

  // 2. Hostname fallback truncated at fixed length 80 and not cached
  {
    const url = `https://${"domainpart".repeat(9)}.com/page`;
    const link = new BatchLink(url, url);
    new BatchBlock("b2", [link]);
    const protyle = { block: { rootID: "root", box: "notebook" }, notebookId: "notebook", updateTransactionElement() {} };
    const cache = new TitleCache();
    const scope = new FeatureScope();
    const controller = new TitledLinkController({
      settings: {
        getFeature: () => ({ auto: { enabled: true }, replaceTitle: false, fallbackToHostname: true }),
        getUserAgent: () => "UA",
      },
      logger: { warn() {}, debug() {} },
    }, scope, {
      frontend: () => "desktop",
      notify: () => {},
      translate: key => key,
      cache,
      fetchImpl: async () => { throw new Error("network down"); },
      kernel: { post: async () => ({ data: {} }) },
    });

    assert.equal(await controller.runManual(link, protyle), "updated");
    assert.equal(link.textContent.length, 80);
    assert.equal(link.textContent, `${"domainpart".repeat(7)}domainp...`);
    assert.equal(cache.size, 0);
    scope.dispose();
  }

  // 3. Control chars & RLO stripped while newlines remain spaces through controller exit
  {
    const url = "https://example.com/bidi";
    const link = new BatchLink(url, url);
    new BatchBlock("b3", [link]);
    const protyle = { block: { rootID: "root", box: "notebook" }, notebookId: "notebook", updateTransactionElement() {} };
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
      fetchImpl: async () => htmlResponse("Hello\nWorld\u202E"),
      kernel: { post: async () => ({ data: {} }) },
    });

    assert.equal(await controller.runManual(link, protyle), "updated");
    assert.equal(link.textContent, "Hello World");
    scope.dispose();
  }
});

test("auto paste handles skip branches and synchronous fake timer without TDZ errors", async () => {
  const prevSiyuan = globalThis.siyuan;
  const prevGetSelection = globalThis.getSelection;
  const prevElement = globalThis.Element;
  try {
    class MockElement {}
    globalThis.Element = MockElement;
    globalThis.siyuan = { config: { editor: { pasteURLAutoConvert: true } } };

    const makePasteContext = (url) => {
      const anchor = new MockElement();
      const links = [];
      let currentBlock;
      const block = {
        isConnected: true,
        getAttribute: name => (name === "data-node-id" ? "b1" : null),
        querySelectorAll: selector => (selector === 'span[data-type~="a"]' ? links : []),
      };
      currentBlock = block;
      anchor.closest = selector => (selector === "[data-node-id]" ? block : null);
      globalThis.getSelection = () => ({ isCollapsed: true, anchorNode: anchor });
      const editorElement = {
        isConnected: true,
        contains: el => el === block,
        querySelector: selector => (selector === '[data-node-id="b1"]' ? currentBlock : null),
      };
      const protyle = {
        block: { rootID: "root", box: "notebook" },
        notebookId: "notebook",
        wysiwyg: { element: editorElement },
        updateTransactionElement() {},
      };
      return {
        block,
        links,
        editorElement,
        protyle,
        setCurrentBlock(next) { currentBlock = next; },
        makeLink(text = url) {
          const l = new BatchLink(url, text);
          l.block = block;
          return l;
        },
      };
    };

    // 1. Skips when block was re-rendered with an already-existing identical URL
    {
      const url = "https://example.com/rerender";
      const ctx = makePasteContext(url);
      const existing = ctx.makeLink(url);
      ctx.links.push(existing);
      let fetchCount = 0;
      const notices = [];
      let fired;
      const scope = new FeatureScope();
      const controller = new TitledLinkController({
        settings: {
          getFeature: () => ({ auto: { enabled: true }, replaceTitle: false, maxTitleLength: 80, fallbackToHostname: true }),
          getUserAgent: () => "UA",
        },
        logger: { warn() {}, debug() {} },
      }, scope, {
        frontend: () => "desktop",
        notify: m => notices.push(m),
        fetchImpl: async () => { fetchCount++; return htmlResponse("Title"); },
        kernel: { post: async () => ({ data: {} }) },
        setTimer: fn => { fired = fn; return 1; },
        clearTimer: () => {},
      });
      controller.scheduleAutoPaste({ textPlain: url, protyle: ctx.protyle });
      const newLink = ctx.makeLink(url);
      const rerendered = {
        isConnected: true,
        getAttribute: name => (name === "data-node-id" ? "b1" : null),
        querySelectorAll: selector => (selector === 'span[data-type~="a"]' ? [existing, newLink] : []),
      };
      ctx.setCurrentBlock(rerendered);
      fired();
      await Promise.resolve();
      assert.equal(fetchCount, 0);
      assert.deepEqual(notices, []);
      scope.dispose();
    }

    // 2. Does not overwrite an anchor the user retyped within the debounce window
    {
      const url = "https://example.com/retyped";
      const ctx = makePasteContext(url);
      let fetchCount = 0;
      let fired;
      const scope = new FeatureScope();
      const controller = new TitledLinkController({
        settings: {
          getFeature: () => ({ auto: { enabled: true }, replaceTitle: false, maxTitleLength: 80, fallbackToHostname: true }),
          getUserAgent: () => "UA",
        },
        logger: { warn() {}, debug() {} },
      }, scope, {
        frontend: () => "desktop",
        fetchImpl: async () => { fetchCount++; return htmlResponse("Title"); },
        kernel: { post: async () => ({ data: {} }) },
        setTimer: fn => { fired = fn; return 1; },
        clearTimer: () => {},
      });
      controller.scheduleAutoPaste({ textPlain: url, protyle: ctx.protyle });
      ctx.links.push(ctx.makeLink("My Custom Title"));
      fired();
      await Promise.resolve();
      assert.equal(fetchCount, 0);
      scope.dispose();
    }

    // 3. Exits silently when the editor is detached + synchronous fake timer does not throw TypeError
    {
      const url = "https://example.com/detached";
      const ctx = makePasteContext(url);
      ctx.editorElement.isConnected = false;
      let fetchCount = 0;
      const scope = new FeatureScope();
      const controller = new TitledLinkController({
        settings: {
          getFeature: () => ({ auto: { enabled: true }, replaceTitle: false, maxTitleLength: 80, fallbackToHostname: true }),
          getUserAgent: () => "UA",
        },
        logger: { warn() {}, debug() {} },
      }, scope, {
        frontend: () => "desktop",
        fetchImpl: async () => { fetchCount++; return htmlResponse("Title"); },
        kernel: { post: async () => ({ data: {} }) },
        setTimer: fn => { fn(); return 1; },
        clearTimer: () => {},
      });
      controller.scheduleAutoPaste({ textPlain: url, protyle: ctx.protyle });
      await Promise.resolve();
      assert.equal(fetchCount, 0);
      scope.dispose();
    }
  } finally {
    globalThis.siyuan = prevSiyuan;
    globalThis.getSelection = prevGetSelection;
    globalThis.Element = prevElement;
  }
});

test("double paste of the same url still titles at least the last link", async () => {
  const prevSiyuan = globalThis.siyuan;
  const prevGetSelection = globalThis.getSelection;
  const prevElement = globalThis.Element;
  try {
    class MockElement {}
    globalThis.Element = MockElement;
    globalThis.siyuan = { config: { editor: { pasteURLAutoConvert: true } } };

    const url = "https://example.com/double";
    const anchor = new MockElement();
    const links = [];
    const block = {
      isConnected: true,
      getAttribute: name => (name === "data-node-id" ? "b1" : null),
      querySelectorAll: selector => (selector === 'span[data-type~="a"]' ? links : []),
    };
    anchor.closest = selector => (selector === "[data-node-id]" ? block : null);
    globalThis.getSelection = () => ({ isCollapsed: true, anchorNode: anchor });
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

    const timers = [];
    let fetchCount = 0;
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
      notify: m => notices.push(m),
      fetchImpl: async () => {
        fetchCount++;
        return htmlResponse("T");
      },
      kernel: { post: async () => ({ data: {} }) },
      setTimer: fn => { timers.push(fn); return timers.length; },
      clearTimer: () => {},
    });

    controller.scheduleAutoPaste({ textPlain: url, protyle });
    controller.scheduleAutoPaste({ textPlain: url, protyle });
    const first = new BatchLink(url, url);
    const second = new BatchLink(url, url);
    first.block = block;
    second.block = block;
    links.push(first, second);

    for (const fn of timers) fn();
    for (let i = 0; i < 20 && second.textContent === url; i++) {
      await new Promise(resolve => setTimeout(resolve, 2));
    }
    assert.equal(second.textContent, "T");
    assert.equal(first.textContent, url);
    assert.equal(fetchCount, 1);
    assert.deepEqual(notices, []);
    scope.dispose();
  } finally {
    globalThis.siyuan = prevSiyuan;
    globalThis.getSelection = prevGetSelection;
    globalThis.Element = prevElement;
  }
});

test("a second manual run aborts the previous request for the same link", async () => {
  const { link, protyle } = fixture();
  const requests = [];
  const transactions = [];
  protyle.updateTransactionElement = () => transactions.push(true);
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
    fetchImpl: (_url, init) => new Promise((resolve, reject) => {
      const entry = { signal: init.signal, resolve, reject };
      requests.push(entry);
      init.signal?.addEventListener("abort", () => {
        reject(new DOMException("Aborted", "AbortError"));
      }, { once: true });
    }),
    kernel: { post: async () => ({ data: {} }) },
  });

  const first = controller.runManual(link, protyle);
  for (let i = 0; i < 20 && requests.length < 1; i++) {
    await new Promise(resolve => setTimeout(resolve, 2));
  }
  assert.equal(requests.length, 1);
  assert.equal(requests[0].signal.aborted, false);

  const second = controller.runManual(link, protyle);
  for (let i = 0; i < 20 && requests.length < 2; i++) {
    await new Promise(resolve => setTimeout(resolve, 2));
  }
  assert.equal(requests[0].signal.aborted, true);
  assert.equal(requests[1].signal.aborted, false);

  requests[1].resolve(htmlResponse("Second Wins"));
  assert.equal(await second, "updated");
  assert.equal(await first, "superseded");
  assert.equal(transactions.length, 1);
  scope.dispose();
});

test("deduplicates concurrent batch runs for the same block and emits one summary", async () => withBatchDOMParser(async () => {
  const links = [new BatchLink("https://example.com/dup-batch")];
  const block = new BatchBlock("block-dup", links);
  const protyle = {
    block: { rootID: "root", box: "notebook" },
    notebookId: "notebook",
    updateTransactionElement() {},
  };
  let releaseFetch;
  let fetchCount = 0;
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
    notify: msg => notices.push(msg),
    translate: key => key,
    fetchImpl: () => {
      fetchCount++;
      return new Promise(resolve => { releaseFetch = () => resolve(htmlResponse("Batch Title")); });
    },
    kernel: { post: async () => ({ data: { rootID: "root", box: "notebook" } }) },
  });

  const first = controller.runBatch([block], protyle);
  const second = controller.runBatch([block], protyle);
  for (let i = 0; i < 20 && !releaseFetch; i++) {
    await new Promise(resolve => setTimeout(resolve, 2));
  }
  assert.equal(fetchCount, 1);
  releaseFetch();
  await Promise.all([first, second]);
  assert.deepEqual(notices, ["titledLink.batchSummary"]);

  // After completion, the block lock is released so a subsequent batch can run
  links[0].textContent = "https://example.com/dup-batch";
  const third = controller.runBatch([block], protyle);
  for (let i = 0; i < 20 && fetchCount < 2; i++) {
    await new Promise(resolve => setTimeout(resolve, 2));
  }
  releaseFetch();
  await third;
  assert.equal(fetchCount, 2);
  scope.dispose();
}));

test("captures the block snapshot once per block in a batch", async () => withBatchDOMParser(async () => {
  const links = Array.from({ length: 5 }, (_, i) => new BatchLink(`https://example.com/${i}`));
  let snapshotCount = 0;
  const block = {
    id: "block-snap",
    links,
    isConnected: true,
    getAttribute: name => (name === "data-node-id" ? "block-snap" : null),
    removeAttribute() {},
    querySelectorAll: selector => (selector === 'span[data-type~="a"]' ? links : []),
    querySelector: () => null,
    get outerHTML() {
      snapshotCount++;
      return `<div data-node-id="block-snap">${links.map(l => l.outerHTML).join("")}</div>`;
    },
  };
  for (const l of links) l.block = block;
  const protyle = {
    block: { rootID: "root", box: "notebook" },
    notebookId: "notebook",
    updateTransactionElement() {},
  };
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
    fetchImpl: async url => htmlResponse(`Title ${url.at(-1)}`),
    kernel: { post: async () => ({ data: {} }) },
  });

  await controller.runBatch([block], protyle);
  // 1 snapshot during batch prepare + 1 oldHTML read inside commitLinkTitles active path
  assert.equal(snapshotCount, 2);
  scope.dispose();
}));

test("treats equivalent url spellings as one cache key", async () => {
  const cache = new TitleCache();
  let fetchCount = 0;
  const scope = new FeatureScope();
  const controller = new TitledLinkController({
    settings: {
      getFeature: () => ({ auto: { enabled: true }, replaceTitle: false, maxTitleLength: 80, fallbackToHostname: true }),
      getUserAgent: () => "UA",
    },
    logger: { warn() {}, debug() {} },
  }, scope, {
    frontend: () => "desktop",
    cache,
    fetchImpl: async () => { fetchCount++; return htmlResponse("Canonical Title"); },
    kernel: { post: async () => ({ data: {} }) },
  });

  const makeTarget = (href) => {
    const link = new BatchLink(href, href);
    const block = new BatchBlock("b-key", [link]);
    return {
      protyle: { block: { rootID: "root", box: "notebook" }, notebookId: "notebook", updateTransactionElement() {} },
      notebook: "notebook",
      rootID: "root",
      blockID: "b-key",
      ordinal: 0,
      linkElement: link,
      blockElement: block,
      originalHref: href,
      originalText: href,
      originalTitle: null,
      oldPath: href,
      oldValue: href,
    };
  };

  const first = await controller.titleFor(makeTarget("https://Example.com/a"), "auto");
  const second = await controller.titleFor(makeTarget("https://example.com:443/a"), "auto");
  assert.equal(first.status, "success");
  assert.equal(second.status, "success");
  assert.equal(fetchCount, 1);
  assert.equal(cache.size, 1);
  scope.dispose();
});

test("classifies http, timeout, network, aborted, challenge, and missing-title failures accurately", async () => {
  const makeTarget = (href = "https://example.com/item") => {
    const link = new BatchLink(href, href);
    const block = new BatchBlock("b-fail", [link]);
    return {
      protyle: { block: { rootID: "root", box: "notebook" }, notebookId: "notebook", updateTransactionElement() {} },
      notebook: "notebook",
      rootID: "root",
      blockID: "b-fail",
      ordinal: 0,
      linkElement: link,
      blockElement: block,
      originalHref: href,
      originalText: href,
      originalTitle: null,
      oldPath: href,
      oldValue: href,
    };
  };

  const makeController = (fetchImpl, scope = new FeatureScope()) => new TitledLinkController({
    settings: {
      getFeature: () => ({ auto: { enabled: true }, replaceTitle: false, maxTitleLength: 80, fallbackToHostname: false }),
      getUserAgent: () => "UA",
    },
    logger: { warn() {}, debug() {} },
  }, scope, {
    frontend: () => "desktop",
    fetchImpl,
    kernel: { post: async () => ({ data: {} }) },
  });

  // 1. HTTP non-2xx -> "http" + httpStatus
  {
    const c = makeController(async () => new Response("Not Found", { status: 404 }));
    const res = await c.titleFor(makeTarget(), "manual");
    assert.equal(res.status, "failure");
    assert.equal(res.reason, "http");
    assert.equal(res.httpStatus, 404);
  }

  // 2. Timeout -> "timeout"
  {
    const c = makeController(async () => { throw new DOMException("Request timed out", "TimeoutError"); });
    const res = await c.titleFor(makeTarget(), "manual");
    assert.equal(res.status, "failure");
    assert.equal(res.reason, "timeout");
  }

  // 3. Network error -> "network"
  {
    const c = makeController(async () => { throw new TypeError("Failed to fetch"); });
    const res = await c.titleFor(makeTarget(), "manual");
    assert.equal(res.status, "failure");
    assert.equal(res.reason, "network");
  }

  // 4. Aborted -> "aborted"
  {
    const scope = new FeatureScope();
    const c = makeController(async () => {
      scope.dispose();
      throw new DOMException("Aborted", "AbortError");
    }, scope);
    const res = await c.titleFor(makeTarget(), "manual");
    assert.equal(res.status, "failure");
    assert.equal(res.reason, "aborted");
  }

  // 5. Challenge page -> "challenge"
  {
    const c = makeController(async () => htmlResponse("Just a moment..."));
    const res = await c.titleFor(makeTarget(), "manual");
    assert.equal(res.status, "failure");
    assert.equal(res.reason, "challenge");
  }

  // 6. Empty HTML -> "missing-title"
  {
    const c = makeController(async () => new Response("<html><head></head></html>", {
      status: 200,
      headers: { "content-type": "text/html" },
    }));
    const res = await c.titleFor(makeTarget(), "manual");
    assert.equal(res.status, "failure");
    assert.equal(res.reason, "missing-title");
  }
});

test("manual notifications distinguish imeTimeout and unknown, and batch summary counts all four categories", async () => {
  // 1. IME timeout notice in manual mode
  {
    const link = new BatchLink("https://example.com/ime", "https://example.com/ime");
    new BatchBlock("b-ime", [link]);
    const protyle = { block: { rootID: "root", box: "notebook" }, notebookId: "notebook", updateTransactionElement() {} };
    const notices = [];
    const scope = new FeatureScope();
    const controller = new TitledLinkController({
      settings: {
        getFeature: () => ({ auto: { enabled: true }, replaceTitle: false, fallbackToHostname: false }),
        getUserAgent: () => "UA",
      },
      logger: { warn() {}, debug() {} },
    }, scope, {
      frontend: () => "desktop",
      notify: msg => notices.push(msg),
      translate: key => key,
      isComposing: () => true,
      imeTimeoutMs: 5,
      imePollMs: 1,
      fetchImpl: async () => htmlResponse("Timed Out Title"),
      kernel: { post: async () => ({ data: {} }) },
    });

    assert.equal(await controller.runManual(link, protyle), "ime-timeout");
    assert.deepEqual(notices, ["titledLink.imeTimeout"]);
    scope.dispose();
  }

  // 2. Background unknown notice in manual mode when updateBlock + re-read both fail
  {
    const prevDOMParser = globalThis.DOMParser;
    try {
      const link = new BatchLink("https://example.com/unk", "https://example.com/unk");
      const block = new BatchBlock("b-unk", [link]);
      const staleProtyle = {
        destroyed: true,
        block: { rootID: "root", box: "notebook" },
        notebookId: "notebook",
        updateTransactionElement() {},
      };
      globalThis.DOMParser = class {
        parseFromString() {
          const parsedLink = new BatchLink("https://example.com/unk", "https://example.com/unk");
          return { querySelectorAll: selector => selector === "[data-node-id]" ? [new BatchBlock("b-unk", [parsedLink])] : [] };
        }
      };

      const notices = [];
      const scope = new FeatureScope();
      let domCalls = 0;
      const controller = new TitledLinkController({
        settings: {
          getFeature: () => ({ auto: { enabled: true }, replaceTitle: false, fallbackToHostname: false }),
          getUserAgent: () => "UA",
        },
        logger: { warn() {}, debug() {} },
      }, scope, {
        frontend: () => "desktop",
        notify: msg => notices.push(msg),
        translate: key => key,
        fetchImpl: async () => htmlResponse("Fetched Title"),
        kernel: {
          async post(path) {
            if (path === "/api/block/getBlockInfo") return { data: { rootID: "root", box: "notebook" }, code: 0 };
            if (path === "/api/block/getBlockDOM") {
              domCalls += 1;
              if (domCalls === 1) return { data: { id: "b-unk", dom: block.outerHTML }, code: 0 };
              throw new Error("verify read lost");
            }
            if (path === "/api/block/updateBlock") throw new Error("write timed out");
            return { data: {}, code: 0 };
          },
        },
      });

      assert.equal(await controller.runManual(link, staleProtyle), "unknown");
      assert.deepEqual(notices, ["titledLink.unknown"]);
      scope.dispose();
    } finally {
      globalThis.DOMParser = prevDOMParser;
    }
  }

  // 3. Batch summary emits counts for updated, conflict, failed, and unknown
  {
    const prevDOMParser = globalThis.DOMParser;
    try {
      const uLink = new BatchLink("https://example.com/u", "https://example.com/u");
      const cLink = new BatchLink("https://example.com/c", "https://example.com/c");
      const fLink = new BatchLink("https://example.com/f", "https://example.com/f");
      const kLink = new BatchLink("https://example.com/k", "https://example.com/k");
      const bUpdated = new BatchBlock("b-u", [uLink]);
      const bConflict = new BatchBlock("b-c", [cLink]);
      const bFailed = new BatchBlock("b-f", [fLink]);
      const bUnknown = new BatchBlock("b-k", [kLink]);

      globalThis.DOMParser = class {
        parseFromString(html) {
          const id = html.match(/data-node-id="([^"]+)"/)?.[1];
          const match = html.match(/<span data-type="a" data-href="([^"]+)"[^>]*>(.*?)<\/span>/);
          if (!id || !match) return { querySelectorAll: () => [] };
          return {
            querySelectorAll: selector => selector === "[data-node-id]"
              ? [new BatchBlock(id, [new BatchLink(match[1], match[2])])]
              : [],
          };
        }
      };

      const notices = [];
      const scope = new FeatureScope();
      let unknownDomCalls = 0;
      const staleProtyle = {
        destroyed: true,
        block: { rootID: "root", box: "notebook" },
        notebookId: "notebook",
        updateTransactionElement() {},
      };
      const controller = new TitledLinkController({
        settings: {
          getFeature: () => ({ auto: { enabled: true }, replaceTitle: false, fallbackToHostname: false }),
          getUserAgent: () => "UA",
        },
        logger: { warn() {}, debug() {} },
      }, scope, {
        frontend: () => "desktop",
        notify: msg => notices.push(msg),
        translate: (key, values) => values ? `${key}:${JSON.stringify(values)}` : key,
        fetchImpl: async url => {
          if (String(url).endsWith("/f")) throw new Error("fetch failed");
          return htmlResponse(`Title ${url.slice(-1)}`);
        },
        kernel: {
          async post(path, body) {
            if (path === "/api/block/getBlockInfo") return { data: { rootID: "root", box: "notebook" }, code: 0 };
            if (path === "/api/block/getBlockDOM") {
              if (body.id === "b-c") {
                return { data: { id: "b-c", dom: '<div data-node-id="b-c"><span data-type="a" data-href="https://example.com/c">Changed</span></div>' }, code: 0 };
              }
              if (body.id === "b-k") {
                unknownDomCalls += 1;
                if (unknownDomCalls === 1) return { data: { id: "b-k", dom: bUnknown.outerHTML }, code: 0 };
                throw new Error("verify read failed");
              }
              if (body.id === "b-u") return { data: { id: "b-u", dom: bUpdated.outerHTML }, code: 0 };
              return { data: { id: body.id, dom: "" }, code: 0 };
            }
            if (path === "/api/block/updateBlock") {
              if (body.id === "b-k") throw new Error("write timed out");
              return { code: 0, data: null };
            }
            return { data: {}, code: 0 };
          },
        },
      });

      await controller.runBatch([bUpdated, bConflict, bFailed, bUnknown], staleProtyle);
      assert.deepEqual(notices, [
        'titledLink.batchSummary:{"total":4,"updated":1,"conflict":1,"failed":1,"unknown":1}',
      ]);
      scope.dispose();
    } finally {
      globalThis.DOMParser = prevDOMParser;
    }
  }
});
