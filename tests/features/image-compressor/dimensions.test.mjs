import { test } from "node:test";
import assert from "node:assert/strict";
import {
  CanvasWebpEncoder,
  computeTargetDimensions,
  defaultCanvasWebpEncode,
  inspectImage,
  probeSmartCompressionSupport,
  setSmartSupportResolverForTest,
  verifyBitmap,
} from "../../../src/features/image-compressor/services/image.ts";
import { defaultImageFeatureConfig } from "../../../src/features/image-compressor/policy/parseImageConfig.ts";

function png(width, height, extraBytes = 0) {
  const idatLen = 1 + extraBytes;
  const b = new Uint8Array(57 + idatLen);
  b.set([137, 80, 78, 71, 13, 10, 26, 10]);
  const view = new DataView(b.buffer);
  view.setUint32(8, 13); b.set([73, 72, 68, 82], 12);
  view.setUint32(16, width); view.setUint32(20, height);
  view.setUint32(33, idatLen); b.set([73, 68, 65, 84], 37);
  b.set([73, 69, 78, 68], 37 + 4 + idatLen + 4 + 4);
  view.setUint32(37 + 4 + idatLen + 4, 0);
  return new Blob([b], { type: "image/png" });
}

function webp(width, height, extraEvenPadding = 0) {
  const vp8Payload = 10 + (extraEvenPadding & ~1);
  const riffPayload = 4 + 18 + 8 + vp8Payload;
  const b = new Uint8Array(8 + riffPayload);
  const view = new DataView(b.buffer);
  b.set(Buffer.from("RIFF"), 0); view.setUint32(4, riffPayload, true); b.set(Buffer.from("WEBP"), 8);
  b.set(Buffer.from("VP8X"), 12); view.setUint32(16, 10, true);
  let value = width - 1;
  b[24] = value & 255; b[25] = value >> 8 & 255; b[26] = value >> 16 & 255;
  value = height - 1;
  b[27] = value & 255; b[28] = value >> 8 & 255; b[29] = value >> 16 & 255;
  b.set(Buffer.from("VP8 "), 30); view.setUint32(34, vp8Payload, true);
  b.set([0x9d, 0x01, 0x2a], 41);
  view.setUint16(44, width, true); view.setUint16(46, height, true);
  return new Blob([b], { type: "image/webp" });
}

function config() {
  const value = defaultImageFeatureConfig();
  value.compression.minInputBytes = 0;
  value.compression.minSavingBytes = 0;
  value.compression.minSavingRatio = 0;
  return value;
}

test("computeTargetDimensions preserves original resolution in auto/document and scales proportionally in manual modes", () => {
  assert.deepEqual(computeTargetDimensions(5000, 2500, "auto", 4096), { width: 5000, height: 2500 });
  assert.deepEqual(computeTargetDimensions(5000, 2500, "document", 2048), { width: 5000, height: 2500 });
  assert.deepEqual(computeTargetDimensions(5000, 2500, "manual-quick", 4096), { width: 4096, height: 2048 });
  assert.deepEqual(computeTargetDimensions(5000, 2500, "manual-dialog", 4096), { width: 4096, height: 2048 });
  assert.deepEqual(computeTargetDimensions(1200, 800, "manual-dialog", 4096), { width: 1200, height: 800 });
});

test("automatic mode keeps exact source dimensions even above manual edge", async () => {
  let receivedRequest;
  const encoder = new CanvasWebpEncoder(
    async (_blob, req) => {
      receivedRequest = req;
      return webp(5000, 2500);
    },
    async () => ({ width: 64, height: 32 }),
  );
  const result = await encoder.encode(png(5000, 2500), "photo.png", config(), undefined, undefined, "auto");
  assert.equal(result.kind, "encoded");
  assert.equal(receivedRequest.width, 5000);
  assert.equal(receivedRequest.height, 2500);
  assert.equal(receivedRequest.quality, 0.8);
});

