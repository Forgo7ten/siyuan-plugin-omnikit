import { test } from "node:test";
import assert from "node:assert/strict";
import { FeatureScope } from "../../../src/core/framework/FeatureScope.ts";
import { TitleCache } from "../../../src/features/titled-link/services/title-cache.ts";
import { countBatchResults, formatBatchSummary } from "../../../src/features/titled-link/policy/batchSummary.ts";
import { isAutomaticLinkCandidate, isHttpUrl } from "../../../src/features/titled-link/policy/paste-range.ts";
import {
  TitledLinkController,
  mapWithConcurrency,
} from "../../../src/features/titled-link/TitledLinkController.ts";
import { DEFAULT_MAX_TITLE_LENGTH } from "../../../src/features/titled-link/policy/types.ts";

test("automatic admission accepts empty, exact URL, and percent-decoded bare URL anchors", () => {
  assert.equal(isAutomaticLinkCandidate("", "https://example.com"), true);
  assert.equal(isAutomaticLinkCandidate("https://example.com", "https://example.com"), true);
  assert.equal(
    isAutomaticLinkCandidate("https://example.com/wiki/测试", "https://example.com/wiki/%E6%B5%8B%E8%AF%95"),
    true,
  );
  assert.equal(
    isAutomaticLinkCandidate("https://example.com/a/b", "https://example.com/a%2Fb"),
    true,
  );
  assert.equal(isAutomaticLinkCandidate("自定义标题", "https://example.com/wiki/%E6%B5%8B%E8%AF%95"), false);
  assert.equal(isAutomaticLinkCandidate("bad", "https://example.com/%E0%A4%A"), false);
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
      getFeature: () => ({ auto: { enabled: true }, replaceTitle: false, fallbackToHostname: true }),
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
  getAttributeNames() { return [...this.attributes.keys()]; }
  cloneNode() {
    const copy = new BatchLink(this.href, this.textContent);
    copy.attributes = new Map(this.attributes);
    return copy;
  }
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
  setAttribute(name, value) { if (name === "data-node-id") this.id = String(value); }
  removeAttribute() {}
  getAttributeNames() { return ["data-node-id"]; }
  cloneNode() {
    return new BatchBlock(this.id, this.links.map(link => link.cloneNode()));
  }
  querySelectorAll(selector) {
    if (selector === 'span[data-type~="a"]' || selector === "*") return this.links;
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
      getFeature: () => ({ auto: { enabled: true }, replaceTitle: false, fallbackToHostname: true }),
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
      getFeature: () => ({ auto: { enabled: true }, replaceTitle: false, fallbackToHostname: true }),
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
      getFeature: () => ({ auto: { enabled: true }, replaceTitle: false, fallbackToHostname: true }),
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
      getFeature: () => ({ auto: { enabled: true }, replaceTitle: false, fallbackToHostname: true }),
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
      getFeature: () => ({ auto: { enabled: true }, replaceTitle: false, fallbackToHostname: true }),
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
      getFeature: () => ({ auto: { enabled: true }, replaceTitle: false, fallbackToHostname: true }),
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
          getFeature: () => ({ auto: { enabled: true }, replaceTitle: false, fallbackToHostname: true }),
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
      const url = "https://example.com/auto-fallback";
      const link = new BatchLink(url, url);
      const block = new BatchBlock("b1", [link]);
      const protyle = {
        block: { rootID: "root", box: "notebook" },
        notebookId: "notebook",
        updateTransactionElement() {},
      };

      const cache = new TitleCache();
      const notices = [];
      let shouldFail = true;
      const scope = new FeatureScope();
      const controller = new TitledLinkController({
        settings: {
          getFeature: () => ({ auto: { enabled: true }, replaceTitle: false, fallbackToHostname: true }),
          getUserAgent: () => "UA",
        },
        logger: { warn() {}, debug() {} },
      }, scope, {
        frontend: () => "desktop",
        notify: msg => notices.push(msg),
        translate: key => key,
        cache,
        fetchImpl: async () => {
          if (shouldFail) throw new Error("temporary failure");
          return htmlResponse("Recovered Real Title");
        },
        kernel: { post: async () => ({ data: {} }) },
      });

      await controller.runAutoPaste([link], protyle);
      assert.equal(link.textContent, "example.com");
      assert.equal(cache.get(url), undefined);
      assert.equal(cache.size, 0);
      assert.deepEqual(notices, ["titledLink.fallbackUsed"]);

      // Paste again when network recovers
      shouldFail = false;
      const secondLink = new BatchLink(url, url);
      secondLink.block = block;
      block.links.push(secondLink);
      await controller.runAutoPaste([secondLink], protyle);
      assert.equal(secondLink.textContent, "Recovered Real Title");
      assert.equal(cache.get(url), "Recovered Real Title");
      assert.deepEqual(notices, ["titledLink.fallbackUsed", "titledLink.updated"]);
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
        getFeature: () => ({ auto: { enabled: true }, replaceTitle: false, fallbackToHostname: true }),
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
    assert.deepEqual(notices, ["titledLink.updated"]);
    scope.dispose();
  } finally {
    globalThis.siyuan = prevSiyuan;
    globalThis.Element = prevElement;
  }
});

