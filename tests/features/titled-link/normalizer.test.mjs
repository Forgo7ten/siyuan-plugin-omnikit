import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { stripTypeScriptTypes } from "node:module";

const source = await readFile(new URL("../../../src/features/titled-link/services/title-normalizer.ts", import.meta.url), "utf8");
const { extractNormalizedTitle, finalizeTitle, truncateGraphemes } = await import(`data:text/javascript,${encodeURIComponent(stripTypeScriptTypes(source))}`);
const defaults = { maxTitleLength: 80, fallbackToHostname: true, unescapeHtml: value => value.replaceAll("&amp;", "&") };

test("uses title before OpenGraph and Twitter metadata and normalizes entities and whitespace", () => {
  const html = '<meta property="og:title" content="OG"><meta name="twitter:title" content="Twitter"><title> Main &amp;\r\n  Title </title>';
  assert.deepEqual(extractNormalizedTitle(html, "https://example.com", defaults), { title: "Main & Title", source: "title" });
});

test("ignores SVG title in body and extracts title from head or unclosed streamed head", () => {
  const html = '<html><head><title>Actual Page Title</title></head><body><svg><title>Close Button</title></svg></body></html>';
  assert.deepEqual(extractNormalizedTitle(html, "https://example.com", defaults), { title: "Actual Page Title", source: "title" });

  // Stream parser stops at </head> and relies on the 64 KiB cap when </head> is omitted.
  const streamedHead = '<html><head><title>Streamed Title</title>';
  assert.deepEqual(extractNormalizedTitle(streamedHead, "https://example.com", defaults), { title: "Streamed Title", source: "title" });

  // Headless HTML or body-only SVG icon <title> must not leak into page title
  const bodySvgOnly = '<html><body><svg><title>Close Icon</title></svg><p>hello</p></body></html>';
  assert.deepEqual(extractNormalizedTitle(bodySvgOnly, "https://example.com", defaults), { title: "example.com", source: "hostname" });

  const headlessWithSvg = '<svg><title>Icon</title></svg><title>Real Headless Title</title>';
  assert.deepEqual(extractNormalizedTitle(headlessWithSvg, "https://example.com", defaults), { title: "Real Headless Title", source: "title" });
});

test("supports metadata attribute order variations, quoted '>' characters, and fallback priority", () => {
  const html = '<meta content="Open Graph" property="og:title"><meta content="Tweet" name="twitter:title">';
  assert.deepEqual(extractNormalizedTitle(html, "https://example.com", defaults), { title: "Open Graph", source: "og:title" });

  const quotedGt = '<head><meta content="Docs > Guide" property="og:title"></head>';
  assert.deepEqual(extractNormalizedTitle(quotedGt, "https://example.com", defaults), { title: "Docs > Guide", source: "og:title" });

  const singleQuotedNameGt = "<head><meta name='a>b' content='Ignored'><meta name='twitter:title' content='Alpha > Beta'></head>";
  assert.deepEqual(extractNormalizedTitle(singleQuotedNameGt, "https://example.com", defaults), { title: "Alpha > Beta", source: "twitter:title" });
});

test("challenge pages reject all metadata and fall back only when configured", () => {
  const html = '<title> Just a moment… </title><meta property="og:title" content="Misleading">';
  assert.deepEqual(extractNormalizedTitle(html, "https://github.com/path", defaults), { title: "github.com", source: "hostname" });
  assert.equal(extractNormalizedTitle(html, "https://github.com/path", { ...defaults, fallbackToHostname: false }), null);
});

test("truncates by grapheme cluster and reserves three positions for ellipsis", () => {
  assert.equal(truncateGraphemes("A👨‍👩‍👧‍👦BCDE", 5), "A👨‍👩‍👧‍👦...");
  assert.equal(extractNormalizedTitle("", "https://b3log.org/a", defaults).title, "b3log.org");
});

