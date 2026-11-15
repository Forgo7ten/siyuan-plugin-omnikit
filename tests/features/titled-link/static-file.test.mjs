import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { stripTypeScriptTypes } from "node:module";

const source = await readFile(new URL("../../../src/features/titled-link/services/static-file.ts", import.meta.url), "utf8");
const module = await import(`data:text/javascript,${encodeURIComponent(stripTypeScriptTypes(source))}`);
const { extractStaticFileName, isStaticFileUrl } = module;

test("extracts and decodes supported static file names without query or hash", () => {
  assert.equal(extractStaticFileName("https://example.com/files/%E6%89%8B%E5%86%8C-v1.0.pdf?download=1#page"), "手册-v1.0.pdf");
  assert.equal(extractStaticFileName("https://example.com/APP.DMG"), "APP.DMG");
  assert.equal(extractStaticFileName("https://example.com/music/track.flac"), "track.flac");
});

test("recognizes the configured archive, document, media and image families", () => {
  for (const extension of ["zip", "apk", "docx", "epub", "mp4", "m4a", "jpeg", "svg"]) {
    assert.equal(isStaticFileUrl(`https://example.com/a.${extension}`), true, extension);
  }
});

test("rejects web pages, unsupported protocols and malformed URL encoding", () => {
  assert.equal(extractStaticFileName("https://example.com/page.html"), null);
  assert.equal(extractStaticFileName("ftp://example.com/a.pdf"), null);
  assert.equal(extractStaticFileName("siyuan://blocks/123.pdf"), null);
  assert.equal(extractStaticFileName("https://example.com/%E0%A4%A.pdf"), null);
  assert.equal(extractStaticFileName("not a URL"), null);
});
