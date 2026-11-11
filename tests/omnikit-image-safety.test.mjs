import { test } from "node:test";
import assert from "node:assert/strict";
import { imageReferenceParser } from "../src/features/image-compressor/ImageReferenceParser.ts";
import { BlockActionCoordinator } from "../src/features/image-compressor/BlockActionCoordinator.ts";
import { originalAssetURL } from "../src/features/image-compressor/OriginalAssetURL.ts";
import { rewriteImageBlockOnce } from "../src/features/image-compressor/BlockImageRewriter.ts";

test("HTML rewrite changes only the matching original data-src attribute", () => {
  const source = '<img src="assets/thumb.webp" data-src="assets/full.png">';
  const result = imageReferenceParser.replaceMany(source, "b", new Map([["assets/full.png", { nextURL: "assets/new.webp", expectedCount: 1 }]]));
  assert.equal(result.ok, true);
  assert.equal(result.markdown, '<img src="assets/thumb.webp" data-src="assets/new.webp">');
  const duplicate = '<img data-src="assets/full.png" data-src="assets/other.png">';
  const exact = imageReferenceParser.replaceMany(duplicate, "b", new Map([["assets/full.png", { nextURL: "assets/new.webp", expectedCount: 1 }]]));
  assert.equal(exact.markdown, '<img data-src="assets/new.webp" data-src="assets/other.png">');
});

test("masking code after an emoji preserves UTF-16 parser offsets", () => {
  const text = '😀\n```\n![hidden](assets/no.png)\n```\n![shown](assets/yes.png)';
  const refs = imageReferenceParser.scan(text, "b");
  assert.deepEqual(refs.map(ref => ref.url), ["assets/yes.png"]);
  assert.equal(text.slice(refs[0].urlStart, refs[0].urlEnd), "assets/yes.png");
});

test("original asset URL ignores currentSrc and rejects traversal and remote URLs", () => {
  const image = value => ({ getAttribute: name => name === "data-src" ? value.data : value.src });
  assert.equal(originalAssetURL(image({ data: "assets/original.png", src: "assets/thumb.png" })), "assets/original.png");
  assert.equal(originalAssetURL(image({ data: "assets/%2e%2e/secret.png", src: null })), undefined);
  assert.equal(originalAssetURL(image({ data: "https://example.test/a.png", src: null })), undefined);
});

test("coordinator serializes same-block writes and rewrite detects edits between reads", async () => {
  const coordinator = new BlockActionCoordinator();
  const events = [];
  await Promise.all([1, 2].map(n => coordinator.run("block", async () => {
    events.push(`start${n}`); await new Promise(resolve => setTimeout(resolve, 2)); events.push(`end${n}`);
  })));
  assert.deepEqual(events, ["start1", "end1", "start2", "end2"]);

  let reads = 0;
  let writes = 0;
  const repository = {
    async getBlockDOM() { reads++; return reads === 1 ? '![x](assets/a.png)' : 'edited ![x](assets/a.png)'; },
    async updateBlockDOM() { writes++; },
  };
  const status = await rewriteImageBlockOnce(repository, "block", new Map([["assets/a.png", { nextURL: "assets/b.png", expectedCount: 1 }]]));
  assert.equal(status, "conflict");
  assert.equal(writes, 0);
});
