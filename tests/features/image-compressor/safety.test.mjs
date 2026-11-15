import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const feature = new URL("../../../src/features/image-compressor", import.meta.url);

test("image feature has no active deletion or workspace-wide relink API", () => {
  const files = readdirSync(feature).filter(name => /\.(ts|svelte)$/.test(name));
  const source = files.map(name => readFileSync(join(feature.pathname, name), "utf8")).join("\n");
  for (const forbidden of ["/api/asset/removeUnusedAsset", "/api/asset/relinkAsset", "/api/file/removeFile", "fs.unlink(", "fs.rm("]) {
    assert.equal(source.includes(forbidden), false, `forbidden image feature operation: ${forbidden}`);
  }
});