test("truncates static file names and hostname fallback at fixed limit 80, skips cache for both, and strips control chars", async () => {
  assert.equal(DEFAULT_MAX_TITLE_LENGTH, 80);

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
        getFeature: () => ({ auto: { enabled: true }, replaceTitle: false, fallbackToHostname: true }),
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

test("runAutoPaste handles single-link notices, multi-link batch summary, silent disabled/skipped rules, and consecutive pastes", async () => withBatchDOMParser(async () => {
  // 1. Single-link auto paste uses single-link notification keys (updated, unchanged, conflict, unknown, imeTimeout, failed)
  {
    const url = "https://example.com/single-auto";
    const link = new BatchLink(url, url);
    new BatchBlock("b-single", [link]);
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
      notify: m => notices.push(m),
      translate: (key, values) => values ? `${key}:${JSON.stringify(values)}` : key,
      fetchImpl: async () => htmlResponse("Single Auto Title"),
      kernel: { post: async () => ({ data: {} }) },
    });

    await controller.runAutoPaste([link], protyle);
    assert.equal(link.textContent, "Single Auto Title");
    assert.deepEqual(notices, ["titledLink.updated"]);
    scope.dispose();
  }

  // 2. Single-link auto paste maps unchanged, conflict, unknown, ime-timeout, and failed accurately
  {
    const makeSingleCase = async (setup) => {
      const link = new BatchLink("https://example.com/map", setup.initialText ?? "https://example.com/map");
      const block = new BatchBlock("b-map", [link]);
      const notices = [];
      const scope = new FeatureScope();
      const protyle = setup.protyle ?? {
        block: { rootID: "root", box: "notebook" },
        notebookId: "notebook",
        updateTransactionElement: setup.updateTransactionElement ?? (() => {}),
      };
      const controller = new TitledLinkController({
        settings: {
          getFeature: () => ({ auto: { enabled: true }, replaceTitle: false, fallbackToHostname: false }),
          getUserAgent: () => "UA",
        },
        logger: { warn() {}, debug() {} },
      }, scope, {
        frontend: () => "desktop",
        notify: m => notices.push(m),
        translate: key => key,
        isComposing: setup.isComposing,
        imeTimeoutMs: 5,
        imePollMs: 1,
        fetchImpl: setup.fetchImpl ?? (async () => htmlResponse("Mapped Title")),
        kernel: setup.kernel ?? { post: async () => ({ data: {} }) },
      });
      await controller.runAutoPaste([link], protyle);
      scope.dispose();
      return notices;
    };

    assert.deepEqual(await makeSingleCase({ initialText: "" , fetchImpl: async () => htmlResponse("Mapped Title") }), ["titledLink.updated"]);
    assert.deepEqual(await makeSingleCase({
      initialText: "",
      fetchImpl: async () => { throw new Error("network"); },
    }), ["titledLink.failed"]);
    assert.deepEqual(await makeSingleCase({
      isComposing: () => true,
    }), ["titledLink.imeTimeout"]);
    assert.deepEqual(await makeSingleCase({
      fetchImpl: async (url) => htmlResponse(url), // unchanged: title === originalText
    }), ["titledLink.unchanged"]);
    assert.deepEqual(await makeSingleCase({
      protyle: {
        destroyed: true,
        block: { rootID: "root", box: "notebook" },
        notebookId: "notebook",
        updateTransactionElement() {},
      },
      kernel: {
        async post(path) {
          if (path === "/api/block/getBlockInfo") return { data: { rootID: "root", box: "notebook" }, code: 0 };
          if (path === "/api/block/getBlockDOM") {
            return { data: { id: "b-map", dom: '<div data-node-id="b-map"><span data-type="a" data-href="https://example.com/map">Other</span></div>' }, code: 0 };
          }
          return { data: {}, code: 0 };
        },
      },
    }), ["titledLink.conflict"]);
    assert.deepEqual(await makeSingleCase({
      protyle: {
        destroyed: true,
        block: { rootID: "root", box: "notebook" },
        notebookId: "notebook",
        updateTransactionElement() {},
      },
      kernel: {
        async post(path) {
          if (path === "/api/block/getBlockInfo") return { data: { rootID: "root", box: "notebook" }, code: 0 };
          if (path === "/api/block/getBlockDOM") {
            if (!this.called) {
              this.called = true;
              return { data: { id: "b-map", dom: '<div data-node-id="b-map"><span data-type="a" data-href="https://example.com/map">https://example.com/map</span></div>' }, code: 0 };
            }
            throw new Error("verify lost");
          }
          if (path === "/api/block/updateBlock") throw new Error("write timeout");
          return { data: {}, code: 0 };
        },
      },
    }), ["titledLink.unknown"]);
  }

  // 3. Multi-link auto paste groups per block, skips custom-text links, and emits one batchSummary
  {
    const first = new BatchLink("https://example.com/m1");
    const second = new BatchLink("https://example.com/m2");
    const custom = new BatchLink("https://example.com/custom", "Already Titled");
    new BatchBlock("b-multi", [first, second, custom]);
    const transactions = [];
    const protyle = {
      block: { rootID: "root", box: "notebook" },
      notebookId: "notebook",
      updateTransactionElement(el, oldHTML) { transactions.push({ el, oldHTML }); },
    };
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
      notify: m => notices.push(m),
      translate: (key, values) => values ? `${key}:${JSON.stringify(values)}` : key,
      fetchImpl: async url => htmlResponse(url.endsWith("m1") ? "M1" : "M2"),
      kernel: { post: async () => ({ data: {} }) },
    });

    await controller.runAutoPaste([first, second, custom], protyle);
    assert.equal(transactions.length, 1);
    assert.equal(first.textContent, "M1");
    assert.equal(second.textContent, "M2");
    assert.equal(custom.textContent, "Already Titled");
    assert.deepEqual(notices, [
      'titledLink.batchSummary:{"details":"titledLink.batchPart.total:{\\"count\\":2}titledLink.batchPart.septitledLink.batchPart.succeeded:{\\"count\\":2,\\"detail\\":\\"titledLink.batchPart.updated:{\\\\\\"count\\\\\\":2}\\"}"}',
    ]);
    scope.dispose();
  }

  // 4. Silent when auto.enabled === false (at entry or toggled mid-fetch) and when all items are skipped
  {
    let autoEnabled = false;
    let fetchCount = 0;
    const notices = [];
    const scope = new FeatureScope();
    const link1 = new BatchLink("https://example.com/off");
    new BatchBlock("b-off", [link1]);
    const protyle = { block: { rootID: "root", box: "notebook" }, notebookId: "notebook", updateTransactionElement() {} };
    let release;
    const controller = new TitledLinkController({
      settings: {
        getFeature: () => ({ auto: { enabled: autoEnabled }, replaceTitle: false, fallbackToHostname: false }),
        getUserAgent: () => "UA",
      },
      logger: { warn() {}, debug() {} },
    }, scope, {
      frontend: () => "desktop",
      notify: m => notices.push(m),
      translate: key => key,
      fetchImpl: () => {
        fetchCount += 1;
        return new Promise(resolve => { release = () => resolve(htmlResponse("Late")); });
      },
      kernel: { post: async () => ({ data: {} }) },
    });

    await controller.runAutoPaste([link1], protyle);
    assert.equal(fetchCount, 0);
    assert.deepEqual(notices, []);

    // Enabled at entry, disabled mid-fetch before notification -> silent
    autoEnabled = true;
    const pending = controller.runAutoPaste([link1], protyle);
    for (let i = 0; i < 20 && !release; i++) await new Promise(r => setTimeout(r, 2));
    autoEnabled = false;
    release();
    await pending;
    assert.deepEqual(notices, []);

    // Aborted / superseded in auto-paste -> silent (never emits titledLink.skipped)
    autoEnabled = true;
    release = undefined;
    const link2 = new BatchLink("https://example.com/abort");
    new BatchBlock("b-abort", [link2]);
    const abortRun = controller.runAutoPaste([link2], protyle);
    for (let i = 0; i < 20 && !release; i++) await new Promise(r => setTimeout(r, 2));
    scope.dispose();
    release();
    await abortRun;
    assert.deepEqual(notices, []);
  }

  // 5. Consecutive auto-pastes in the same block are not blocked by inFlightBatches
  {
    const linkA = new BatchLink("https://example.com/p1");
    const linkB = new BatchLink("https://example.com/p2");
    const block = new BatchBlock("b-seq", [linkA, linkB]);
    const protyle = { block: { rootID: "root", box: "notebook" }, notebookId: "notebook", updateTransactionElement() {} };
    let releaseA;
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
      notify: m => notices.push(m),
      translate: key => key,
      fetchImpl: url => {
        if (String(url).endsWith("/p1")) {
          return new Promise(resolve => { releaseA = () => resolve(htmlResponse("Title A")); });
        }
        return Promise.resolve(htmlResponse("Title B"));
      },
      kernel: { post: async () => ({ data: {} }) },
    });

    const first = controller.runAutoPaste([linkA], protyle);
    for (let i = 0; i < 20 && !releaseA; i++) await new Promise(r => setTimeout(r, 2));
    const second = controller.runAutoPaste([linkB], protyle);
    await second;
    assert.equal(linkB.textContent, "Title B");
    releaseA();
    await first;
    assert.equal(linkA.textContent, "Title A");
    assert.deepEqual(notices, ["titledLink.updated", "titledLink.updated"]);
    scope.dispose();
  }
}));

