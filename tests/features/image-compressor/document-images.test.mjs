import test from "node:test";
import assert from "node:assert/strict";
import { scanDocumentImages } from "../../../src/features/image-compressor/actions/scanDocumentImages.ts";
import { defaultImageFeatureConfig } from "../../../src/features/image-compressor/policy/parseImageConfig.ts";

const id = n => `${String(n).padStart(14, "0")}-abcdef0`;
function fakeImage(blockID, source) {
  return {
    closest: selector => selector === "[data-node-id]" && blockID ? { getAttribute: () => blockID } : null,
    hasAttribute: name => name === "src",
    getAttribute: name => name === "src" ? source : null,
  };
}
function withParser(images, blocks, run) {
  const prior = globalThis.DOMParser;
  globalThis.DOMParser = class {
    parseFromString() {
      return { querySelector: () => null,
        querySelectorAll: selector => selector === "img" ? images : blocks.map(value => ({ id: value })) };
    }
  };
  try { run(); } finally { globalThis.DOMParser = prior; }
}

test("complete document scan includes nested images and preserves each owning block", () => {
  const blocks = [id(1), id(2), id(3), id(4)];
  const images = [fakeImage(id(2), "assets/a.png"), fakeImage(id(3), "assets/a.png"), fakeImage(id(4), "assets/b.jpg")];
  withParser(images, blocks, () => {
    const result = scanDocumentImages("<complete-kernel-dom/>", "http://localhost:6806", defaultImageFeatureConfig());
    assert.equal(result.scannedBlocks, 4);
    assert.deepEqual(result.occurrences.map(item => [item.blockId, item.source.path]),
      [[id(2), "assets/a.png"], [id(3), "assets/a.png"], [id(4), "assets/b.jpg"]]);
    assert.deepEqual(result.occurrences.map(item => item.imageOrdinal), [0, 0, 0]);
  });
});

test("document scan skips WebP and keeps physical per-block image ordinals", () => {
  const block = id(5);
  const images = [fakeImage(block, "assets/a.webp"), fakeImage(block, "assets/b.png"), fakeImage(block, "assets/c.jpg")];
  withParser(images, [block], () => {
    const result = scanDocumentImages("<complete-kernel-dom/>", "http://localhost:6806", defaultImageFeatureConfig());
    assert.deepEqual(result.occurrences.map(item => [item.source.path, item.imageOrdinal]), [
      ["assets/b.png", 1], ["assets/c.jpg", 2],
    ]);
  });
});

test("document scan rejects a local image without an owning block", () => {
  withParser([fakeImage(null, "assets/orphan.png")], [id(1)], () => {
    assert.throws(() => scanDocumentImages("<incomplete/>", "http://localhost:6806", defaultImageFeatureConfig()), /owning block/);
  });
});
