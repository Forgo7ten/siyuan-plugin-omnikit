import { test } from "node:test";
import assert from "node:assert/strict";
import { FeatureScope } from "../../../src/core/framework/FeatureScope.ts";
import {
  completedUploadPaths,
  hasCompressibleInput,
  registerAutoUpload,
  waitForObservedImages,
} from "../../../src/features/image-compressor/actions/AutoUploadHandler.ts";
import { defaultImageFeatureConfig } from "../../../src/features/image-compressor/policy/parseImageConfig.ts";

function setup() {
  const listeners = new Map();
  const plugin = { eventBus: {
    on(name, handler) { listeners.set(name, handler); },
    off(name) { listeners.delete(name); },
  } };
  const scope = new FeatureScope();
  const services = { origin: "https://siyuan.test", config: () => ({}) };
  let compressCalls = 0;
  services.compressOccurrence = async () => { compressCalls++; return { status: "skipped" }; };
  registerAutoUpload(plugin, scope, () => true, services,
    { warn() {}, debug() {} });
  return { listener: listeners.get("before-upload-assets"), scope, services, get compressCalls() { return compressCalls; } };
}

test("native upload listener only registers onComplete synchronously and never intercepts upload", () => {
  const { listener, scope, compressCalls } = setup();
  let complete;
  let completeCalls = 0;
  const detail = {
    requestId: "upload-1",
    target: "editor",
    protyle: { block: { rootID: "20240101000000-abcdefg", box: "20240101000000-abcdefg" } },
    onComplete(callback) { completeCalls++; complete = callback; },
  };
  listener({ detail });
  assert.equal(completeCalls, 1);
  assert.equal(typeof complete, "function");
  assert.equal("respondWith" in detail, false);
  assert.equal(compressCalls, 0);

  complete({ requestId: "other-request", status: "success", succFiles: [{ index: 0, path: "assets/a.png" }] });
  assert.equal(compressCalls, 0);
  complete({ requestId: "upload-1", status: "failed", succFiles: [] });
  assert.equal(compressCalls, 0);
  scope.dispose();
});

test("listener ignores non-editor uploads and details without native completion callback", () => {
  const { listener, scope } = setup();
  let calls = 0;
  listener({ detail: { requestId: "upload-2", target: "editor", protyle: { block: { rootID: "20240101000000-abcdefg", box: "20240101000000-abcdefg" } } } });
  listener({ detail: { requestId: "upload-3", target: "assets-panel", onComplete() { calls++; } } });
  assert.equal(calls, 0);
  scope.dispose();
});

test("partial native upload processes only individually confirmed successful asset paths", () => {
  assert.deepEqual(completedUploadPaths({ requestId: "upload-4", status: "partial", succFiles: [
    { index: 0, path: "assets/first.png" },
    { index: 1, path: undefined },
    { index: 2, path: "assets/third.png" },
    { index: 3, path: "assets/third.png" },
    { index: -1, path: "assets/invalid.png" },
  ] }), ["assets/first.png", "assets/third.png"]);
  assert.deepEqual(completedUploadPaths({ requestId: "upload-5", status: "failed", succFiles: [
    { index: 0, path: "assets/failed.png" },
  ] }), []);
});

test("completedUploadPaths supports succMap fallback and normalizes Windows backslashes", () => {
  assert.deepEqual(completedUploadPaths({
    requestId: "upload-6",
    status: "success",
    succMap: {
      "photo1.png": "assets\\photo1.png",
      "photo2.jpg": "assets/photo2.jpg",
    },
  }), ["assets/photo1.png", "assets/photo2.jpg"]);
});

test("hasCompressibleInput returns false for empty file lists and true when input is absent (P3-4)", () => {
  const cfg = defaultImageFeatureConfig();
  assert.equal(hasCompressibleInput(undefined, cfg), true);
  assert.equal(hasCompressibleInput({ kind: "files", files: [] }, cfg), false);
  assert.equal(hasCompressibleInput({ kind: "local-files", files: [] }, cfg), false);
  assert.equal(hasCompressibleInput({ kind: "files", files: [new File(["x"], "a.pdf")] }, cfg), false);
  assert.equal(hasCompressibleInput({ kind: "files", files: [new File(["x"], "a.png")] }, cfg), true);
});

