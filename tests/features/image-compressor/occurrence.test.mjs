import test from "node:test";
import assert from "node:assert/strict";
import { resolveImageOccurrence } from "../../../src/features/image-compressor/services/ImageOccurrenceResolver.ts";
import { commitOneImage } from "../../../src/features/image-compressor/services/SafeBlockWriter.ts";

const rootID = "20261113000000-abcdef0";
const blockID = "20261113000001-abcdef0";
const notebook = "20261113000002-abcdef0";

class Element {
  constructor(tag, attrs = {}, children = []) { this.tagName = tag.toUpperCase(); this.attrs = new Map(Object.entries(attrs)); this.children = children; }
  hasAttribute(name) { return this.attrs.has(name); }
  getAttribute(name) { return this.attrs.get(name) ?? null; }
  setAttribute(name, value) { this.attrs.set(name, value); }
  getAttributeNames() { return [...this.attrs.keys()]; }
  querySelectorAll(selector) { return this.children.flatMap(child => [ ...(selector === "img" && child.tagName === "IMG" ? [child] : []), ...child.querySelectorAll(selector) ]); }
  querySelector(selector) { return this.querySelectorAll(selector)[0] ?? null; }
  closest() { return null; }
  get outerHTML() {
    const attrs = [...this.attrs].map(([key, value]) => ` ${key}="${value}"`).join("");
    return `<${this.tagName.toLowerCase()}${attrs}>${this.children.map(child => child.outerHTML).join("")}</${this.tagName.toLowerCase()}>`;
  }
}
class Template {
  constructor() { this.content = { children: [], querySelector: selector => this.content.children.flatMap(child => child.querySelectorAll(selector))[0] ?? null }; }
  set innerHTML(html) {
    const open = html.match(/^\s*<([\w-]+)([^>]*)>([\s\S]*)<\/\1>\s*$/);
    if (!open) { this.content.children = []; return; }
    const attrs = Object.fromEntries([...open[2].matchAll(/([\w-]+)="([^"]*)"/g)].map(match => [match[1], match[2]]));
    const children = [...open[3].matchAll(/<img\b([^>]*)>/g)].map(match => new Element("img", Object.fromEntries([...match[1].matchAll(/([\w-]+)="([^"]*)"/g)].map(a => [a[1], a[2]]))));
    this.content.children = [new Element(open[1], attrs, children)];
  }
}

function withDocument(run) {
  const previous = globalThis.document;
  globalThis.document = { createElement: name => { assert.equal(name, "template"); return new Template(); } };
  return Promise.resolve().then(run).finally(() => { globalThis.document = previous; });
}

function blockDOM(paths) {
  const images = paths.map(path => `<img data-src="${path}" src="${path}">`).join("");
  return `<div data-node-id="${blockID}">${images}</div>`;
}

test("resolver captures one exact ordinal among duplicate image paths", async () => withDocument(() => {
  const baseline = blockDOM(["assets/a.png", "assets/a.png", "assets/b.png"]);
  const target = resolveImageOccurrence(baseline, { rootID, notebook, blockID, imageOrdinal: 1, oldPath: "assets/a.png" });
  assert.equal(target?.imageOrdinal, 1);
  assert.equal(target?.baselineBlockDOM, baseline);
  assert.equal(resolveImageOccurrence(baseline, { rootID, notebook, blockID, imageOrdinal: 4, oldPath: "assets/a.png" }), undefined);
}));

test("writer checks block ownership and baseline, then updates and reads back one occurrence", async () => withDocument(async () => {
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
  assert.deepEqual(calls, ["/api/block/getBlockInfo", "/api/block/getBlockDOM", "/api/block/updateBlock", "/api/block/getBlockInfo", "/api/block/getBlockDOM"]);
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

test("writer rejects with AbortError when signal is already aborted and never returns conflict", async () => withDocument(async () => {
  const baseline = blockDOM(["assets/a.png"]);
  const target = resolveImageOccurrence(baseline, { rootID, notebook, blockID, imageOrdinal: 0, oldPath: "assets/a.png" });
  const controller = new AbortController();
  controller.abort();
  const kernel = { async post() { throw new Error("Should not be called"); } };
  await assert.rejects(
    async () => {
      const res = await commitOneImage(kernel, target, "assets/a.webp", "http://localhost:6806", controller.signal);
      assert.notEqual(res, "conflict");
    },
    (err) => err?.name === "AbortError",
  );
}));

test("writer rejects with AbortError when signal aborts before updateBlock", async () => withDocument(async () => {
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
  await assert.rejects(
    async () => {
      const res = await commitOneImage(kernel, target, "assets/a.webp", "http://localhost:6806", controller.signal);
      assert.notEqual(res, "conflict");
    },
    (err) => err?.name === "AbortError",
  );
  assert.equal(calls.includes("/api/block/updateBlock"), false);
}));
