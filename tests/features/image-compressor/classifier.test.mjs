import { test } from "node:test";
import assert from "node:assert/strict";
import { classifyImageCandidate, extractImageExtension } from "../../../src/features/image-compressor/policy/ImageCandidateClassifier.ts";
import {
  CanvasWebpEncoder,
  isSmartCompressionEffective,
  probeSmartCompressionSupport,
  setSmartSupportResolverForTest,
} from "../../../src/features/image-compressor/services/image.ts";
import { hasCompressibleInput } from "../../../src/features/image-compressor/actions/AutoUploadHandler.ts";
import { addedRemoteCandidates } from "../../../src/features/image-compressor/actions/RemoteImageWatcher.ts";
import { resolveSource } from "../../../src/features/image-compressor/policy/source.ts";
import { AdaptiveImageCompressor } from "../../../src/features/image-compressor/similarity/AdaptiveImageCompressor.ts";
import { defaultImageFeatureConfig } from "../../../src/features/image-compressor/policy/parseImageConfig.ts";

const excluded = ["gif", "svg", "webp"];

test("classifyImageCandidate permits normal png and jpeg images", () => {
  const png = classifyImageCandidate({
    path: "assets/photo.png",
    mode: "auto",
    excludedExtensions: excluded,
  });
  assert.equal(png.eligible, true);
  assert.equal(png.extension, "png");

  const jpg = classifyImageCandidate({
    path: "assets/nested/sub/scenery.jpeg",
    mode: "document",
    excludedExtensions: excluded,
  });
  assert.equal(jpg.eligible, true);
  assert.equal(jpg.extension, "jpeg");
});

test("classifyImageCandidate excludes all specified video extensions", () => {
  const videos = [
    "mp4", "m4v", "mov", "avi", "wmv", "flv", "mkv", "webm", "3gp", "ogv",
    "mpeg", "mpg", "mts", "m2ts", "ts", "vob", "asf", "rm", "rmvb", "f4v",
  ];
  for (const ext of videos) {
    const res = classifyImageCandidate({
      path: `assets/clip.${ext}`,
      mode: "auto",
      excludedExtensions: excluded,
    });
    assert.equal(res.eligible, false);
    assert.equal(res.reason, "video");
    assert.equal(res.extension, ext);
  }
});

test("classifyImageCandidate protects Excalidraw and drawing/drawings directories without blocking drawings_v2.png (I-11)", () => {
  const protectedSamples = [
    "assets/excalidraw-2024.png",
    "assets/my-excalidraw.jpg",
    "drawings/diagram.png",
    "assets/drawings/flow.png",
    "assets/drawing/sketch.png",
  ];
  for (const path of protectedSamples) {
    const res = classifyImageCandidate({
      path,
      mode: "manual-quick",
      excludedExtensions: excluded,
    });
    assert.equal(res.eligible, false, path);
    assert.equal(res.reason, "excalidraw");
  }

  for (const allowedPath of ["assets/drawings_v2.png", "assets/drawing-foo.png"]) {
    const res = classifyImageCandidate({
      path: allowedPath,
      mode: "auto",
      excludedExtensions: excluded,
    });
    assert.equal(res.eligible, true, allowedPath);
    assert.equal(res.extension, "png");
  }
});

test("classifyImageCandidate excludes animated (gif, apng) and vector (svg) formats", () => {
  const gif = classifyImageCandidate({ path: "assets/anim.gif", mode: "auto", excludedExtensions: [] });
  assert.equal(gif.eligible, false);
  assert.equal(gif.reason, "animated-format");

  const apng = classifyImageCandidate({ path: "assets/anim.apng", mode: "auto", excludedExtensions: [] });
  assert.equal(apng.eligible, false);
  assert.equal(apng.reason, "animated-format");

  const svg = classifyImageCandidate({ path: "assets/icon.svg", mode: "auto", excludedExtensions: [] });
  assert.equal(svg.eligible, false);
  assert.equal(svg.reason, "vector-format");
});

test("classifyImageCandidate skips non-empty unsupported static extensions while allowing extensionless CDN URLs (P2-2)", () => {
  for (const ext of ["bmp", "ico", "tiff", "heif", "avif"]) {
    const res = classifyImageCandidate({
      path: `assets/pic.${ext}`,
      mode: "auto",
      excludedExtensions: excluded,
    });
    assert.equal(res.eligible, false, ext);
    assert.equal(res.reason, "unsupported-format");
  }

  const cdn = classifyImageCandidate({
    path: "https://avatars.githubusercontent.com/u/12345?v=4",
    mode: "auto",
    excludedExtensions: excluded,
  });
  assert.equal(cdn.eligible, true);
  assert.equal(cdn.extension, "");
});