test("native completion can precede editor insertion without treating it as a missing image", async () => {
  const observed = [];
  const pending = waitForObservedImages(observed, "asset:assets/later.png", new AbortController().signal);
  setTimeout(() => observed.push({ key: "asset:assets/later.png", blockID: "block", imageOrdinal: 0 }), 20);
  const matches = await pending;
  assert.equal(matches.length, 1);
  assert.equal(matches[0].blockID, "block");
});

test("unauthorized document upload remains completely silent without emitting notices", async () => {
  const listeners = new Map();
  const plugin = { eventBus: {
    on(name, handler) { listeners.set(name, handler); },
    off(name) { listeners.delete(name); },
  } };
  const scope = new FeatureScope();
  let compressCalls = 0;
  const services = {
    origin: "https://siyuan.test",
    config: () => ({}),
    compressOccurrence: async () => { compressCalls++; return { status: "skipped" }; },
  };
  const notices = [];
  let authorized = true;
  registerAutoUpload(
    plugin,
    scope,
    () => authorized,
    services,
    { warn() {}, debug() {} },
    notice => notices.push(notice),
  );

  const listener = listeners.get("before-upload-assets");
  let completeCallback;
  listener({
    detail: {
      requestId: "upload-unauth",
      target: "editor",
      protyle: { block: { rootID: "doc-unauth", box: "box-1" } },
      onComplete(cb) { completeCallback = cb; },
    },
  });

  // Revoke authorization before native upload completes
  authorized = false;
  completeCallback({
    requestId: "upload-unauth",
    status: "success",
    succFiles: [{ index: 0, path: "assets/unauth.png" }],
  });

  await new Promise(resolve => setTimeout(resolve, 50));
  assert.equal(compressCalls, 0);
  assert.equal(notices.length, 0);
  scope.dispose();
});

test("upload where all images are skipped via observed insertion remains completely silent without emitting notices", async () => {
  const listeners = new Map();
  const plugin = { eventBus: {
    on(name, handler) { listeners.set(name, handler); },
    off(name) { listeners.delete(name); },
  } };
  const scope = new FeatureScope();
  let compressCalls = 0;
  const services = {
    origin: "https://siyuan.test",
    config: () => ({}),
    kernel: {
      async post(url) {
        if (url === "/api/block/getBlockDOM") {
          return { data: { id: "block-1", dom: '<div data-node-id="block-1"><img src="assets/skipped.png"/></div>' } };
        }
        return { data: {} };
      },
    },
    compressOccurrence: async () => {
      compressCalls++;
      return { status: "skipped" };
    },
  };
  const notices = [];
  const priorDocument = globalThis.document;
  const priorObserver = globalThis.MutationObserver;
  const priorElement = globalThis.Element;
  const priorHtmlImg = globalThis.HTMLImageElement;

  class MockElement {}
  class MockImg extends MockElement {
    constructor(src) {
      super();
      this.src = src;
    }
    hasAttribute(attr) { return attr === "src"; }
    getAttribute(attr) { return attr === "src" ? this.src : null; }
    closest(sel) {
      if (sel === "[data-node-id]") return this.owner;
      return null;
    }
    querySelectorAll() { return []; }
  }
  const makeImgNode = () => ({
    hasAttribute(attr) { return attr === "src"; },
    getAttribute(attr) { return attr === "src" ? "assets/skipped.png" : null; },
  });
  const makeBlockNode = () => ({
    getAttribute(attr) { return attr === "data-node-id" ? "block-1" : null; },
    querySelector() { return null; },
    querySelectorAll(selector) { return selector === "img" ? [makeImgNode()] : []; },
  });
  let observerCallback;
  globalThis.Element = MockElement;
  globalThis.HTMLImageElement = MockImg;
  globalThis.MutationObserver = class {
    constructor(cb) { observerCallback = cb; }
    observe() {}
    disconnect() {}
  };
  globalThis.document = {
    createElement(name) {
      assert.equal(name, "template");
      return {
        content: { children: [makeBlockNode()] },
        set innerHTML(_) {},
      };
    },
  };

  try {
    registerAutoUpload(
      plugin,
      scope,
      () => true,
      services,
      { warn() {}, debug() {} },
      notice => notices.push(notice),
    );

    const mockEditor = { querySelectorAll: () => [] };
    const listener = listeners.get("before-upload-assets");
    let completeCallback;
    listener({
      detail: {
        requestId: "upload-skip",
        target: "editor",
        protyle: {
          element: mockEditor,
          block: { rootID: "doc-skip", box: "box-1" },
        },
        onComplete(cb) { completeCallback = cb; },
      },
    });

    const newImg = new MockImg("assets/skipped.png");
    const owner = new MockElement();
    owner.dataset = { nodeId: "block-1" };
    owner.querySelectorAll = () => [newImg];
    owner.closest = () => null;
    newImg.owner = owner;
    observerCallback([{ type: "childList", addedNodes: [newImg] }]);

    completeCallback({
      requestId: "upload-skip",
      status: "success",
      succFiles: [{ index: 0, path: "assets/skipped.png" }],
    });

    await new Promise(resolve => setTimeout(resolve, 80));
    assert.equal(compressCalls, 1);
    assert.equal(notices.length, 0);
  } finally {
    globalThis.document = priorDocument;
    globalThis.MutationObserver = priorObserver;
    globalThis.Element = priorElement;
    globalThis.HTMLImageElement = priorHtmlImg;
    scope.dispose();
  }
});

