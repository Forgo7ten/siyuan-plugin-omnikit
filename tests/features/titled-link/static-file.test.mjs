import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { stripTypeScriptTypes } from "node:module";

const source = await readFile(new URL("../../../src/features/titled-link/services/static-file.ts", import.meta.url), "utf8");
const module = await import(`data:text/javascript,${encodeURIComponent(stripTypeScriptTypes(source))}`);
const { extractStaticFileName } = module;

test("does not export legacy unused isStaticFileUrl helper", () => {
  assert.equal("isStaticFileUrl" in module, false);
});

test("extracts and decodes supported static file names without query or hash", () => {
  assert.equal(extractStaticFileName("https://example.com/files/%E6%89%8B%E5%86%8C-v1.0.pdf?download=1#page"), "手册-v1.0.pdf");
  assert.equal(extractStaticFileName("https://example.com/files/manual%2Epdf?download=1"), "manual.pdf");
  assert.equal(extractStaticFileName("https://example.com/files/report%20final%2Edocx#top"), "report final.docx");
  assert.equal(extractStaticFileName("https://example.com/APP.DMG"), "APP.DMG");
  assert.equal(extractStaticFileName("https://example.com/music/track.flac"), "track.flac");
});

test("recognizes the configured archive, document, media and image families", () => {
  for (const extension of ["zip", "apk", "docx", "epub", "mp4", "m4a", "jpeg", "svg"]) {
    assert.equal(extractStaticFileName(`https://example.com/a.${extension}`), `a.${extension}`, extension);
  }
});

test("rejects web pages and unsupported protocols while falling back on malformed URL encoding", () => {
  assert.equal(extractStaticFileName("https://example.com/page.html"), null);
  assert.equal(extractStaticFileName("https://example.com/page%2Ehtml"), null);
  assert.equal(extractStaticFileName("ftp://example.com/a.pdf"), null);
  assert.equal(extractStaticFileName("siyuan://blocks/123.pdf"), null);
  assert.equal(extractStaticFileName("https://example.com/%E0%A4%A.pdf"), "%E0%A4%A.pdf");
  assert.equal(extractStaticFileName("https://example.com/%E0%A4%A.html"), null);
  assert.equal(extractStaticFileName("https://example.com/%20.pdf"), ".pdf");
  assert.equal(extractStaticFileName("not a URL"), null);
});
