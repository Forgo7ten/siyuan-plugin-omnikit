import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { stripTypeScriptTypes } from "node:module";

const source = await readFile(new URL("../src/core/KernelClient.ts", import.meta.url), "utf8");
const runnable = stripTypeScriptTypes(source.replace('import { fetchPost } from "siyuan";', "const fetchPost = globalThis.__kernelFetchPost;"));
const { KernelClient } = await import(`data:text/javascript,${encodeURIComponent(runnable)}`);

test("settles callback success and supports JSON and FormData bodies", async () => {
  const bodies = [];
  const client = new KernelClient((path, body, callback) => { bodies.push(body); callback({ code: 0, data: path, msg: "" }); });
  assert.equal((await client.post("/json", { id: "x" })).data, "/json");
  const form = new FormData();
  await client.post("/form", form);
  assert.deepEqual(bodies, [{ id: "x" }, form]);
});

test("settles SDK failure callback", async () => {
  const client = new KernelClient((_path, _body, _ok, _headers, fail) => fail({ msg: "offline" }));
  await assert.rejects(client.post("/write", {}), /offline/);
});

test("settles cancellation even when SDK swallows AbortError and ignores callbacks", async () => {
  let forwardedSignal;
  const client = new KernelClient((_path, _body, _ok, _headers, _fail, signal) => { forwardedSignal = signal; });
  const controller = new AbortController();
  const pending = client.post("/write", {}, { signal: controller.signal });
  assert.equal(forwardedSignal, controller.signal);
  controller.abort();
  await assert.rejects(pending, error => error.name === "AbortError" && error.outcome === "unknown");
});

test("settles timeout even when no SDK callback occurs and marks write result unknown", async () => {
  const client = new KernelClient(() => {});
  await assert.rejects(client.post("/write", {}, { timeout: 5 }), error => error.name === "TimeoutError" && error.outcome === "unknown");
});

test("settles only once if the SDK invokes more than one callback", async () => {
  const client = new KernelClient((_path, _body, ok, _headers, fail) => { ok({ code: 0, data: 1 }); fail({ msg: "late failure" }); });
  assert.equal((await client.post("/read", {})).data, 1);
});
