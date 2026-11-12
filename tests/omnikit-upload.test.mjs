import { test } from "node:test";
import assert from "node:assert/strict";
import { FeatureScope } from "../src/core/FeatureScope.ts";
import { registerAutoUpload } from "../src/features/image-compressor/AutoUploadHandler.ts";
import { defaultImageFeatureConfig } from "../src/features/image-compressor/parseImageConfig.ts";

function setup({ encode, read, archive, config: suppliedConfig } = {}, onNotice = () => {}) {
  const listeners = new Map();
  const plugin = {
    eventBus: {
      on(name, handler) { listeners.set(name, handler); },
      off(name) { listeners.delete(name); },
    },
  };
  const scope = new FeatureScope();
  const config = suppliedConfig ?? defaultImageFeatureConfig();
  config.auto.uploads = true;
  config.sources.desktopLocalFiles = true;
  const services = {
    origin: "https://siyuan.test",
    config: () => config,
    reader: { read: read ?? (async source => ({ blob: new Blob([source.fileURL]), name: source.name })) },
    encoder: { encode: encode ?? (async file => ({
      kind: "encoded",
      value: { file: new File([`compressed:${file.name}`], file.name.replace(/\.[^.]+$/, ".webp"), { type: "image/webp" }) },
    })) },
    assets: { archive: archive ?? (async file => `/assets/${file.name}`) },
  };
  registerAutoUpload(plugin, scope, () => true, async () => true, services,
    { warn() {}, debug() {} }, onNotice);
  return { listener: listeners.get("before-upload-assets"), scope, services, config };
}

function uploadDetail(input, extra = {}) {
  return {
    requestId: "upload-1",
    target: "editor",
    protyle: { block: { rootID: "20240101000000-abcdefg" } },
    input,
    ...extra,
  };
}

test("respondWith and onComplete register synchronously; replacements preserve file order", async () => {
  const notices = [];
  const { listener, scope } = setup({ config: defaultImageFeatureConfig() }, notice => notices.push(notice));
  const originals = ["a.png", "b.png", "notes.txt"].map(name => new File([name], name));
  let response;
  let complete;
  let respondCalls = 0;
  let completeCalls = 0;
  listener({ detail: uploadDetail({ kind: "files", files: originals }, {
    onComplete(callback) { completeCalls++; complete = callback; },
    respondWith(value) { respondCalls++; response = value; },
  }) });

  assert.equal(respondCalls, 1);
  assert.equal(completeCalls, 1);
  assert.ok(response instanceof Promise);
  const decision = await response;
  assert.equal(decision.action, "replace");
  assert.deepEqual(decision.input.files.map(file => file.name), ["a.webp", "b.webp", "notes.txt"]);
  assert.deepEqual(notices, []);
  complete({ requestId: "upload-1", status: "success", acceptedInput: decision.input,
    input: decision.input, succFiles: [0, 1, 2].map(index => ({ index })) });
  assert.deepEqual(notices, [{ status: "success", count: 2 }]);
  scope.dispose();
});

test("local-files are materialized as a whole in order, while non-images remain unchanged", async () => {
  const reads = [];
  const { listener, scope } = setup({ read: async source => {
    reads.push(source.fileURL);
    return { blob: new Blob([source.fileURL]), name: source.name };
  } });
  const paths = ["/tmp/first.png", "/tmp/readme.txt", "/tmp/last.jpg"];
  let response;
  listener({ detail: uploadDetail({ kind: "local-files", files: paths.map(path => ({ path, size: 10 })) }, {
    respondWith(value) { response = value; },
  }) });
  const decision = await response;
  assert.deepEqual(reads.map(url => decodeURIComponent(new URL(url).pathname)), paths);
  assert.equal(decision.input.kind, "files");
  assert.deepEqual(decision.input.files.map(file => file.name), ["first.webp", "readme.txt", "last.webp"]);
  scope.dispose();
});