test("manual dialog scales proportionally, encodes once without silent 0.95^3 degradation, and rejects wrong output dimensions", async () => {
  let encodeCalls = 0;
  let receivedRequest;
  const encoder = new CanvasWebpEncoder(
    async (_blob, req) => {
      encodeCalls++;
      receivedRequest = req;
      // Return larger WebP than input PNG to ensure no hidden retry loop occurs
      return webp(4096, 2048, 200);
    },
    async () => ({ width: 64, height: 32 }),
  );
  const result = await encoder.encode(png(5000, 2500), "photo.png", config(), undefined, undefined, "manual-dialog");
  assert.equal(result.kind, "encoded");
  assert.equal(encodeCalls, 1);
  assert.equal(receivedRequest.width, 4096);
  assert.equal(receivedRequest.height, 2048);
  assert.equal(receivedRequest.quality, 0.8);

  // In auto mode, oversized output invokes rawEncode strictly once and returns insufficient-savings
  let autoCalls = 0;
  const autoEncoder = new CanvasWebpEncoder(
    async () => {
      autoCalls++;
      return webp(5000, 2500, 200);
    },
    async () => ({ width: 64, height: 32 }),
  );
  const autoSkipped = await autoEncoder.encode(png(5000, 2500), "photo.png", config(), undefined, undefined, "auto");
  assert.equal(autoCalls, 1);
  assert.equal(autoSkipped.kind, "skipped");
  assert.equal(autoSkipped.reason, "insufficient-savings");

  const bad = new CanvasWebpEncoder(
    async () => webp(4096, 2000),
    async () => ({ width: 64, height: 31 }),
  );
  await assert.rejects(
    bad.encode(png(5000, 2500), "photo.png", config(), undefined, undefined, "manual-dialog"),
    /Unexpected output dimensions/,
  );
});

test("CanvasWebpEncoder intercepts silent WebKit image/png fallback and skips cleanly when WebP encoding is unsupported", async () => {
  const encoder = new CanvasWebpEncoder(
    async () => png(100, 100),
    async () => ({ width: 64, height: 64 }),
  );
  const res = await encoder.encode(png(100, 100, 100), "photo.png", config(), undefined, undefined, "auto");
  assert.deepEqual(res, { kind: "skipped", reason: "webp-encode-unsupported" });
});

test("WEBP_MAX_DIMENSION (16383) skips >16383px scroll screenshots in auto/document and scales them in manual modes", async () => {
  const encoder = new CanvasWebpEncoder(
    async (_blob, req) => webp(req.width, req.height),
    async () => ({ width: 64, height: 64 }),
  );
  const tallPng = png(1080, 18000, 100);
  assert.deepEqual(
    await encoder.encode(tallPng, "scroll.png", config(), undefined, undefined, "auto"),
    { kind: "skipped", reason: "dimension-limit-exceeded" },
  );
  assert.deepEqual(
    await encoder.encode(tallPng, "scroll.png", config(), undefined, undefined, "document"),
    { kind: "skipped", reason: "dimension-limit-exceeded" },
  );

  const manualRes = await encoder.encode(tallPng, "scroll.png", config(), undefined, undefined, "manual-quick");
  assert.equal(manualRes.kind, "encoded");
  if (manualRes.kind === "encoded") {
    assert.ok(manualRes.value.height <= 4096);
  }
});