test("matches metadata by attribute name instead of substring and restricts meta to head scope", () => {
  const fake = '<html><head><meta data-property="og:title" content="Fake"></head></html>';
  assert.equal(extractNormalizedTitle(fake, "https://x.com", defaults)?.source, "hostname");
  const inValue = '<html><head><meta content="foo property=\'og:title\'"></head></html>';
  assert.equal(extractNormalizedTitle(inValue, "https://x.com", defaults)?.source, "hostname");
  const inBody = '<html><head><title></title></head><body><meta property="og:title" content="Body"></body></html>';
  assert.equal(extractNormalizedTitle(inBody, "https://x.com", defaults)?.source, "hostname");
  const real = '<html><head><title></title><meta property="og:title" content="Real"></head></html>';
  assert.deepEqual(extractNormalizedTitle(real, "https://x.com", defaults), { title: "Real", source: "og:title" });
});

test("rejects challenge text that only appears in og:title", () => {
  const html = '<html><head><title></title><meta property="og:title" content="Just a moment..."></head></html>';
  assert.deepEqual(extractNormalizedTitle(html, "https://x.com", defaults), { title: "x.com", source: "hostname" });
  assert.equal(extractNormalizedTitle(html, "https://x.com", { ...defaults, fallbackToHostname: false }), null);
});

test("hard-truncates instead of returning only dots at tiny limits", () => {
  assert.equal(truncateGraphemes("ABCDE", 1), "A");
  assert.equal(truncateGraphemes("ABCDE", 2), "AB");
  assert.equal(truncateGraphemes("ABCDE", 3), "ABC");
});

test("falls back to code point segmentation without Intl.Segmenter", () => {
  const prev = Intl.Segmenter;
  try {
    Intl.Segmenter = undefined;
    assert.equal(truncateGraphemes("ABCDEFG", 5), "AB...");
  } finally {
    Intl.Segmenter = prev;
  }
});

test("decodes numeric HTML entities in fallback unescape before named entities", () => {
  const prevLute = globalThis.Lute;
  try {
    globalThis.Lute = undefined;
    const html = '<html><head><title>&#x4E2D;&#25991; &amp;#39; &#999999999;</title></head></html>';
    const result = extractNormalizedTitle(html, "https://x.com", { maxTitleLength: 80, fallbackToHostname: true });
    assert.deepEqual(result, { title: "中文 &#39;", source: "title" });
  } finally {
    globalThis.Lute = prevLute;
  }
});

test("strips bidi overrides and control characters while preserving ZWNJ, ZWJ, and newline word boundaries", () => {
  const rlo = extractNormalizedTitle('<html><head><title>Invoice\u202Egnp.exe\u202C</title></head></html>', "https://x.com", defaults);
  assert.equal(rlo?.title, "Invoicegnp.exe");

  const controls = extractNormalizedTitle('<html><head><title>A\u0000B\u200BC</title></head></html>', "https://x.com", defaults);
  assert.equal(controls?.title, "ABC");

  const multiline = extractNormalizedTitle('<html><head><title>Hello\nWorld</title></head></html>', "https://x.com", defaults);
  assert.equal(multiline?.title, "Hello World");
  assert.equal(finalizeTitle("Hello\r\n\tWorld\u202E", 80), "Hello World");

  const emoji = extractNormalizedTitle('<html><head><title>👨‍👩‍👧‍👦</title></head></html>', "https://x.com", defaults);
  assert.equal(emoji?.title, "👨‍👩‍👧‍👦");

  const zwnj = extractNormalizedTitle('<html><head><title>می\u200Cخواهم</title></head></html>', "https://x.com", defaults);
  assert.equal(zwnj?.title, "می\u200Cخواهم");

  const truncatedHost = extractNormalizedTitle("", "https://averyverylongdomain.example.com/a", { maxTitleLength: 10, fallbackToHostname: true });
  assert.deepEqual(truncatedHost, { title: "averyve...", source: "hostname" });
});
