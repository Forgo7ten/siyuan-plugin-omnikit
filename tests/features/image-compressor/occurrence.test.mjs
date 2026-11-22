import test from "node:test";
import assert from "node:assert/strict";
import { resolveImageOccurrence } from "../../../src/features/image-compressor/services/ImageOccurrenceResolver.ts";
import {
  commitOneImage,
  commitOneImageDetailed,
} from "../../../src/features/image-compressor/services/SafeBlockWriter.ts";
import { withBlockWriteLease } from "../../../src/core/host/BlockWriteLease.ts";

const rootID = "20261113000000-abcdef0";
const blockID = "20261113000001-abcdef0";
const notebook = "20261113000002-abcdef0";

class Element {
  constructor(tag, attrs = {}, children = []) {
    this.tagName = tag.toUpperCase();
    this.attrs = new Map(Object.entries(attrs));
    this.children = children;
    this.textContent = "";
  }
  hasAttribute(name) { return this.attrs.has(name); }
  getAttribute(name) { return this.attrs.get(name) ?? null; }
  setAttribute(name, value) { this.attrs.set(name, value); }
  removeAttribute(name) { this.attrs.delete(name); }
  getAttributeNames() { return [...this.attrs.keys()]; }
  querySelectorAll(selector) {
    if (selector === "[parent-heading]" || selector === "[updated]") {
      const attr = selector.slice(1, -1);
      return this.children.flatMap(child => [
        ...(child.hasAttribute(attr) ? [child] : []),
        ...child.querySelectorAll(selector),
      ]);
    }
    if (selector === "a[href], span[data-href]") {
      return this.children.flatMap(child => [
        ...((child.tagName === "A" && child.hasAttribute("href")) || (child.tagName === "SPAN" && child.hasAttribute("data-href")) ? [child] : []),
        ...child.querySelectorAll(selector),
      ]);
    }
    return this.children.flatMap(child => [
      ...(selector === "img" && child.tagName === "IMG" ? [child] : []),
      ...child.querySelectorAll(selector),
    ]);
  }
  querySelector(selector) { return this.querySelectorAll(selector)[0] ?? null; }
  closest() { return null; }
  get outerHTML() {
    const attrs = [...this.attrs].map(([key, value]) => ` ${key}="${value}"`).join("");
    if (this.tagName === "IMG") return `<img${attrs}>`;
    return `<${this.tagName.toLowerCase()}${attrs}>${this.children.map(child => child.outerHTML).join("")}${this.textContent}</${this.tagName.toLowerCase()}>`;
  }
}

