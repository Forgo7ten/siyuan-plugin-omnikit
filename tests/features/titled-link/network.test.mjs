import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { stripTypeScriptTypes } from "node:module";

const source = await readFile(new URL("../../../src/features/titled-link/services/dual-track-fetcher.ts", import.meta.url), "utf8");
const { fetchTitleResource, decodeBase64 } = await import(`data:text/javascript,${encodeURIComponent(stripTypeScriptTypes(source))}`);

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
  assert.deepEqual(call.body.headers, [
    { "User-Agent": "OmniKit UA" },
    { Referer: "" },
    { Range: "bytes=0-65535" },
    { "Accept-Encoding": "identity" },
  ]);
  assert.equal(resource.transport, "proxy");
  assert.deepEqual(resource.body, original);
});

test("falls back to an unbounded request when the range is unsatisfiable", async () => {
  const calls = [];
  const resource = await fetchTitleResource({
    url: "https://example.com/short",
    frontend: "mobile",
    userAgent: "OmniKit UA",
    kernelClient: {
      async post(path, body) {
        calls.push({ path, body });
        return { data: calls.length === 1
          ? { url: body.url, status: 416, contentType: "", body: "", bodyEncoding: "base64", headers: {}, elapsed: 1 }
          : { url: body.url, status: 200, contentType: "text/html; charset=utf-8",
              body: Buffer.from("<html><head><title>OK</title></head>").toString("base64"),
              bodyEncoding: "base64", headers: {}, elapsed: 1 } };
      },
    },
  });
  assert.equal(calls.length, 2);
  assert.ok(calls[0].body.headers.some(h => h.Range === "bytes=0-65535"));
  assert.ok(calls[1].body.headers.every(h => !("Range" in h)));
  assert.equal(resource.transport, "proxy");
  assert.equal(resource.status, 200);
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

test("decodeBase64 skips ASCII whitespace, bounds scanning to maxChars, and rejects malformed input", () => {
  // Valid base64 with ASCII whitespace (\t\n\f\r space)
  const expected = new TextEncoder().encode("Hello World!");
  const raw = Buffer.from(expected).toString("base64");
  const withWhitespace = ` \t\n${raw.slice(0, 4)}\f\r ${raw.slice(4)} \n`;
  assert.deepEqual(decodeBase64(withWhitespace), expected);

  // Bounded scanning stops at maxChars = Math.ceil((maxBytes + 1) / 3) * 4 without inspecting trailing payload
  // maxBytes = 6 -> maxChars = 12 chars (decodes 9 bytes), ignoring invalid trailing chars beyond 12 chars
  const twelveValidChars = Buffer.from("123456789").toString("base64"); // 12 chars
  assert.equal(twelveValidChars.length, 12);
  const boundedBytes = decodeBase64(`${twelveValidChars}!!!!INVALID_TAIL`, 6);
  assert.equal(new TextDecoder().decode(boundedBytes), "123456789");

  // Default 65_536 limit -> maxChars = 87_384 -> 65_538 bytes (allows >64KiB truncation detection without decoding megabytes)
  const hugeValid = `${"AAAA".repeat(25_000)}!!!!`; // 100_000 valid chars + invalid tail well past 87_384
  assert.equal(decodeBase64(hugeValid).byteLength, 65_538);

  // Rejects invalid characters, misplaced padding, excessive padding, and unaligned length
  assert.throws(() => decodeBase64("SGVs!G8="), /Invalid base64 character/);
  assert.throws(() => decodeBase64("SGVsbG=A"), /Invalid base64 data after padding/);
  assert.throws(() => decodeBase64("SGVsbA==="), /Invalid base64 padding/);
  assert.throws(() => decodeBase64("A=AA"), /Invalid base64 padding/);
  assert.throws(() => decodeBase64("===="), /Invalid base64 padding/);
  assert.throws(() => decodeBase64("SGVsb"), /Invalid base64 length/);
});