test("probeSmartCompressionSupport and defaultCanvasWebpEncode detect host capabilities and release bitmap/canvas resources", async () => {
  const prevWorker = globalThis.Worker;
  const prevOffscreen = globalThis.OffscreenCanvas;
  const prevCreateBitmap = globalThis.createImageBitmap;

  try {
    delete globalThis.Worker;
    setSmartSupportResolverForTest(undefined);
    assert.deepEqual(await probeSmartCompressionSupport(), { supported: false, reason: "missing-worker" });

    globalThis.Worker = class {};
    delete globalThis.OffscreenCanvas;
    setSmartSupportResolverForTest(undefined);
    assert.deepEqual(await probeSmartCompressionSupport(), { supported: false, reason: "missing-offscreen-canvas" });

    globalThis.OffscreenCanvas = class {
      constructor(w, h) { this.width = w; this.height = h; }
      getContext() { return { fillRect() {} }; }
      async convertToBlob() { return new Blob(["png"], { type: "image/png" }); }
    };
    delete globalThis.createImageBitmap;
    setSmartSupportResolverForTest(undefined);
    assert.deepEqual(await probeSmartCompressionSupport(), { supported: false, reason: "missing-image-bitmap" });

    globalThis.createImageBitmap = async () => ({ width: 10, height: 10, close() {} });
    setSmartSupportResolverForTest(undefined);
    assert.deepEqual(await probeSmartCompressionSupport(), { supported: false, reason: "webp-encode-unsupported" });

    let bitmapClosedBeforeEncode = false;
    let bitmapClosed = false;
    let lastCanvas = null;
    globalThis.createImageBitmap = async () => ({
      width: 200,
      height: 100,
      close() { bitmapClosed = true; },
    });
    globalThis.OffscreenCanvas = class {
      constructor(w, h) {
        this.width = w;
        this.height = h;
        lastCanvas = this;
      }
      getContext() {
        return {
          imageSmoothingEnabled: false,
          imageSmoothingQuality: "low",
          fillRect() {},
          drawImage() {},
        };
      }
      async convertToBlob(opts) {
        bitmapClosedBeforeEncode = bitmapClosed;
        return webp(this.width || 1, this.height || 1);
      }
    };
    setSmartSupportResolverForTest(undefined);
    assert.deepEqual(await probeSmartCompressionSupport(), { supported: true });

    bitmapClosed = false;
    bitmapClosedBeforeEncode = false;
    const encodedBlob = await defaultCanvasWebpEncode(png(200, 100), {
      width: 200,
      height: 100,
      quality: 0.82,
      signal: new AbortController().signal,
    });
    assert.equal(encodedBlob.type, "image/webp");
    assert.equal(bitmapClosedBeforeEncode, true, "source ImageBitmap must be closed immediately before convertToBlob");
    assert.equal(lastCanvas.width, 0);
    assert.equal(lastCanvas.height, 0);
    // CSP worker-src blocking inline Blob Worker (SecurityError or async onerror) reports missing-worker
    globalThis.Worker = class {
      constructor() {
        throw new DOMException("Refused to create a worker from 'blob:...'", "SecurityError");
      }
    };
    setSmartSupportResolverForTest(undefined);
    assert.deepEqual(await probeSmartCompressionSupport(), { supported: false, reason: "missing-worker" });

    globalThis.Worker = class {
      postMessage() {
        queueMicrotask(() => this.onerror?.(new Event("error")));
      }
      terminate() {}
    };
    setSmartSupportResolverForTest(undefined);
    assert.deepEqual(await probeSmartCompressionSupport(), { supported: false, reason: "missing-worker" });

    // defaultCanvasWebpEncode falls back from OffscreenCanvas (returning image/png) to HTMLCanvasElement.toBlob
    const prevDocument = globalThis.document;
    globalThis.OffscreenCanvas = class {
      constructor(w, h) { this.width = w; this.height = h; }
      getContext() { return { drawImage() {} }; }
      async convertToBlob() { return new Blob(["png-fallback"], { type: "image/png" }); }
    };
    globalThis.createImageBitmap = async () => ({ width: 64, height: 64, close() {} });
    globalThis.document = {
      createElement(tag) {
        assert.equal(tag, "canvas");
        return {
          width: 0,
          height: 0,
          getContext: () => ({ drawImage() {} }),
          toBlob(cb, mime) {
            assert.equal(mime, "image/webp");
            cb(webp(64, 64));
          },
        };
      },
    };
    try {
      const fallbackEncoded = await defaultCanvasWebpEncode(png(64, 64), {
        width: 64,
        height: 64,
        quality: 0.8,
        signal: new AbortController().signal,
      });
      assert.equal(fallbackEncoded.type, "image/webp");
    } finally {
      globalThis.document = prevDocument;
    }
  } finally {
    globalThis.Worker = prevWorker;
    globalThis.OffscreenCanvas = prevOffscreen;
    globalThis.createImageBitmap = prevCreateBitmap;
    setSmartSupportResolverForTest(undefined);
  }
});