test("one local read failure returns the complete original local-files input", async () => {
  let encodeCalls = 0;
  const { listener, scope } = setup({
    read: async source => {
      if (source.fileURL.includes("broken")) throw new Error("read denied");
      return { blob: new Blob(["bytes"]), name: source.name };
    },
    encode: async () => { encodeCalls++; return { kind: "skipped" }; },
  });
  const input = { kind: "local-files", files: [
    { path: "/tmp/first.png", size: 5 }, { path: "/tmp/broken.png", size: 5 }, { path: "/tmp/last.png", size: 5 },
  ] };
  let response;
  listener({ detail: uploadDetail(input, { respondWith(value) { response = value; } }) });
  const decision = await response;
  assert.equal(decision.input, input);
  assert.equal(encodeCalls, 0);
  scope.dispose();
});

test("original retention follows total input count, including mixed non-image uploads", async () => {
  const singleConfig = defaultImageFeatureConfig();
  singleConfig.retention.deleteSingleOriginal = true;
  const singleArchives = [];
  const single = setup({ config: singleConfig, archive: async file => singleArchives.push(file.name) });
  const original = new File(["one"], "one.png", { type: "image/png" });
  let singleResponse;
  single.listener({ detail: uploadDetail({ kind: "files", files: [original] }, { respondWith(value) { singleResponse = value; } }) });
  await singleResponse;
  assert.deepEqual(singleArchives, []);
  single.scope.dispose();

  const batchConfig = defaultImageFeatureConfig();
  batchConfig.retention.deleteSingleOriginal = true;
  const archived = [];
  const batch = setup({ config: batchConfig, archive: async file => archived.push(file.name) });
  const inputs = [new File(["image"], "only-image.png"), new File(["text"], "document.txt")];
  let batchResponse;
  batch.listener({ detail: uploadDetail({ kind: "files", files: inputs }, { respondWith(value) { batchResponse = value; } }) });
  const decision = await batchResponse;
  assert.deepEqual(archived, ["only-image.png"]);
  assert.deepEqual(decision.input.files.map(file => file.name), ["only-image.webp", "document.txt"]);
  batch.scope.dispose();
});

test("archive failure keeps that original file; legacy completion fallback reports prepared", async () => {
  const notices = [];
  const { listener, scope } = setup({ archive: async () => { throw new Error("archive denied"); } }, notice => notices.push(notice));
  const originals = [new File(["one"], "one.png"), new File(["two"], "two.png")];
  let response;
  listener({ detail: uploadDetail({ kind: "files", files: originals }, { respondWith(value) { response = value; } }) });
  const decision = await response;
  assert.deepEqual(decision.input.files, originals);
  assert.deepEqual(notices, []);
  scope.dispose();

  const prepared = [];
  const second = setup({ config: (() => { const c = defaultImageFeatureConfig(); c.retention.deleteSingleOriginal = true; return c; })() },
    notice => prepared.push(notice));
  let secondResponse;
  second.listener({ detail: uploadDetail({ kind: "files", files: [originals[0]] }, { respondWith(value) { secondResponse = value; } }) });
  await secondResponse;
  assert.deepEqual(prepared, [{ status: "prepared", count: 1 }]);
  second.scope.dispose();
});

test("host cancellation returns the exact original input", async () => {
  const { listener, scope } = setup({ encode: async (_file, _name, _config, signal) => {
    await new Promise(resolve => setTimeout(resolve, 15));
    if (signal.aborted) return { kind: "skipped" };
    return { kind: "encoded", value: { file: new File(["compressed"], "one.webp", { type: "image/webp" }) } };
  } });
  const input = { kind: "files", files: [new File(["one"], "one.png")] };
  const host = new AbortController();
  let response;
  listener({ detail: uploadDetail(input, { signal: host.signal, respondWith(value) { response = value; } }) });
  setTimeout(() => host.abort("cancel upload"), 1);
  const decision = await response;
  assert.equal(decision.input, input);
  scope.dispose();
});