test("I-03: without new MutationObserver evidence or on pre-existing img attribute mutation, existing images are never touched", async () => {
  const listeners = new Map();
  const plugin = { eventBus: {
    on(name, handler) { listeners.set(name, handler); },
    off(name) { listeners.delete(name); },
  } };
  const scope = new FeatureScope();
  let compressCalls = 0;
  let updateBlockCalls = 0;
  const services = {
    origin: "https://siyuan.test",
    config: () => ({}),
    kernel: {
      async post(url) {
        if (url === "/api/block/updateBlock") updateBlockCalls++;
        return { data: {} };
      },
    },
    compressOccurrence: async () => {
      compressCalls++;
      return { status: "saved", path: "assets/x.webp", reference: "replaced" };
    },
  };
  const priorObserver = globalThis.MutationObserver;
  const priorElement = globalThis.Element;
  const priorHtmlImg = globalThis.HTMLImageElement;

  class MockElement {}
  class MockImg extends MockElement {
    constructor(src) { super(); this.src = src; }
    hasAttribute(attr) { return attr === "src"; }
    getAttribute(attr) { return attr === "src" ? this.src : null; }
    closest(sel) { return sel === "[data-node-id]" ? this.owner : null; }
    querySelectorAll() { return []; }
  }
  const existingImg = new MockImg("assets/existing.png");
  const owner = new MockElement();
  owner.dataset = { nodeId: "block-existing" };
  owner.querySelectorAll = () => [existingImg];
  owner.closest = () => null;
  existingImg.owner = owner;

  let observerCallback;
  globalThis.Element = MockElement;
  globalThis.HTMLImageElement = MockImg;
  globalThis.MutationObserver = class {
    constructor(cb) { observerCallback = cb; }
    observe() {}
    disconnect() {}
  };

  try {
    registerAutoUpload(plugin, scope, () => true, services, { warn() {}, debug() {} });

    const listener = listeners.get("before-upload-assets");
    let completeCallback;
    listener({
      detail: {
        requestId: "upload-reuse",
        target: "editor",
        protyle: {
          element: { querySelectorAll: () => [existingImg] },
          block: { rootID: "doc-1", box: "box-1" },
        },
        onComplete(cb) { completeCallback = cb; },
      },
    });

    // Simulate attribute edit on the pre-existing image (no addedNodes)
    observerCallback([{ type: "attributes", target: existingImg, oldValue: "assets/existing.png" }]);

    completeCallback({
      requestId: "upload-reuse",
      status: "success",
      succFiles: [{ index: 0, path: "assets/existing.png" }],
    });

    await new Promise(resolve => setTimeout(resolve, 140));
    assert.equal(compressCalls, 0);
    assert.equal(updateBlockCalls, 0);
  } finally {
    globalThis.MutationObserver = priorObserver;
    globalThis.Element = priorElement;
    globalThis.HTMLImageElement = priorHtmlImg;
    scope.dispose();
  }
});

