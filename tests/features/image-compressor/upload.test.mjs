import { test } from "node:test";
import assert from "node:assert/strict";
import { FeatureScope } from "../../../src/core/framework/FeatureScope.ts";
import { completedUploadPaths, registerAutoUpload, waitForObservedImages } from "../../../src/features/image-compressor/actions/AutoUploadHandler.ts";

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
  registerAutoUpload(plugin, scope, async () => true, services,
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
  const services = { origin: "https://siyuan.test", config: () => ({}) };
  const notices = [];
  registerAutoUpload(
    plugin,
    scope,
    async () => false, // unauthorized!
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

  completeCallback({
    requestId: "upload-unauth",
    status: "success",
    succFiles: [{ index: 0, path: "assets/unauth.png" }],
  });

  await new Promise(resolve => setTimeout(resolve, 50));
  assert.equal(notices.length, 0);
  scope.dispose();
});

test("upload where all images are skipped remains completely silent without emitting notices", async () => {
  const listeners = new Map();
  const plugin = { eventBus: {
    on(name, handler) { listeners.set(name, handler); },
    off(name) { listeners.delete(name); },
  } };
  const scope = new FeatureScope();
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
    compressOccurrence: async () => ({ status: "skipped" }),
  };
  const notices = [];
  registerAutoUpload(
    plugin,
    scope,
    async () => true, // authorized
    services,
    { warn() {}, debug() {} },
    notice => notices.push(notice),
  );

  const mockEditor = {
    querySelectorAll() {
      const img = {
        hasAttribute(attr) { return attr === "src"; },
        getAttribute(attr) { return attr === "src" ? "assets/skipped.png" : null; },
        closest() {
          return {
            dataset: { nodeId: "block-1" },
            querySelectorAll() { return [img]; },
          };
        },
      };
      return [img];
    },
  };

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

  completeCallback({
    requestId: "upload-skip",
    status: "success",
    succFiles: [{ index: 0, path: "assets/skipped.png" }],
  });

  await new Promise(resolve => setTimeout(resolve, 50));
  assert.equal(notices.length, 0);
  scope.dispose();
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
