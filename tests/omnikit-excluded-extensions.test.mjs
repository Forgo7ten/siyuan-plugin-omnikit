import { test } from "node:test";
import assert from "node:assert/strict";
import { hasExcludedExtension, parseExcludedExtensions, readExcludedExtensions } from "../src/features/image-compressor/ExcludedExtensions.ts";
import { isEligibleImage } from "../src/features/image-compressor/ImageEligibility.ts";

test("extension parser ignores empty entries, trims, normalizes and deduplicates", () => {
  assert.deepEqual(parseExcludedExtensions(" .GIF, ,svg,WEBP,gif,,"), { ok: true, value: "gif,svg,webp" });
  assert.deepEqual(parseExcludedExtensions("gif,,,"), { ok: true, value: "gif" });
});

test("extension parser rejects paths and wildcard tokens", () => {
  for (const value of ["images/gif", "*.gif", "gif;png", "../svg"]) {
    assert.equal(parseExcludedExtensions(value).ok, false, value);
  }
});

test("legacy schema v1 booleans are read without restoring excluded WebP when disabled", () => {
  assert.equal(readExcludedExtensions({ skipWebP: false, skipGIF: true, skipSVG: true, skipExcalidraw: true }), "gif,svg");
  assert.equal(readExcludedExtensions({ skipWebP: true, skipGIF: false, skipSVG: false, skipExcalidraw: false }), "webp");
});

test("removing WebP from blacklist restores eligibility but drawing PNG stays protected", () => {
  const settings = { excludedExtensions: "gif,svg", minSizeBytes: 0 };
  assert.equal(isEligibleImage("assets/photo.WEBP", "image/webp", { excludedExtensions: "gif,svg,webp" }), false);
  assert.equal(isEligibleImage("assets/photo.webp", "image/webp", settings), true);
  assert.equal(hasExcludedExtension("assets/diagram.svg.png", "svg"), false);
  assert.equal(isEligibleImage("assets/excalidraw-sketch.png", "image/png", settings), false);
});