test("classifyImageCandidate treats static WebP as skipped in auto/document when smartEnabled is false, and eligible when smartEnabled is true or in manual modes", () => {
  const auto = classifyImageCandidate({
    path: "assets/image.webp",
    mode: "auto",
    excludedExtensions: excluded,
    smartEnabled: false,
  });
  assert.equal(auto.eligible, false);
  assert.equal(auto.reason, "excluded-extension");

  const autoSmart = classifyImageCandidate({
    path: "assets/image.webp",
    mode: "auto",
    excludedExtensions: excluded,
    smartEnabled: true,
  });
  assert.equal(autoSmart.eligible, true);
  assert.equal(autoSmart.extension, "webp");

  const batch = classifyImageCandidate({
    path: "assets/image.webp",
    mode: "document",
    excludedExtensions: excluded,
    smartEnabled: false,
  });
  assert.equal(batch.eligible, false);
  assert.equal(batch.reason, "excluded-extension");

  const batchSmart = classifyImageCandidate({
    path: "assets/image.webp",
    mode: "document",
    excludedExtensions: excluded,
    smartEnabled: true,
  });
  assert.equal(batchSmart.eligible, true);
  assert.equal(batchSmart.extension, "webp");

  const quick = classifyImageCandidate({
    path: "assets/image.webp",
    mode: "manual-quick",
    excludedExtensions: excluded,
  });
  assert.equal(quick.eligible, true);
  assert.equal(quick.extension, "webp");

  const dialog = classifyImageCandidate({
    path: "assets/image.webp",
    mode: "manual-dialog",
    excludedExtensions: excluded,
  });
  assert.equal(dialog.eligible, true);
  assert.equal(dialog.extension, "webp");
});

test("classifyImageCandidate normalizes URL query, fragment, and backslashes", () => {
  const urlRes = classifyImageCandidate({
    path: "https://example.com/images/cat.png?token=secret&size=large#section",
    mode: "auto",
    excludedExtensions: excluded,
  });
  assert.equal(urlRes.eligible, true);
  assert.equal(urlRes.extension, "png");

  const winRes = classifyImageCandidate({
    path: "assets\\subfolder\\dog.jpg?v=1",
    mode: "auto",
    excludedExtensions: excluded,
  });
  assert.equal(winRes.eligible, true);
  assert.equal(winRes.extension, "jpg");
});

test("I-09: extractImageExtension handles extensionless paths with dots in parent dir and trailing dots", () => {
  assert.equal(extractImageExtension("dir.v1/avatar"), "");
  assert.equal(extractImageExtension("assets/photo."), "");
  assert.equal(extractImageExtension("https://cdn.example/v1.0/avatar?format=webp#img"), "");
  assert.equal(extractImageExtension("assets\\sub.dir\\Photo.WEBP?width=100"), "webp");
});

test("I-09: CanvasWebpEncoder and AdaptiveImageCompressor skip extensionless WebP when disallowed by mode/smartEnabled", async () => {
  const staticWebpBytes = new Uint8Array(48);
  const view = new DataView(staticWebpBytes.buffer);
  staticWebpBytes.set(Buffer.from("RIFF"), 0); view.setUint32(4, 40, true); staticWebpBytes.set(Buffer.from("WEBP"), 8);
  staticWebpBytes.set(Buffer.from("VP8X"), 12); view.setUint32(16, 10, true);
  staticWebpBytes[24] = 99; staticWebpBytes[27] = 99;
  staticWebpBytes.set(Buffer.from("VP8 "), 30); view.setUint32(34, 10, true);
  staticWebpBytes.set([0x9d, 0x01, 0x2a], 41);
  view.setUint16(44, 100, true); view.setUint16(46, 100, true);
  const extensionlessWebp = new Blob([staticWebpBytes], { type: "image/webp" });

  const cfg = defaultImageFeatureConfig();
  cfg.compression.minInputBytes = 0;
  cfg.compression.minSavingBytes = 0;
  cfg.compression.minSavingRatio = 0;
  cfg.compression.smartEnabled = false;

  const baseCodec = new CanvasWebpEncoder(
    async () => { throw new Error("Must not invoke encoder for disallowed extensionless WebP"); },
    async () => ({ width: 100, height: 100 }),
  );
  const adaptive = new AdaptiveImageCompressor(baseCodec);

  for (const mode of ["auto", "document"]) {
    const resCodec = await baseCodec.encode(extensionlessWebp, "dir.v1/avatar", cfg, undefined, undefined, mode);
    assert.deepEqual(resCodec, { kind: "skipped", reason: "protected-extension" });
    const resAdaptive = await adaptive.encode(extensionlessWebp, "dir.v1/avatar", cfg, undefined, undefined, mode);
    assert.deepEqual(resAdaptive, { kind: "skipped", reason: "protected-extension" });
  }
});

test("unsupported host disables effective smart WebP pre-screening even when synced config has smartEnabled=true", async () => {
  const syncedCfg = defaultImageFeatureConfig();
  syncedCfg.auto.globalEnabled = true;
  syncedCfg.compression.smartEnabled = true;

  setSmartSupportResolverForTest(() => ({ supported: false, reason: "webp-encode-unsupported" }));
  try {
    await probeSmartCompressionSupport();
    assert.equal(isSmartCompressionEffective(true), false);

    assert.equal(
      hasCompressibleInput({ kind: "files", files: [new File(["w"], "pic.webp", { type: "image/webp" })] }, syncedCfg),
      false,
    );

    const remoteWebp = resolveSource("https://example.com/pic.webp", "https://siyuan.test");
    const current = new Map([["blk\n" + remoteWebp.key, { blockID: "20240101000000-abcdefg", source: remoteWebp, count: 1 }]]);
    assert.deepEqual(addedRemoteCandidates(new Map(), current, syncedCfg, "20240101000000-root123"), []);
  } finally {
    setSmartSupportResolverForTest(undefined);
  }
  assert.equal(isSmartCompressionEffective(true), true);
});