class Template {
  constructor() { this.content = { children: [], querySelector: selector => this.content.children.flatMap(child => child.querySelectorAll(selector))[0] ?? null }; }
  set innerHTML(html) {
    const open = html.match(/^\s*<([\w-]+)([^>]*)>([\s\S]*)<\/\1>\s*$/);
    if (!open) { this.content.children = []; return; }
    const attrs = Object.fromEntries([...open[2].matchAll(/([\w-]+)="([^"]*)"/g)].map(match => [match[1], match[2]]));
    const children = [];
    const body = open[3];
    for (const m of body.matchAll(/<img\b([^>]*)>|<span\b([^>]*)>([^<]*)<\/span>|<a\b([^>]*)>([^<]*)<\/a>/g)) {
      if (m[1] !== undefined) {
        children.push(new Element("img", Object.fromEntries([...m[1].matchAll(/([\w-]+)="([^"]*)"/g)].map(a => [a[1], a[2]]))));
      } else if (m[2] !== undefined) {
        const el = new Element("span", Object.fromEntries([...m[2].matchAll(/([\w-]+)="([^"]*)"/g)].map(a => [a[1], a[2]])));
        el.textContent = m[3];
        children.push(el);
      } else if (m[4] !== undefined) {
        const el = new Element("a", Object.fromEntries([...m[4].matchAll(/([\w-]+)="([^"]*)"/g)].map(a => [a[1], a[2]])));
        el.textContent = m[5];
        children.push(el);
      }
    }
    this.content.children = [new Element(open[1], attrs, children)];
  }
}

function withDocument(run) {
  const previous = globalThis.document;
  globalThis.document = { createElement: name => { assert.equal(name, "template"); return new Template(); } };
  return Promise.resolve().then(run).finally(() => { globalThis.document = previous; });
}

function blockDOM(paths, extraAttrs = "") {
  const images = paths.map(path => `<img data-src="${path}" src="${path}">`).join("");
  return `<div data-node-id="${blockID}"${extraAttrs}>${images}</div>`;
}

test("resolver captures one exact ordinal among duplicate image paths", async () => withDocument(() => {
  const baseline = blockDOM(["assets/a.png", "assets/a.png", "assets/b.png"]);
  const target = resolveImageOccurrence(baseline, { rootID, notebook, blockID, imageOrdinal: 1, oldPath: "assets/a.png" });
  assert.equal(target?.imageOrdinal, 1);
  assert.equal(target?.oldPath, "assets/a.png");
  assert.equal(resolveImageOccurrence(baseline, { rootID, notebook, blockID, imageOrdinal: 4, oldPath: "assets/a.png" }), undefined);
}));

test("writer checks block ownership and baseline, then updates occurrence and trusts kernel response", async () => withDocument(async () => {
  let current = blockDOM(["assets/a.png", "assets/a.png", "assets/b.png"]);
  const target = resolveImageOccurrence(current, { rootID, notebook, blockID, imageOrdinal: 1, oldPath: "assets/a.png" });
  const calls = [];
  const kernel = { async post(path, body) {
    calls.push(path);
    if (path === "/api/block/getBlockInfo") return { data: { rootID, box: notebook } };
    if (path === "/api/block/getBlockDOM") return { data: { id: blockID, dom: current } };
    if (path === "/api/block/updateBlock") { current = body.data; return { data: null }; }
    throw new Error(`Unexpected endpoint ${path}`);
  } };
  assert.equal(await commitOneImage(kernel, target, "assets/a.webp", "http://localhost:6806"), "replaced");
  assert.equal((current.match(/data-src="assets\/a\.webp"/g) ?? []).length, 1);
  assert.deepEqual(calls, ["/api/block/getBlockInfo", "/api/block/getBlockDOM", "/api/block/updateBlock"]);
}));

test("writer strips render-only parent-heading attribute, drops query params, and preserves #fragment + box (I-05)", async () => withDocument(async () => {
  const current = `<div data-node-id="${blockID}" parent-heading="20261113000099-abcdef0"><img data-src="assets/a.png?width=200#fig" src="assets/a.png?width=200#fig"></div>`;
  const target = resolveImageOccurrence(current, { rootID, notebook, blockID, imageOrdinal: 0, oldPath: "assets/a.png?width=200#fig" });
  let written = "";
  const kernel = { async post(path, body) {
    if (path === "/api/block/getBlockInfo") return { data: { rootID, box: notebook } };
    if (path === "/api/block/getBlockDOM") return { data: { id: blockID, dom: current } };
    if (path === "/api/block/updateBlock") { written = body.data; return { data: null }; }
    throw new Error(`Unexpected endpoint ${path}`);
  } };
  const result = await commitOneImage(kernel, target, `assets/a.webp?box=${notebook}`, "http://localhost:6806");
  assert.equal(result, "replaced");
  assert.equal(written.includes("parent-heading"), false);
  assert.equal(written.includes("width=200"), false);
  assert.equal(written.includes(`assets/a.webp?box=${notebook}#fig`), true);
}));

test("writer patches only the selected resource link ordinal without touching images or sibling links (D06)", async () => withDocument(async () => {
  const dom = `<div data-node-id="${blockID}"><img data-src="assets/a.png" src="assets/a.png"><span data-type="a" data-href="assets/a.png">first</span><a href="assets/a.png">second</a></div>`;
  const target = {
    rootID,
    notebook,
    blockID,
    kind: "link",
    attribute: "data-href",
    imageOrdinal: 0,
    oldPath: "assets/a.png",
  };
  let written = "";
  const kernel = { async post(path, body) {
    if (path === "/api/block/getBlockInfo") return { data: { rootID, box: notebook } };
    if (path === "/api/block/getBlockDOM") return { data: { id: blockID, dom } };
    if (path === "/api/block/updateBlock") { written = body.data; return { data: null }; }
    throw new Error(`Unexpected endpoint ${path}`);
  } };
  const result = await commitOneImage(kernel, target, "assets/a.webp", "http://localhost:6806");
  assert.equal(result, "replaced");
  assert.equal(written.includes('<img data-src="assets/a.png" src="assets/a.png">'), true);
  assert.equal(written.includes('<span data-type="a" data-href="assets/a.webp">first</span>'), true);
  assert.equal(written.includes('<a href="assets/a.png">second</a>'), true);
}));

test("writer safely skips a stale baseline without sending updateBlock", async () => withDocument(async () => {
  const baseline = blockDOM(["assets/a.png"]);
  const target = resolveImageOccurrence(baseline, { rootID, notebook, blockID, imageOrdinal: 0, oldPath: "assets/a.png" });
  const calls = [];
  const kernel = { async post(path) {
    calls.push(path);
    if (path === "/api/block/getBlockInfo") return { data: { rootID, box: notebook } };
    if (path === "/api/block/getBlockDOM") return { data: { id: blockID, dom: blockDOM(["assets/changed.png"]) } };
    throw new Error(`Unexpected endpoint ${path}`);
  } };
  assert.equal(await commitOneImage(kernel, target, "assets/a.webp", "http://localhost:6806"), "conflict");
  assert.equal(calls.includes("/api/block/updateBlock"), false);
}));

test("writer propagates read errors explicitly instead of masking them as conflict (I-07)", async () => withDocument(async () => {
  const baseline = blockDOM(["assets/a.png"]);
  const target = resolveImageOccurrence(baseline, { rootID, notebook, blockID, imageOrdinal: 0, oldPath: "assets/a.png" });
  const kernel = { async post(path) {
    if (path === "/api/block/getBlockInfo") throw new Error("Kernel unreachable");
    throw new Error(`Unexpected endpoint ${path}`);
  } };
  await assert.rejects(
    commitOneImage(kernel, target, "assets/a.webp", "http://localhost:6806"),
    /Kernel unreachable/,
  );
}));

test("writer returns unknown without retrying when updateBlock fails after dispatch (I-06)", async () => withDocument(async () => {
  const baseline = blockDOM(["assets/a.png"]);
  const target = resolveImageOccurrence(baseline, { rootID, notebook, blockID, imageOrdinal: 0, oldPath: "assets/a.png" });
  let updateCalls = 0;
  const kernel = { async post(path) {
    if (path === "/api/block/getBlockInfo") return { data: { rootID, box: notebook } };
    if (path === "/api/block/getBlockDOM") return { data: { id: blockID, dom: baseline } };
    if (path === "/api/block/updateBlock") {
      updateCalls++;
      throw new Error("Socket timeout");
    }
    throw new Error(`Unexpected endpoint ${path}`);
  } };
  const result = await commitOneImage(kernel, target, "assets/a.webp", "http://localhost:6806");
  assert.equal(result, "unknown");
  assert.equal(updateCalls, 1);
}));

test("writer returns aborted when signal is already aborted and never returns conflict", async () => withDocument(async () => {
  const baseline = blockDOM(["assets/a.png"]);
  const target = resolveImageOccurrence(baseline, { rootID, notebook, blockID, imageOrdinal: 0, oldPath: "assets/a.png" });
  const controller = new AbortController();
  controller.abort();
  const kernel = { async post() { throw new Error("Should not be called"); } };
  const res = await commitOneImage(kernel, target, "assets/a.webp", "http://localhost:6806", controller.signal);
  assert.equal(res, "aborted");
}));

test("writer returns aborted when signal aborts before updateBlock", async () => withDocument(async () => {
  const baseline = blockDOM(["assets/a.png"]);
  const target = resolveImageOccurrence(baseline, { rootID, notebook, blockID, imageOrdinal: 0, oldPath: "assets/a.png" });
  const controller = new AbortController();
  const calls = [];
  const kernel = { async post(path) {
    calls.push(path);
    if (path === "/api/block/getBlockInfo") return { data: { rootID, box: notebook } };
    if (path === "/api/block/getBlockDOM") {
      controller.abort();
      return { data: { id: blockID, dom: baseline } };
    }
    throw new Error(`Unexpected endpoint ${path}`);
  } };
  const res = await commitOneImage(kernel, target, "assets/a.webp", "http://localhost:6806", controller.signal);
  assert.equal(res, "aborted");
  assert.equal(calls.includes("/api/block/updateBlock"), false);
}));

test("writer shares Core withBlockWriteLease across notebook/blockID (A-07)", async () => withDocument(async () => {
  const baseline = blockDOM(["assets/a.png"]);
  const target = resolveImageOccurrence(baseline, { rootID, notebook, blockID, imageOrdinal: 0, oldPath: "assets/a.png" });
  const events = [];
  let releaseLease;
  let markHeld;
  const held = new Promise(r => { markHeld = r; });
  const blocker = new Promise(r => { releaseLease = r; });

  const peer = withBlockWriteLease(notebook, blockID, undefined, async () => {
    events.push("peer:enter");
    markHeld();
    await blocker;
    events.push("peer:exit");
  });

  await held;
  const kernel = { async post(path) {
    events.push(`image:${path}`);
    if (path === "/api/block/getBlockInfo") return { data: { rootID, box: notebook } };
    if (path === "/api/block/getBlockDOM") return { data: { id: blockID, dom: baseline } };
    if (path === "/api/block/updateBlock") return { data: null };
    throw new Error(path);
  } };

  const writePromise = commitOneImage(kernel, target, "assets/a.webp", "http://localhost:6806");
  await Promise.resolve();
  await Promise.resolve();
  assert.deepEqual(events, ["peer:enter"]);

  releaseLease();
  const [, commitRes] = await Promise.all([peer, writePromise]);
  assert.equal(commitRes, "replaced");
  assert.equal(events[1], "peer:exit");
  assert.equal(events[2], "image:/api/block/getBlockInfo");
}));

test("I-07: writer distinguishes not-sent -> aborted, rejected -> failed, and unknown -> unknown", async () => withDocument(async () => {
  const baseline = blockDOM(["assets/a.png"]);
  const target = resolveImageOccurrence(baseline, { rootID, notebook, blockID, imageOrdinal: 0, oldPath: "assets/a.png" });

  const makeKernel = (error) => ({
    async post(path) {
      if (path === "/api/block/getBlockInfo") return { data: { rootID, box: notebook } };
      if (path === "/api/block/getBlockDOM") return { data: { id: blockID, dom: baseline } };
      if (path === "/api/block/updateBlock") throw error;
      throw new Error(path);
    },
  });

  assert.equal(
    await commitOneImage(makeKernel(Object.assign(new Error("cancelled"), { outcome: "not-sent", name: "AbortError" })), target, "assets/a.webp", "http://localhost:6806"),
    "aborted",
  );
  assert.equal(
    await commitOneImage(makeKernel(Object.assign(new Error("rejected"), { outcome: "rejected", code: -1 })), target, "assets/a.webp", "http://localhost:6806"),
    "failed",
  );
  assert.equal(
    await commitOneImage(makeKernel(Object.assign(new Error("post-dispatch abort"), { outcome: "unknown", name: "AbortError" })), target, "assets/a.webp", "http://localhost:6806"),
    "unknown",
  );
}));

test("I-04: commitOneImageDetailed keeps updated on write payload while stripping parent-heading", async () => withDocument(async () => {
  const domWithUpdated = `<div data-node-id="${blockID}" parent-heading="20261113000099-abcdef0" updated="20261113000001"><img data-src="assets/a.png" src="assets/a.png" updated="20261113000002"></div>`;
  const target = resolveImageOccurrence(domWithUpdated, { rootID, notebook, blockID, imageOrdinal: 0, oldPath: "assets/a.png" });
  let written = "";
  const kernel = {
    async post(path, body) {
      if (path === "/api/block/getBlockInfo") return { data: { rootID, box: notebook } };
      if (path === "/api/block/getBlockDOM") return { data: { id: blockID, dom: domWithUpdated } };
      if (path === "/api/block/updateBlock") { written = body.data; return { data: null }; }
      throw new Error(path);
    },
  };
  const detailed = await commitOneImageDetailed(kernel, target, "assets/a.webp", "http://localhost:6806");
  assert.equal(detailed.status, "replaced");
  assert.equal(written.includes("parent-heading"), false);
  assert.equal(written.includes('updated="20261113000001"'), true);
  assert.equal(written.includes('updated="20261113000002"'), true);
}));

test("replaces target node when data-node-index, updated, or sibling text differ while rejecting target node mutation", async () => withDocument(async () => {
  const domParserBaseline = `<div data-node-id="${blockID}" data-node-index="13" updated="20261122005023"><img src="assets/a.png" data-src="assets/a.png" loading="lazy" alt="a"></div>`;
  const target = resolveImageOccurrence(domParserBaseline, { rootID, notebook, blockID, imageOrdinal: 0, oldPath: "assets/a.png" });
  let writes = 0;
  let lastWritten = "";
  let liveDOM = `<div data-node-id="${blockID}" data-node-index="1" parent-heading="20261122000001-hdr" updated="20261122005999"><span data-type="text">new sibling text</span><img src="assets/a.png" data-src="assets/a.png" loading="lazy" alt="a" /></div>`;
  const kernel = {
    async post(path, body) {
      if (path === "/api/block/getBlockInfo") return { data: { rootID, box: notebook } };
      if (path === "/api/block/getBlockDOM") return { data: { id: blockID, dom: liveDOM } };
      if (path === "/api/block/updateBlock") { writes++; lastWritten = body.data; liveDOM = body.data; return { data: null }; }
      throw new Error(path);
    },
  };

  const ok = await commitOneImageDetailed(kernel, target, "assets/a.webp", "http://localhost:6806");
  assert.equal(ok.status, "replaced");
  assert.equal(writes, 1);
  assert.equal(lastWritten.includes("new sibling text"), true);
  assert.equal(lastWritten.includes('data-node-index="1"'), true);
  assert.equal(lastWritten.includes('updated="20261122005999"'), true);
  assert.equal(lastWritten.includes("parent-heading"), false);

  // Target image replaced by another asset at the same ordinal must conflict
  liveDOM = `<div data-node-id="${blockID}" data-node-index="1" updated="20261122006000"><img src="assets/other.png" data-src="assets/other.png" /></div>`;
  const pathChanged = await commitOneImageDetailed(kernel, target, "assets/a.webp", "http://localhost:6806");
  assert.equal(pathChanged.status, "conflict");
  assert.equal(pathChanged.conflictReason, "path-mismatch");

  // Target image removed at ordinal must conflict
  liveDOM = `<div data-node-id="${blockID}" data-node-index="1" updated="20261122006001">text only</div>`;
  const ordinalMissing = await commitOneImageDetailed(kernel, target, "assets/a.webp", "http://localhost:6806");
  assert.equal(ordinalMissing.status, "conflict");
  assert.equal(ordinalMissing.conflictReason, "ordinal-mismatch");
  assert.equal(writes, 1);
}));

test("writer supports bidirectional restore to HTTP(S) URLs for both images and links while preserving query/fragment", async () => withDocument(async () => {
  const remoteURL = "https://cdn.example/photo.png?token=abc#sec";
  const imgDom = `<div data-node-id="${blockID}"><img data-src="assets/local.png?box=${notebook}#fig" src="assets/local.png?box=${notebook}#fig"></div>`;
  const linkDom = `<div data-node-id="${blockID}"><span data-type="a" data-href="assets/local.png">link</span></div>`;
  let currentDOM = imgDom;
  let lastWritten = "";
  const kernel = {
    async post(path, body) {
      if (path === "/api/block/getBlockInfo") return { data: { rootID, box: notebook } };
      if (path === "/api/block/getBlockDOM") return { data: { id: blockID, dom: currentDOM } };
      if (path === "/api/block/updateBlock") { lastWritten = body.data; return { data: null }; }
      throw new Error(path);
    },
  };

  const imgTarget = resolveImageOccurrence(imgDom, {
    rootID,
    notebook,
    blockID,
    imageOrdinal: 0,
    oldPath: `assets/local.png?box=${notebook}#fig`,
  });
  const imgRes = await commitOneImageDetailed(kernel, imgTarget, remoteURL, "http://localhost:6806");
  assert.equal(imgRes.status, "replaced");
  assert.equal(lastWritten.includes(`data-src="${remoteURL}"`), true);
  assert.equal(lastWritten.includes(`src="${remoteURL}"`), true);

  currentDOM = linkDom;
  const linkRes = await commitOneImageDetailed(
    kernel,
    { rootID, notebook, blockID, kind: "link", attribute: "data-href", imageOrdinal: 0, oldPath: "assets/local.png" },
    remoteURL,
    "http://localhost:6806",
  );
  assert.equal(linkRes.status, "replaced");
  assert.equal(lastWritten.includes(`data-href="${remoteURL}"`), true);

  // Unsafe schemes or credentialed URLs remain strictly rejected before lock acquisition
  for (const unsafe of ["javascript:alert(1)", "file:///etc/passwd", "https://user:pass@cdn.example/a.png"]) {
    await assert.rejects(
      commitOneImageDetailed(kernel, imgTarget, unsafe, "http://localhost:6806"),
      /Only HTTP\(S\) image links are supported|Replacement path must be an asset or remote URL/,
    );
  }
}));
