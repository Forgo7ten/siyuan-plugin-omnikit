import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { stripTypeScriptTypes } from "node:module";

const source = await readFile(new URL("../../src/core/host/KernelClient.ts", import.meta.url), "utf8");
const kernelOutcomeUrl = new URL("../../src/core/host/kernelOutcome.ts", import.meta.url).href;
const runnable = stripTypeScriptTypes(
  source
    .replace('import { fetchSyncPost } from "siyuan";', "const fetchSyncPost = globalThis.__kernelFetchPost;")
    .replace('./kernelOutcome.ts', kernelOutcomeUrl),
);
const { KernelClient, KernelRequestError, getKernelOutcome } = await import(`data:text/javascript,${encodeURIComponent(runnable)}`);

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

test("settles rejected promise from fetchSyncPost as unknown", async () => {
  const client = new KernelClient(async () => {
    throw new Error("offline");
  });
  await assert.rejects(client.post("/write", {}), error => error.message === "offline" && error.outcome === "unknown");
});

test("preserves the HTTP-derived API code and marks outcome rejected when an endpoint returns negative code", async () => {
  const client = new KernelClient(async () => ({ code: -404, data: null, msg: "Not Found" }));
  await assert.rejects(
    client.post("/api/asset/findAssetReferences", {}),
    error => error.code === -404 && error.outcome === "rejected",
  );
});

test("immediately rejects with outcome rejected when kernel returns non-zero business code", async () => {
  const negClient = new KernelClient(async () => ({ code: -1, data: null, msg: "block not found" }));
  await assert.rejects(
    negClient.post("/api/block/getBlockInfo", { id: "none" }),
    error => error.code === -1 && error.message === "block not found" && error.outcome === "rejected",
  );

  const posClient = new KernelClient(async () => ({ code: 1, data: null, msg: "write failed" }));
  await assert.rejects(
    posClient.post("/api/block/updateBlock", {}),
    error => error.code === 1 && error.message === "write failed" && error.outcome === "rejected",
  );
});

test("marks empty, null, or non-object kernel responses as unknown", async () => {
  for (const response of [null, undefined, "", "oops", {}]) {
    const client = new KernelClient(async () => response);
    await assert.rejects(
      client.post("/api/block/updateBlock", {}),
      error => error.outcome === "unknown",
    );
  }
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

test("getKernelOutcome extracts direct and cause-chained outcomes safely including cyclic causes", () => {
  assert.equal(getKernelOutcome(new KernelRequestError("c", "not-sent", "AbortError")), "not-sent");
  assert.equal(getKernelOutcome(new KernelRequestError("r", "rejected")), "rejected");
  assert.equal(getKernelOutcome(new KernelRequestError("u", "unknown")), "unknown");

  const deep = new Error("outer", { cause: new Error("mid", { cause: { outcome: "rejected" } }) });
  assert.equal(getKernelOutcome(deep), "rejected");

  const cyclicA = { name: "Error" };
  const cyclicB = { name: "Error", cause: cyclicA };
  cyclicA.cause = cyclicB;
  assert.equal(getKernelOutcome(cyclicA), undefined);

  assert.equal(getKernelOutcome(null), undefined);
  assert.equal(getKernelOutcome("not-sent"), undefined);
  assert.equal(getKernelOutcome({ outcome: "other" }), undefined);
});
