import { test } from "node:test";
import assert from "node:assert/strict";
import { FeatureScope } from "../src/core/FeatureScope.ts";
import { registerAutoUpload } from "../src/features/image-compressor/AutoUploadHandler.ts";
import { compressionDefaults } from "../src/features/image-compressor/settings.ts";

function setup(compress) {
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
