import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { stripTypeScriptTypes } from "node:module";

const source = await readFile(new URL("../../../src/features/titled-link/services/stream-parser.ts", import.meta.url), "utf8");
const runnable = stripTypeScriptTypes(source).replace(/^import[^;]+;\s*/m, "");
const { decodeHtmlBytes, readAndDecodeStream, readAndDecodeTitleResource, sniffCharset } = await import(`data:text/javascript,${encodeURIComponent(runnable)}`);

test("decodes UTF-8, GBK/GB2312 and Big5 from headers or meta tags", () => {
  const utf8 = new TextEncoder().encode('<meta charset="utf-8"><title>标题</title>');
  assert.match(decodeHtmlBytes(utf8).html, /标题/);

  const gbk = Uint8Array.from([...new TextEncoder().encode('<meta charset="gb2312"><title>'), 0xd6, 0xd0, 0xce, 0xc4, ...new TextEncoder().encode("</title>")]);
  assert.equal(sniffCharset(gbk), "gbk");
  assert.match(decodeHtmlBytes(gbk).html, /中文/);

  const big5 = Uint8Array.from([...new TextEncoder().encode("<title>"), 0xa4, 0xa4, 0xa4, 0xe5, ...new TextEncoder().encode("</title>")]);
  assert.match(decodeHtmlBytes(big5, "text/html; charset=big5").html, /中文/);
});

test("cancels a direct response stream immediately after a closing title tag", async () => {
  let cancelled = false;
  const first = new TextEncoder().encode("<html><head><title>Captured</title>");
  const stream = new ReadableStream({
    start(controller) {
      controller.enqueue(first);
      controller.enqueue(new Uint8Array(80_000));
    },
    cancel() { cancelled = true; },
  });
  const result = await readAndDecodeStream(stream, "text/html; charset=utf-8");
  assert.equal(cancelled, true);
  assert.equal(result.bytesRead, first.byteLength);
  assert.equal(result.truncated, true);
  assert.match(result.html, /Captured/);
});

test("caps already-buffered proxy responses at 64 KiB", async () => {
  const body = new Uint8Array(80_000);
  body.set(new TextEncoder().encode("<title>Proxy</title>"));
  const result = await readAndDecodeTitleResource({
    transport: "proxy", status: 200, ok: true, contentType: "text/html", body,
  });
  assert.equal(result.bytesRead, 64 * 1024);
  assert.equal(result.truncated, true);
});

test("aborting a stream read cancels the underlying reader", async () => {
  const controller = new AbortController();
  let cancelled = false;
  const stream = new ReadableStream({
    async pull() {
      await new Promise(() => {});
    },
    cancel() { cancelled = true; },
  });
  const pending = readAndDecodeStream(stream, "text/html", { signal: controller.signal });
  controller.abort(new Error("scope ended"));
  await assert.rejects(pending, /scope ended/);
  assert.equal(cancelled, true);
});
