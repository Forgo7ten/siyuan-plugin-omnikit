import { test } from "node:test";
import assert from "node:assert/strict";
import { FeatureScope } from "../src/core/FeatureScope.ts";
import { registerAutoUpload } from "../src/features/image-compressor/AutoUploadHandler.ts";
import { compressionDefaults } from "../src/features/image-compressor/settings.ts";

function setup(compress, onNotice = () => {}) {
  const listeners = new Map();
  const plugin = {
    eventBus: {
      on(name, handler) { listeners.set(name, handler); },
      off(name) { listeners.delete(name); },
    },
  };
  const scope = new FeatureScope();
  registerAutoUpload(
    plugin,
    scope,
    () => true,
    async () => true,
    { compress },
    () => compressionDefaults,
    { warn() {}, debug() {} },
    onNotice,
  );
  return { listener: listeners.get("before-upload-assets"), scope };
}

test("upload handler registers respondWith synchronously and preserves file ordering", async () => {
  const { listener, scope } = setup(async file => {
    await new Promise(resolve => setTimeout(resolve, file.name === "b.png" ? 8 : 1));
    return { blob: new Blob([file.name], { type: "image/webp" }) };
  });
  const originals = ["a.png", "b.png", "c.png"].map(name => new File([name], name, { type: "image/png" }));
  let response;
  let calls = 0;
  listener({ detail: {
    target: "editor",
    protyle: { block: { rootID: "root-1" } },
    input: { kind: "files", files: originals },
    respondWith(value) { calls++; response = value; },
  } });

  assert.equal(calls, 1);
  assert.ok(response instanceof Promise, "respondWith is called before the event listener returns");
  const decision = await response;
  assert.equal(decision.action, "replace");
  assert.deepEqual(decision.input.files.map(file => file.name), ["a.webp", "b.webp", "c.webp"]);
  scope.dispose();
});

test("host cancellation returns the original ordered file batch", async () => {
  const { listener, scope } = setup(async file => {
    await new Promise(resolve => setTimeout(resolve, 15));
    return { blob: new Blob([file.name], { type: "image/webp" }) };
  });
  const originals = ["first.png", "second.png"].map(name => new File([name], name, { type: "image/png" }));
  const host = new AbortController();
  let response;
  listener({ detail: {
    target: "editor",
    protyle: { block: { rootID: "root-1" } },
    signal: host.signal,
    input: { kind: "files", files: originals },
    respondWith(value) { response = value; },
  } });
  setTimeout(() => host.abort("cancel upload"), 1);
  const decision = await response;
  assert.deepEqual(decision.input.files, originals);
  scope.dispose();
});

test("completion callback is registered synchronously and reports final upload status once", async () => {
  for (const status of ["success", "partial", "failed", "canceled"]) {
    const notices = [];
    const { listener, scope } = setup(async () => ({ blob: new Blob(["compressed"]) }), notice => notices.push(notice));
    const originals = ["one.png", "two.png"].map(name => new File([name], name, { type: "image/png" }));
    let response;
    let complete;
    let calls = 0;
    listener({ detail: {
      requestId: `request-${status}`,
      target: "editor",
      protyle: { block: { rootID: "root-1" } },
      input: { kind: "files", files: originals },
      onComplete(callback) { calls++; complete = callback; },
      respondWith(value) { response = value; },
    } });
    assert.equal(calls, 1, "onComplete is registered in the event dispatch turn");
    await response;
    assert.equal(notices.length, 0, "compression alone does not report an uploaded result");
    // Use the actual output identities returned through respondWith.
    const uploaded = (await response).input.files;
    complete({ requestId: `request-${status}`, status, input: { kind: "files", files: uploaded } });
    complete({ requestId: `request-${status}`, status, input: { kind: "files", files: uploaded } });
    assert.deepEqual(notices, [{ status, count: 2 }]);
    scope.dispose();
  }
});

test("legacy host without onComplete reports prepared once, only after respondWith succeeds", async () => {
  const notices = [];
  const { listener, scope } = setup(async () => ({ blob: new Blob(["compressed"]) }), notice => notices.push(notice));
  const original = new File(["original"], "one.png", { type: "image/png" });
  let response;
  listener({ detail: {
    target: "editor", protyle: { block: { rootID: "root-1" } },
    input: { kind: "files", files: [original] }, respondWith(value) { response = value; },
  } });
  await response;
  assert.deepEqual(notices, [{ status: "prepared", count: 1 }]);
  scope.dispose();

  const failedNotices = [];
  const failed = setup(async () => ({ blob: new Blob(["compressed"]) }), notice => failedNotices.push(notice));
  failed.listener({ detail: {
    target: "editor", protyle: { block: { rootID: "root-1" } },
    input: { kind: "files", files: [original] }, respondWith() { throw new Error("host rejected registration"); },
  } });
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.deepEqual(failedNotices, []);
  failed.scope.dispose();
});

test("completion request mismatch and batches without replacements do not notify", async () => {
  const notices = [];
  const { listener, scope } = setup(async () => undefined, notice => notices.push(notice));
  const original = new File(["original"], "one.png", { type: "image/png" });
  let response;
  let complete;
  listener({ detail: {
    requestId: "request-1", target: "editor", protyle: { block: { rootID: "root-1" } },
    input: { kind: "files", files: [original] }, onComplete(callback) { complete = callback; },
    respondWith(value) { response = value; },
  } });
  const output = await response;
  complete({ requestId: "different", status: "success", input: output.input });
  assert.deepEqual(notices, []);
  scope.dispose();
});

test("falls back when completion registration fails and ignores compressed files replaced later", async () => {
  const original = new File(["original"], "one.png", { type: "image/png" });
  const prepared = [];
  const first = setup(async () => ({ blob: new Blob(["compressed"]) }), notice => prepared.push(notice));
  let firstResponse;
  first.listener({ detail: {
    requestId: "request-1", target: "editor", protyle: { block: { rootID: "root-1" } },
    input: { kind: "files", files: [original] },
    onComplete() { throw new Error("registration failed"); },
    respondWith(value) { firstResponse = value; },
  } });
  await firstResponse;
  assert.deepEqual(prepared, [{ status: "prepared", count: 1 }]);
  first.scope.dispose();

  const notices = [];
  const second = setup(async () => ({ blob: new Blob(["compressed"]) }), notice => notices.push(notice));
  let secondResponse;
  let complete;
  second.listener({ detail: {
    requestId: "request-2", target: "editor", protyle: { block: { rootID: "root-1" } },
    input: { kind: "files", files: [original] },
    onComplete(callback) { complete = callback; },
    respondWith(value) { secondResponse = value; },
  } });
  await secondResponse;
  complete({ requestId: "request-2", status: "success", input: { kind: "files", files: [original] } });
  assert.deepEqual(notices, []);
  second.scope.dispose();
});