test("P1-3: single auto-upload with reference === unknown emits singleReason unknown notice", async () => {
  const listeners = new Map();
  const plugin = { eventBus: {
    on(name, handler) { listeners.set(name, handler); },
    off(name) { listeners.delete(name); },
  } };
  const scope = new FeatureScope();
  const notices = [];
  const services = {
    origin: "https://siyuan.test",
    config: () => ({}),
    kernel: {
      async post(url) {
        if (url === "/api/block/getBlockDOM") {
          return { data: { id: "block-u", dom: '<div data-node-id="block-u"><img src="assets/u.png"/></div>' } };
        }
        return { data: {} };
      },
    },
    compressOccurrence: async () => ({ status: "saved", path: "assets/u.webp", reference: "unknown" }),
  };

  const priorDocument = globalThis.document;
  const priorObserver = globalThis.MutationObserver;
  const priorElement = globalThis.Element;
  const priorHtmlImg = globalThis.HTMLImageElement;

  class MockElement {}
  class MockImg extends MockElement {
    constructor(src) { super(); this.src = src; }
    hasAttribute(attr) { return attr === "src"; }
    getAttribute(attr) { return attr === "src" ? this.src : null; }
    closest(sel) { return sel === "[data-node-id]" ? this.owner : null; }
    querySelectorAll() { return []; }
  }
  const makeImgNode = () => ({
    hasAttribute(attr) { return attr === "src"; },
    getAttribute(attr) { return attr === "src" ? "assets/u.png" : null; },
  });
  const makeBlockNode = () => ({
    getAttribute(attr) { return attr === "data-node-id" ? "block-u" : null; },
    querySelector() { return null; },
    querySelectorAll(selector) { return selector === "img" ? [makeImgNode()] : []; },
  });

  let observerCallback;
  globalThis.Element = MockElement;
  globalThis.HTMLImageElement = MockImg;
  globalThis.MutationObserver = class {
    constructor(cb) { observerCallback = cb; }
    observe() {}
    disconnect() {}
  };
  globalThis.document = {
    createElement: () => ({ content: { children: [makeBlockNode()] }, set innerHTML(_) {} }),
  };

  try {
    registerAutoUpload(plugin, scope, () => true, services, { warn() {}, debug() {} }, n => notices.push(n));
    const listener = listeners.get("before-upload-assets");
    let completeCallback;
    listener({
      detail: {
        requestId: "upload-unknown",
        target: "editor",
        protyle: { element: { querySelectorAll: () => [] }, block: { rootID: "doc-u", box: "box-1" } },
        onComplete(cb) { completeCallback = cb; },
      },
    });
    const newImg = new MockImg("assets/u.png");
    const owner = new MockElement();
    owner.dataset = { nodeId: "block-u" };
    owner.querySelectorAll = () => [newImg];
    owner.closest = () => null;
    newImg.owner = owner;
    observerCallback([{ type: "childList", addedNodes: [newImg] }]);

    completeCallback({
      requestId: "upload-unknown",
      status: "success",
      succFiles: [{ index: 0, path: "assets/u.png" }],
    });
    await new Promise(resolve => setTimeout(resolve, 80));
    assert.equal(notices.length, 1);
    assert.equal(notices[0].singleReason, "unknown");
    assert.equal(notices[0].unknown, 1);
    assert.equal(notices[0].skipped, 0);
    assert.equal(notices[0].total, 1);
  } finally {
    globalThis.document = priorDocument;
    globalThis.MutationObserver = priorObserver;
    globalThis.Element = priorElement;
    globalThis.HTMLImageElement = priorHtmlImg;
    scope.dispose();
  }
});