test("a second manual run aborts the previous request for the same link", async () => {
  const { link, protyle } = fixture();
  const requests = [];
  const transactions = [];
  protyle.updateTransactionElement = () => transactions.push(true);
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
      getFeature: () => ({ auto: { enabled: true }, replaceTitle: false, fallbackToHostname: true }),
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
      getFeature: () => ({ auto: { enabled: true }, replaceTitle: false, fallbackToHostname: true }),
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
      getFeature: () => ({ auto: { enabled: true }, replaceTitle: false, fallbackToHostname: true }),
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
    };
  };

  const makeController = (fetchImpl, scope = new FeatureScope()) => new TitledLinkController({
    settings: {
      getFeature: () => ({ auto: { enabled: true }, replaceTitle: false, fallbackToHostname: false }),
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
        'titledLink.batchSummary:{"details":"titledLink.batchPart.total:{\\"count\\":4}titledLink.batchPart.septitledLink.batchPart.succeeded:{\\"count\\":1,\\"detail\\":\\"titledLink.batchPart.updated:{\\\\\\"count\\\\\\":1}\\"}titledLink.batchPart.septitledLink.batchPart.conflict:{\\"count\\":1}titledLink.batchPart.septitledLink.batchPart.failed:{\\"count\\":1}titledLink.batchPart.septitledLink.batchPart.unknown:{\\"count\\":1}"}',
      ]);
      scope.dispose();
    } finally {
      globalThis.DOMParser = prevDOMParser;
    }
  }
});

