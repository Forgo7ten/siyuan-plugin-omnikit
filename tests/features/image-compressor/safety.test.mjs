import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const feature = new URL("../../../src/features/image-compressor", import.meta.url);

test("image feature has no active deletion or workspace-wide relink API", () => {
  const files = readdirSync(feature, { recursive: true }).filter(name => /\.(ts|svelte)$/.test(String(name)));
  assert.ok(files.length >= 35, `Expected recursive scan of image-compressor sources, got ${files.length}`);
  const source = files.map(name => readFileSync(join(feature.pathname, String(name)), "utf8")).join("\n");
  for (const forbidden of ["/api/asset/removeUnusedAsset", "/api/asset/relinkAsset", "/api/file/removeFile", "fs.unlink(", "fs.rm("]) {
    assert.equal(source.includes(forbidden), false, `forbidden image feature operation: ${forbidden}`);
  }
});