test("multi-image auto-upload (1 replaced + 1 unknown) counts unknown independently without incrementing skipped", async () => {
  const listeners = new Map();
  const plugin = { eventBus: {
    on(name, handler) { listeners.set(name, handler); },
    off(name) { listeners.delete(name); },
  } };
  const scope = new FeatureScope();
  const notices = [];
  const services = {
    origin: "https://siyuan.test",
    config: () => ({}),
    kernel: {
      async post(url, body) {
        if (url === "/api/block/getBlockDOM") {
          const src = body.id === "block-ok" ? "assets/ok.png" : "assets/unk.png";
          return { data: { id: body.id, dom: `<div data-node-id="${body.id}"><img src="${src}"/></div>` } };
        }
        return { data: {} };
      },
    },
    compressOccurrence: async (target) => {
      if (target.oldPath === "assets/ok.png") {
        return { status: "saved", path: "assets/ok.webp", reference: "replaced" };
      }
      return { status: "saved", path: "assets/unk.webp", reference: "unknown" };
    },
  };

  const priorDocument = globalThis.document;
  const priorObserver = globalThis.MutationObserver;
  const priorElement = globalThis.Element;
  const priorHtmlImg = globalThis.HTMLImageElement;

  class MockElement {}
  class MockImg extends MockElement {
    constructor(src) { super(); this.src = src; }
    hasAttribute(attr) { return attr === "src"; }
    getAttribute(attr) { return attr === "src" ? this.src : null; }
    closest(sel) { return sel === "[data-node-id]" ? this.owner : null; }
    querySelectorAll() { return []; }
  }

  let observerCallback;
  globalThis.Element = MockElement;
  globalThis.HTMLImageElement = MockImg;
  globalThis.MutationObserver = class {
    constructor(cb) { observerCallback = cb; }
    observe() {}
    disconnect() {}
  };
  globalThis.document = {
    createElement: () => {
      let html = "";
      return {
        set innerHTML(v) { html = v; },
        get content() {
          const idMatch = /data-node-id="([^"]+)"/.exec(html);
          const srcMatch = /src="([^"]+)"/.exec(html);
          const imgNode = {
            hasAttribute: attr => attr === "src",
            getAttribute: attr => (attr === "src" ? srcMatch?.[1] ?? null : null),
          };
          const blockNode = {
            getAttribute: attr => (attr === "data-node-id" ? idMatch?.[1] ?? null : null),
            querySelector: () => null,
            querySelectorAll: sel => (sel === "img" ? [imgNode] : []),
          };
          return { children: [blockNode] };
        },
      };
    },
  };

  try {
    registerAutoUpload(plugin, scope, () => true, services, { warn() {}, debug() {} }, n => notices.push(n));
    const listener = listeners.get("before-upload-assets");
    let completeCallback;
    listener({
      detail: {
        requestId: "upload-multi-unknown",
        target: "editor",
        protyle: { element: { querySelectorAll: () => [] }, block: { rootID: "doc-m", box: "box-1" } },
        onComplete(cb) { completeCallback = cb; },
      },
    });

    const imgOk = new MockImg("assets/ok.png");
    const ownerOk = new MockElement();
    ownerOk.dataset = { nodeId: "block-ok" };
    ownerOk.querySelectorAll = () => [imgOk];
    ownerOk.closest = () => null;
    imgOk.owner = ownerOk;

    const imgUnk = new MockImg("assets/unk.png");
    const ownerUnk = new MockElement();
    ownerUnk.dataset = { nodeId: "block-unk" };
    ownerUnk.querySelectorAll = () => [imgUnk];
    ownerUnk.closest = () => null;
    imgUnk.owner = ownerUnk;

    observerCallback([{ type: "childList", addedNodes: [imgOk, imgUnk] }]);

    completeCallback({
      requestId: "upload-multi-unknown",
      status: "success",
      succFiles: [
        { index: 0, path: "assets/ok.png" },
        { index: 1, path: "assets/unk.png" },
      ],
    });
    await new Promise(resolve => setTimeout(resolve, 80));
    assert.equal(notices.length, 1);
    assert.deepEqual(notices[0], {
      total: 2,
      successful: 1,
      skipped: 0,
      failed: 0,
      unknown: 1,
      singleReason: undefined,
    });
  } finally {
    globalThis.document = priorDocument;
    globalThis.MutationObserver = priorObserver;
    globalThis.Element = priorElement;
    globalThis.HTMLImageElement = priorHtmlImg;
    scope.dispose();
  }
});