test("I-06: closing original editor mid-fetch automatically switches write path to /api/block/updateBlock", async () => withBatchDOMParser(async () => {
  const link = new BatchLink("https://example.com/i06");
  const block = new BatchBlock("b-i06", [link]);
  let transactionCount = 0;
  const kernelCalls = [];
  const protyle = {
    destroyed: false,
    element: { isConnected: true, classList: { contains: name => name === "protyle" } },
    wysiwyg: { element: { isConnected: true } },
    block: { rootID: "root", box: "notebook" },
    notebookId: "notebook",
    updateTransactionElement() { transactionCount += 1; },
  };
  let releaseFetch;
  const scope = new FeatureScope();
  const controller = new TitledLinkController({
    settings: {
      getFeature: () => ({ auto: { enabled: true }, replaceTitle: false, fallbackToHostname: false }),
      getUserAgent: () => "UA",
    },
    logger: { warn() {}, debug() {} },
  }, scope, {
    frontend: () => "desktop",
    notify: () => {},
    translate: key => key,
    fetchImpl: () => new Promise(resolve => { releaseFetch = () => resolve(htmlResponse("Background Title")); }),
    kernel: {
      async post(path, body) {
        kernelCalls.push({ path, body });
        if (path === "/api/block/getBlockInfo") return { data: { rootID: "root", box: "notebook" }, code: 0 };
        if (path === "/api/block/getBlockDOM") return { data: { id: "b-i06", dom: block.outerHTML }, code: 0 };
        if (path === "/api/block/updateBlock") return { code: 0, data: null };
        return { data: {}, code: 0 };
      },
    },
  });

  const run = controller.runManual(link, protyle);
  for (let i = 0; i < 20 && !releaseFetch; i++) await new Promise(r => setTimeout(r, 2));
  assert.ok(releaseFetch);

  // Close the original editor before fetch completes
  protyle.destroyed = true;
  protyle.element.isConnected = false;
  protyle.wysiwyg.element.isConnected = false;
  releaseFetch();

  assert.equal(await run, "updated");
  assert.equal(transactionCount, 0);
  assert.deepEqual(kernelCalls.map(c => c.path), [
    "/api/block/getBlockInfo",
    "/api/block/getBlockDOM",
    "/api/block/updateBlock",
  ]);
  assert.match(kernelCalls[2].body.data, />Background Title<\/span>/);
  scope.dispose();
}));

