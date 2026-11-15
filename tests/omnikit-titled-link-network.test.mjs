import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { stripTypeScriptTypes } from "node:module";

const source = await readFile(new URL("../src/features/titled-link/services/dual-track-fetcher.ts", import.meta.url), "utf8");
const { fetchTitleResource } = await import(`data:text/javascript,${encodeURIComponent(stripTypeScriptTypes(source))}`);

test("native desktop uses credential-free direct fetch with the configured user agent", async () => {
  let request;
  const bytes = new TextEncoder().encode("<title>Direct</title>");
  const resource = await fetchTitleResource({
    url: "https://example.com",
    frontend: "desktop",
    userAgent: "OmniKit UA",
    kernelClient: { post: () => assert.fail("proxy must not be used") },
    fetchImpl: async (url, init) => {
      request = { url, init };
      return new Response(bytes, { status: 200, headers: { "content-type": "text/html; charset=utf-8" } });
    },
  });
  assert.equal(request.url, "https://example.com");
  assert.equal(request.init.credentials, "omit");
  assert.equal(request.init.referrerPolicy, "no-referrer");
  assert.equal(request.init.headers["User-Agent"], "OmniKit UA");
  assert.equal(resource.transport, "direct");
  assert.ok(resource.body instanceof ReadableStream);
  await resource.body.cancel();
});

test("browser and mobile hosts use forwardProxy base64 to preserve original bytes", async () => {
  const original = Uint8Array.from([0xd6, 0xd0, 0xce, 0xc4]);
  let call;
  const resource = await fetchTitleResource({
    url: "https://example.com/gbk",
    frontend: "browser-desktop",
    userAgent: "OmniKit UA",
    kernelClient: {
      async post(path, body, options) {
        call = { path, body, options };
        return { data: {
          url: body.url, status: 200, contentType: "text/html; charset=gbk",
          body: Buffer.from(original).toString("base64"), bodyEncoding: "base64",
          headers: {}, elapsed: 1,
        } };
      },
    },
  });
  assert.equal(call.path, "/api/network/forwardProxy");
  assert.equal(call.body.method, "GET");
  assert.equal(call.body.responseEncoding, "base64");
  assert.equal(call.body.timeout, 8_000);
  assert.deepEqual(call.body.headers, [{ "User-Agent": "OmniKit UA" }, { Referer: "" }]);
  assert.equal(resource.transport, "proxy");
  assert.deepEqual(resource.body, original);
});

test("rejects a proxy response that did not preserve binary bytes", async () => {
  await assert.rejects(fetchTitleResource({
    url: "https://example.com",
    frontend: "mobile",
    userAgent: "UA",
    kernelClient: { post: async () => ({ data: { status: 200, contentType: "text/html", body: "x", bodyEncoding: "text" } }) },
  }), /Unexpected forward proxy encoding/);
});

test("does not start a direct request when the caller signal is already aborted", async () => {
  const controller = new AbortController();
  controller.abort(new Error("scope ended"));
  let called = false;
  await assert.rejects(fetchTitleResource({
    url: "https://example.com",
    frontend: "desktop",
    userAgent: "UA",
    kernelClient: { post: () => assert.fail("proxy must not be used") },
    signal: controller.signal,
    fetchImpl: async () => {
      called = true;
      return new Response("unused");
    },
  }), /scope ended/);
  assert.equal(called, false);
});