test("synchronously unauthorized document upload does not register onComplete or observer", () => {
  const listeners = new Map();
  const plugin = { eventBus: {
    on(name, handler) { listeners.set(name, handler); },
    off(name) { listeners.delete(name); },
  } };
  const scope = new FeatureScope();
  let registered = false;
  registerAutoUpload(
    plugin,
    scope,
    () => false, // synchronous false
    { origin: "https://siyuan.test", config: () => ({}) },
    { warn() {}, debug() {} },
  );
  listeners.get("before-upload-assets")({
    detail: {
      requestId: "sync-unauth",
      target: "editor",
      protyle: { block: { rootID: "doc-1", box: "box-1" } },
      onComplete() { registered = true; },
    },
  });
  assert.equal(registered, false);
  scope.dispose();
});

test("AssetStore verifies upload persistence from kernel upload contract without re-download", async () => {
  const { AssetStore, UploadOutcomeUnknown } = await import("../../../src/features/image-compressor/services/assets.ts");
  const kernelSuccess = {
    post: async () => ({
      code: 0,
      data: {
        errFiles: [],
        failedFiles: [],
        succFiles: [{ index: 0, path: "assets/verified.webp" }],
      },
    }),
  };
  const store = new AssetStore(kernelSuccess, "https://siyuan.test");
  const testFile = new File(["dummy"], "test.webp", { type: "image/webp" });
  const path = await store.upload(testFile, "20240101000000-abcdefg");
  assert.equal(path, "assets/verified.webp");

  const kernelFailed = {
    post: async () => ({
      code: 0,
      data: {
        errFiles: ["error"],
        failedFiles: [{ index: 0, path: "assets/bad.webp" }],
        succFiles: [],
      },
    }),
  };
  const storeFailed = new AssetStore(kernelFailed, "https://siyuan.test");
  await assert.rejects(storeFailed.upload(testFile, "20240101000000-abcdefg"), UploadOutcomeUnknown);
});

