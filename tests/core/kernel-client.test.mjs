import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { stripTypeScriptTypes } from "node:module";

const source = await readFile(new URL("../../src/core/host/KernelClient.ts", import.meta.url), "utf8");
const runnable = stripTypeScriptTypes(
  source.replace('import { fetchSyncPost } from "siyuan";', "const fetchSyncPost = globalThis.__kernelFetchPost;"),
);
const { KernelClient } = await import(`data:text/javascript,${encodeURIComponent(runnable)}`);

test("settles success and supports JSON and FormData bodies", async () => {
  const bodies = [];
  const client = new KernelClient(async (path, body) => {
    bodies.push(body);
    return { code: 0, data: path, msg: "" };
  });
  assert.equal((await client.post("/json", { id: "x" })).data, "/json");
  const form = new FormData();
  await client.post("/form", form);
  assert.deepEqual(bodies, [{ id: "x" }, form]);
});

test("settles rejected promise from fetchSyncPost", async () => {
  const client = new KernelClient(async () => {
    throw new Error("offline");
  });
  await assert.rejects(client.post("/write", {}), /offline/);
});

test("preserves the HTTP-derived API code when an endpoint returns negative code", async () => {
  const client = new KernelClient(async () => ({ code: -404, data: null, msg: "Not Found" }));
  await assert.rejects(client.post("/api/asset/findAssetReferences", {}), error => error.code === -404);
});

test("immediately rejects when kernel returns negative business code without 30s timeout", async () => {
  const client = new KernelClient(async () => ({ code: -1, data: null, msg: "block not found" }));
  await assert.rejects(
    client.post("/api/block/getBlockInfo", { id: "none" }),
    error => error.code === -1 && error.message === "block not found",
  );
});

test("settles cancellation even when SDK swallows AbortError", async () => {
  let forwardedSignal;
  const client = new KernelClient((_path, _body, _headers, _process, signal) => {
    forwardedSignal = signal;
    return new Promise(() => {});
  });
  const controller = new AbortController();
  const pending = client.post("/write", {}, { signal: controller.signal });
  assert.equal(forwardedSignal.aborted, false);
  controller.abort();
  assert.equal(forwardedSignal.aborted, true);
  await assert.rejects(pending, error => error.name === "AbortError" && error.outcome === "unknown");
});

test("settles timeout even when no SDK response occurs and marks write result unknown", async () => {
  let forwardedSignal;
  const client = new KernelClient((_path, _body, _headers, _process, signal) => {
    forwardedSignal = signal;
    return new Promise(() => {});
  });
  await assert.rejects(client.post("/write", {}, { timeout: 5 }), error => error.name === "TimeoutError" && error.outcome === "unknown");
  assert.equal(forwardedSignal.aborted, true);
});

test("settles immediately if already aborted before request", async () => {
  const controller = new AbortController();
  controller.abort();
  const client = new KernelClient(async () => ({ code: 0, data: "ok", msg: "" }));
  await assert.rejects(
    client.post("/write", {}, { signal: controller.signal }),
    error => error.name === "AbortError" && error.outcome === "not-sent",
  );
});