test("inspectImage extracts EXIF orientation, swaps dimensions, and accepts Ultra HDR / camera APP2 MPF JPEGs", async () => {
  const bytes = new Uint8Array([
    0xFF, 0xD8, // SOI
    // APP1 Exif segment
    0xFF, 0xE1, 0x00, 0x22, // Length: 34
    0x45, 0x78, 0x69, 0x66, 0x00, 0x00, // Exif\0\0
    0x49, 0x49, // Little endian
    0x2A, 0x00, // 42
    0x08, 0x00, 0x00, 0x00, // Offset to 0th IFD (8)
    0x01, 0x00, // 1 entry
    0x12, 0x01, // Tag: 0x0112 (Orientation)
    0x03, 0x00, // Type: SHORT (3)
    0x01, 0x00, 0x00, 0x00, // Count: 1
    0x06, 0x00, 0x00, 0x00, // Value: 6 (rotate 90 CW)
    0x00, 0x00, 0x00, 0x00, // Next IFD: 0
    // APP2 MPF segment (Android Ultra HDR / camera gain map index)
    0xFF, 0xE2, 0x00, 0x0A,
    0x4D, 0x50, 0x46, 0x00, // "MPF\0"
    0x49, 0x49, 0x2A, 0x00,
    // SOF0 (Baseline DCT)
    0xFF, 0xC0, 0x00, 0x0B,
    0x08, // 8-bit precision
    0x05, 0xDC, // Height: 1500
    0x0B, 0xB8, // Width: 3000
    0x01, // 1 component
    0x01, 0x11, 0x00,
    // EOI
    0xFF, 0xD9,
  ]);
  const info = inspectImage(bytes);
  assert.equal(info.mime, "image/jpeg");
  assert.equal(info.width, 1500);
  assert.equal(info.height, 3000);
});

test("CanvasWebpEncoder allows static WebP in manual-quick, blocks animated WebP, and permits drawings_v2.png (D04, I-11)", async () => {
  const staticWebp = webp(100, 100, 16);
  const encoder = new CanvasWebpEncoder(
    async () => webp(100, 100),
    async () => ({ width: 64, height: 64 }),
  );
  const quickRes = await encoder.encode(staticWebp, "assets/drawings_v2.webp", config(), undefined, undefined, "manual-quick");
  assert.equal(quickRes.kind, "encoded");

  const autoRes = await encoder.encode(staticWebp, "assets/photo.webp", config(), undefined, undefined, "auto");
  assert.deepEqual(autoRes, { kind: "skipped", reason: "protected-extension" });

  const protectedDir = await encoder.encode(png(100, 100), "assets/drawings/flow.png", config(), undefined, undefined, "manual-quick");
  assert.deepEqual(protectedDir, { kind: "skipped", reason: "protected-extension" });

  // Animated WebP (VP8X with animation bit 0x02 + ANIM chunk) must be skipped even in manual-quick
  const animBytes = new Uint8Array(44);
  const view = new DataView(animBytes.buffer);
  animBytes.set(Buffer.from("RIFF"), 0); view.setUint32(4, 36, true); animBytes.set(Buffer.from("WEBP"), 8);
  animBytes.set(Buffer.from("VP8X"), 12); view.setUint32(16, 10, true);
  animBytes[20] = 0x02;
  animBytes[24] = 99; animBytes[27] = 99;
  animBytes.set(Buffer.from("ANIM"), 30); view.setUint32(34, 6, true);
  const animRes = await encoder.encode(new Blob([animBytes], { type: "image/webp" }), "anim.webp", config(), undefined, undefined, "manual-quick");
  assert.deepEqual(animRes, { kind: "skipped", reason: "animation-protected" });
});

test("CanvasWebpEncoder passes maxEdge=64 to output decode verification and verifyBitmap resizes bitmap (B-1)", async () => {
  let receivedMaxEdge;
  const encoder = new CanvasWebpEncoder(
    async () => webp(4096, 2048),
    async (_blob, _signal, maxEdge) => {
      receivedMaxEdge = maxEdge;
      return { width: 64, height: 32 };
    },
  );
  const encoded = await encoder.encode(png(4096, 2048), "large.png", config(), undefined, undefined, "auto");
  assert.equal(encoded.kind, "encoded");
  assert.equal(receivedMaxEdge, 64);
  if (encoded.kind === "encoded") {
    assert.equal(encoded.value.width, 4096);
    assert.equal(encoded.value.height, 2048);
  }

  const prevCreateImageBitmap = globalThis.createImageBitmap;
  let capturedOptions;
  globalThis.createImageBitmap = async (_blob, options) => {
    capturedOptions = options;
    return { width: 64, height: 32, close() {} };
  };
  try {
    const dims = await verifyBitmap(webp(4096, 2048), undefined, 64);
    assert.deepEqual(dims, { width: 64, height: 32 });
    assert.deepEqual(capturedOptions, { resizeWidth: 64, resizeHeight: 64, resizeQuality: "low" });
  } finally {
    globalThis.createImageBitmap = prevCreateImageBitmap;
  }
});