test("I-01: AssetStore.upload rethrows rejected and not-sent errors directly without wrapping in UploadOutcomeUnknown", async () => {
  const { AssetStore, UploadOutcomeUnknown } = await import("../../../src/features/image-compressor/services/assets.ts");
  const testFile = new File(["dummy"], "test.webp", { type: "image/webp" });

  const rejectedErr = Object.assign(new Error("Payload too large"), { outcome: "rejected", code: -1 });
  const rejectedStore = new AssetStore({ post: async () => { throw rejectedErr; } }, "https://siyuan.test");
  await assert.rejects(
    rejectedStore.upload(testFile, "20240101000000-abcdefg"),
    err => err === rejectedErr && !(err instanceof UploadOutcomeUnknown),
  );

  const notSentErr = Object.assign(new Error("Operation cancelled"), { outcome: "not-sent", name: "AbortError" });
  const notSentStore = new AssetStore({ post: async () => { throw notSentErr; } }, "https://siyuan.test");
  await assert.rejects(
    notSentStore.upload(testFile, "20240101000000-abcdefg"),
    err => err === notSentErr && !(err instanceof UploadOutcomeUnknown),
  );

  const unknownErr = Object.assign(new Error("Connection reset"), { outcome: "unknown" });
  const unknownStore = new AssetStore({ post: async () => { throw unknownErr; } }, "https://siyuan.test");
  await assert.rejects(
    unknownStore.upload(testFile, "20240101000000-abcdefg"),
    UploadOutcomeUnknown,
  );

  // Post-dispatch abort (signal aborted after request sent, outcome === "unknown", name === "AbortError")
  // MUST throw UploadOutcomeUnknown so unknown upload state is never masked as clean cancellation.
  const postAbortController = new AbortController();
  const postAbortStore = new AssetStore({
    post: async () => {
      postAbortController.abort();
      throw Object.assign(new Error("Operation cancelled"), { outcome: "unknown", name: "AbortError" });
    },
  }, "https://siyuan.test");
  await assert.rejects(
    postAbortStore.upload(testFile, "20240101000000-abcdefg", postAbortController.signal),
    UploadOutcomeUnknown,
  );

  // Cause-wrapped rejected / not-sent errors are unwrapped via getKernelOutcome and rethrown directly
  const wrappedRejected = new Error("outer", { cause: rejectedErr });
  const wrappedRejectedStore = new AssetStore({ post: async () => { throw wrappedRejected; } }, "https://siyuan.test");
  await assert.rejects(
    wrappedRejectedStore.upload(testFile, "20240101000000-abcdefg"),
    err => err === wrappedRejected && !(err instanceof UploadOutcomeUnknown),
  );
});

test("H1: before-upload-assets listener swallows synchronous errors from services.config() without breaking native upload", () => {
  const listeners = new Map();
  const plugin = { eventBus: {
    on(name, handler) { listeners.set(name, handler); },
    off(name) { listeners.delete(name); },
  } };
  const scope = new FeatureScope();
  const warnings = [];
  registerAutoUpload(
    plugin,
    scope,
    () => true,
    { origin: "https://siyuan.test", config() { throw new Error("boom in config"); } },
    { warn(msg, data) { warnings.push({ msg, data }); }, debug() {} },
  );

  const listener = listeners.get("before-upload-assets");
  assert.doesNotThrow(() => {
    listener({
      detail: {
        requestId: "upload-err-config",
        target: "editor",
        protyle: { block: { rootID: "20240101000000-abcdefg", box: "20240101000000-abcdefg" } },
        onComplete() {},
      },
    });
  });
  assert.equal(warnings.length, 1);
  scope.dispose();
});

test("H1: before-upload-assets listener disconnects MutationObserver and swallows errors if onComplete registration throws", () => {
  const listeners = new Map();
  const plugin = { eventBus: {
    on(name, handler) { listeners.set(name, handler); },
    off(name) { listeners.delete(name); },
  } };
  const scope = new FeatureScope();
  const warnings = [];
  const priorObserver = globalThis.MutationObserver;
  const instances = [];
  globalThis.MutationObserver = class {
    constructor() {
      this.observed = false;
      this.disconnected = false;
      instances.push(this);
    }
    observe() { this.observed = true; }
    disconnect() { this.disconnected = true; }
  };

  try {
    registerAutoUpload(
      plugin,
      scope,
      () => true,
      { origin: "https://siyuan.test", config: () => ({}) },
      { warn(msg, data) { warnings.push({ msg, data }); }, debug() {} },
    );

    const listener = listeners.get("before-upload-assets");
    assert.doesNotThrow(() => {
      listener({
        detail: {
          requestId: "upload-err-observer",
          target: "editor",
          protyle: {
            element: {},
            block: { rootID: "20240101000000-abcdefg", box: "20240101000000-abcdefg" },
          },
          onComplete() { throw new Error("onComplete failed"); },
        },
      });
    });
    assert.equal(instances.length, 1);
    assert.equal(instances[0].observed, true);
    assert.equal(instances[0].disconnected, true);
    assert.equal(warnings.length, 1);
  } finally {
    globalThis.MutationObserver = priorObserver;
    scope.dispose();
  }
});
