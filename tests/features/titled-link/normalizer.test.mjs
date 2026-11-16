import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { stripTypeScriptTypes } from "node:module";

const source = await readFile(new URL("../../../src/features/titled-link/services/title-normalizer.ts", import.meta.url), "utf8");
const { extractNormalizedTitle, truncateGraphemes } = await import(`data:text/javascript,${encodeURIComponent(stripTypeScriptTypes(source))}`);
const defaults = { maxTitleLength: 80, fallbackToHostname: true, unescapeHtml: value => value.replaceAll("&amp;", "&") };

test("uses title before OpenGraph and Twitter metadata and normalizes entities and whitespace", () => {
  const html = '<meta property="og:title" content="OG"><meta name="twitter:title" content="Twitter"><title> Main &amp;\r\n  Title </title>';
  assert.deepEqual(extractNormalizedTitle(html, "https://example.com", defaults), { title: "Main & Title", source: "title" });
});

test("ignores SVG title in body and extracts title from head", () => {
  const html = '<html><head><title>Actual Page Title</title></head><body><svg><title>Close Button</title></svg></body></html>';
  assert.deepEqual(extractNormalizedTitle(html, "https://example.com", defaults), { title: "Actual Page Title", source: "title" });
});

test("supports metadata attribute order variations and fallback priority", () => {
  const html = '<meta content="Open Graph" property="og:title"><meta content="Tweet" name="twitter:title">';
  assert.deepEqual(extractNormalizedTitle(html, "https://example.com", defaults), { title: "Open Graph", source: "og:title" });
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