test("countBatchResults conserves total across all terminal buckets", () => {
  const empty = countBatchResults([]);
  assert.deepEqual(empty, {
    total: 0,
    succeeded: 0,
    updated: 0,
    unchanged: 0,
    conflict: 0,
    failed: 0,
    imeTimeout: 0,
    unknown: 0,
    skipped: 0,
    superseded: 0,
    aborted: 0,
  });

  const all = countBatchResults([
    "updated",
    "updated",
    "unchanged",
    "conflict",
    "failed",
    "ime-timeout",
    "unknown",
    "superseded",
    "aborted",
  ]);
  assert.deepEqual(all, {
    total: 9,
    succeeded: 3,
    updated: 2,
    unchanged: 1,
    conflict: 1,
    failed: 1,
    imeTimeout: 1,
    unknown: 1,
    skipped: 2,
    superseded: 1,
    aborted: 1,
  });
  assert.equal(all.succeeded, all.updated + all.unchanged);
  assert.equal(all.skipped, all.superseded + all.aborted);
  assert.equal(
    all.succeeded + all.conflict + all.failed + all.imeTimeout + all.unknown + all.skipped,
    all.total,
  );
});

test("formatBatchSummary renders only non-zero parts in both locales and manual runBatch is silent when all skipped", async () => withBatchDOMParser(async () => {
  const { readFile } = await import("node:fs/promises");
  const { translate } = await import("../../../src/i18n/translate.ts");
  const [zhRaw, enRaw] = await Promise.all([
    readFile(new URL("../../../src/i18n/zh-CN.json", import.meta.url), "utf8"),
    readFile(new URL("../../../src/i18n/en.json", import.meta.url), "utf8"),
  ]);
  const zh = JSON.parse(zhRaw);
  const en = JSON.parse(enRaw);

  const mixed = countBatchResults(["updated", "conflict", "failed", "unknown"]);
  assert.equal(
    formatBatchSummary(mixed, (k, v) => translate(zh, k, v)),
    "链接标题提取完成：共 4 个，成功 1 个（更新 1 个），冲突 1 个，失败 1 个，结果未知 1 个",
  );
  assert.equal(
    formatBatchSummary(mixed, (k, v) => translate(en, k, v)),
    "Title extraction finished: 4 total, 1 succeeded (1 updated), 1 conflict, 1 failed, 1 unknown",
  );

  const onlyUnchanged = countBatchResults(["unchanged", "unchanged"]);
  assert.equal(
    formatBatchSummary(onlyUnchanged, (k, v) => translate(zh, k, v)),
    "链接标题提取完成：共 2 个，成功 2 个（已是最新 2 个）",
  );

  // Manual batch where every item is superseded while scope remains active stays completely silent (covers L268, not L267)
  const linkA = new BatchLink("https://example.com/superseded-a");
  const linkB = new BatchLink("https://example.com/superseded-b");
  const block = new BatchBlock("b-all-superseded", [linkA, linkB]);
  const protyle = { block: { rootID: "root", box: "notebook" }, notebookId: "notebook", updateTransactionElement() {} };
  const notices = [];
  const scope = new FeatureScope();
  const batchResolvers = [];
  let manualMode = false;
  const controller = new TitledLinkController({
    settings: {
      getFeature: () => ({ auto: { enabled: true }, replaceTitle: false, fallbackToHostname: false }),
      getUserAgent: () => "UA",
    },
    logger: { warn() {}, debug() {} },
  }, scope, {
    frontend: () => "desktop",
    notify: msg => notices.push(msg),
    translate: (k, v) => translate(zh, k, v),
    fetchImpl: () => {
      if (manualMode) return Promise.resolve(htmlResponse("Manual Winner"));
      return new Promise(resolve => { batchResolvers.push(() => resolve(htmlResponse("Stale Batch"))); });
    },
    kernel: { post: async () => ({ data: { rootID: "root", box: "notebook" } }) },
  });
  const pending = controller.runBatch([block], protyle);
  for (let i = 0; i < 20 && batchResolvers.length < 2; i++) await new Promise(r => setTimeout(r, 2));
  assert.equal(batchResolvers.length, 2);
  // Supersede both links via manual runs while scope stays active
  manualMode = true;
  await controller.runManual(linkA, protyle);
  await controller.runManual(linkB, protyle);
  const noticeCountBeforeBatchFinish = notices.length;
  for (const resolve of batchResolvers) resolve();
  await pending;
  assert.equal(scope.active, true);
  assert.equal(notices.length, noticeCountBeforeBatchFinish, "superseded manual batch must emit zero batchSummary notices");
  assert.equal(notices.some(m => m.includes("链接标题提取完成")), false);
  scope.dispose();
}));
