import { test } from "node:test";
import assert from "node:assert/strict";
import { SimilarityWorkerSession } from "../../../src/features/image-compressor/similarity/SimilarityWorkerSession.ts";
import { setSmartSupportResolverForTest } from "../../../src/features/image-compressor/services/image.ts";

function buildValidWebpBlob(width = 32, height = 24, extraEvenPadding = 0) {
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

function createMockWorker({ similarityForQuality = () => 0.9925, extraPadding = 0 } = {}) {
  let messageHandler = null;
  let terminated = false;
  const postedMessages = [];
  let targetW = 32;
  let targetH = 24;

  const mock = {
    get onmessage() { return messageHandler; },
    set onmessage(fn) { messageHandler = fn; },
    onerror: null,
    onmessageerror: null,
    terminate() { terminated = true; },
    get isTerminated() { return terminated; },
    get posted() { return postedMessages; },
    postMessage(msg) {
      postedMessages.push(msg);
      queueMicrotask(() => {
        if (terminated || !messageHandler) return;
        if (msg.type === "initSession") {
          targetW = msg.targetWidth;
          targetH = msg.targetHeight;
          messageHandler({
            data: { id: msg.id, type: "initSession", success: true, width: targetW, height: targetH, patchCount: 0 },
          });
        } else if (msg.type === "encodeAndEvaluate") {
          const blob = buildValidWebpBlob(targetW, targetH, extraPadding);
          messageHandler({
            data: {
              id: msg.id,
              type: "encodeAndEvaluate",
              blob,
              bytes: blob.size,
              similarity: similarityForQuality(msg.quality),
            },
          });
        } else if (msg.type === "dispose" && typeof msg.id === "number") {
          messageHandler({
            data: { id: msg.id, type: "dispose", success: true },
          });
        }
      });
    },
  };
  return mock;
}

test("SimilarityWorkerSession executes single-session initSession, encodeAndEvaluate, and dispose protocol", async () => {
  let createdWorker = null;
  const session = new SimilarityWorkerSession({
    workerFactory: () => {
      createdWorker = createMockWorker();
      return createdWorker;
    },
  });

  const dummyOriginal = new Blob(["dummy-original"]);
  const initRes = await session.initSession(dummyOriginal, 256, 192, { fullFrameMaxEdge: 768 });
  assert.equal(initRes.width, 256);
  assert.equal(initRes.height, 192);
  assert.equal(initRes.patchCount, 0);

  const evalRes = await session.encodeAndEvaluate(0.78);
  assert.equal(evalRes.similarity, 0.9925);
  assert.ok(evalRes.blob instanceof Blob);
  assert.equal(evalRes.bytes, evalRes.blob.size);

  let disposedAckedBeforeTerminate = false;
  const origTerminate = createdWorker.terminate.bind(createdWorker);
  createdWorker.terminate = () => {
    disposedAckedBeforeTerminate = createdWorker.posted.some(m => m.type === "dispose" && typeof m.id === "number");
    origTerminate();
  };
  await session.close();
  assert.equal(disposedAckedBeforeTerminate, true);
  assert.equal(createdWorker.isTerminated, true);
  assert.equal(createdWorker.posted.at(-1)?.type, "dispose");
});

test("SimilarityWorkerSession terminates worker and rejects pending on AbortSignal", async () => {
  const controller = new AbortController();
  let createdWorker = null;
  const session = new SimilarityWorkerSession({
    signal: controller.signal,
    workerFactory: () => {
      createdWorker = {
        onmessage: null,
        onerror: null,
        onmessageerror: null,
        terminate() { this.terminated = true; },
        terminated: false,
        postMessage() {},
      };
      return createdWorker;
    },
  });

  const pending = session.encodeAndEvaluate(0.78);
  controller.abort();

  await assert.rejects(pending, (err) => {
    return err instanceof DOMException && err.name === "AbortError";
  });
  assert.equal(createdWorker.terminated, true);
});

test("AdaptiveImageCompressor skips below-threshold files without creating worker", async () => {
  const { AdaptiveImageCompressor } = await import("../../../src/features/image-compressor/similarity/AdaptiveImageCompressor.ts");
  let workerCreated = false;
  const mockCodec = {
    name: "mock-codec",
    encode: async () => ({ kind: "skipped", reason: "mock" }),
  };
  const compressor = new AdaptiveImageCompressor(mockCodec, {
    workerFactory: () => {
      workerCreated = true;
      return createMockWorker();
    },
  });

  const smallBlob = new Blob(["tiny"]);
  const config = {
    compression: {
      smartEnabled: true,
      minInputBytes: 1024,
      maxInputBytes: 10 * 1024 * 1024,
      excludedExtensions: [],
      initialQuality: 0.8,
      manualMaxEdge: 4096,
      minSavingBytes: 0,
      minSavingRatio: 0,
      maxPixels: 1000000,
      maxEncodeMs: 10000,
    },
  };

  const result = await compressor.encode(smallBlob, "photo.jpg", config, undefined, undefined, "auto");
  assert.equal(result.kind, "skipped");
  assert.equal(result.reason, "below_threshold");
  assert.equal(workerCreated, false);
});

function buildPngBytes({ width = 10, height = 10, animated = false, extraBytes = 120 } = {}) {
  const chunks = [];
  const chunk = (type, data) => {
    const buf = new Uint8Array(12 + data.length);
    const view = new DataView(buf.buffer);
    view.setUint32(0, data.length, false);
    for (let i = 0; i < 4; i++) buf[4 + i] = type.charCodeAt(i);
    buf.set(data, 8);
    chunks.push(buf);
  };
  const ihdr = new Uint8Array(13);
  const ihdrView = new DataView(ihdr.buffer);
  ihdrView.setUint32(0, width, false);
  ihdrView.setUint32(4, height, false);
  chunk("IHDR", ihdr);
  if (animated) chunk("acTL", new Uint8Array(8));
  chunk("IDAT", new Uint8Array(Math.max(4, extraBytes)).fill(1));
  chunk("IEND", new Uint8Array(0));
  const sig = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);
  const total = sig.length + chunks.reduce((sum, c) => sum + c.length, 0);
  const out = new Uint8Array(total);
  out.set(sig, 0);
  let offset = sig.length;
  for (const c of chunks) { out.set(c, offset); offset += c.length; }
  return out;
}

function buildAnimatedWebpBytes({ width = 10, height = 10 } = {}) {
  const vp8xData = new Uint8Array(10);
  vp8xData[0] = 0x02; // Animation flag
  const wMinus1 = width - 1;
  const hMinus1 = height - 1;
  vp8xData[4] = wMinus1 & 0xff;
  vp8xData[5] = (wMinus1 >> 8) & 0xff;
  vp8xData[6] = (wMinus1 >> 16) & 0xff;
  vp8xData[7] = hMinus1 & 0xff;
  vp8xData[8] = (hMinus1 >> 8) & 0xff;
  vp8xData[9] = (hMinus1 >> 16) & 0xff;

  const animData = new Uint8Array(6);
  const totalPayload = 4 + (8 + vp8xData.length) + (8 + animData.length);
  const out = new Uint8Array(8 + totalPayload);
  const view = new DataView(out.buffer);
  const writeTag = (pos, tag) => { for (let i = 0; i < 4; i++) out[pos + i] = tag.charCodeAt(i); };
  writeTag(0, "RIFF");
  view.setUint32(4, totalPayload, true);
  writeTag(8, "WEBP");
  writeTag(12, "VP8X");
  view.setUint32(16, vp8xData.length, true);
  out.set(vp8xData, 20);
  writeTag(30, "ANIM");
  view.setUint32(34, animData.length, true);
  out.set(animData, 38);
  return out;
}

test("AdaptiveImageCompressor skips APNG and animated WebP without creating worker", async () => {
  const { AdaptiveImageCompressor } = await import("../../../src/features/image-compressor/similarity/AdaptiveImageCompressor.ts");
  let workerCreated = false;
  const mockCodec = {
    name: "mock-codec",
    encode: async () => { throw new Error("Underlying codec should not be called for animated images"); },
  };
  const compressor = new AdaptiveImageCompressor(mockCodec, {
    workerFactory: () => {
      workerCreated = true;
      return createMockWorker();
    },
  });
  const config = {
    compression: {
      smartEnabled: true,
      targetSimilarity: 0.99,
      minInputBytes: 0,
      maxInputBytes: 10 * 1024 * 1024,
      excludedExtensions: [],
      initialQuality: 0.8,
      manualMaxEdge: 4096,
      minSavingBytes: 0,
      minSavingRatio: 0,
      maxPixels: 1000000,
      maxEncodeMs: 10000,
    },
  };

  const apngResult = await compressor.encode(
    new Blob([buildPngBytes({ animated: true })], { type: "image/png" }),
    "anim.png",
    config,
    undefined,
    undefined,
    "auto",
  );
  assert.deepEqual(apngResult, { kind: "skipped", reason: "animation-protected" });

  const animatedWebpResult = await compressor.encode(
    new Blob([buildAnimatedWebpBytes()], { type: "image/webp" }),
    "anim.webp",
    config,
    undefined,
    undefined,
    "manual-dialog",
  );
  assert.deepEqual(animatedWebpResult, { kind: "skipped", reason: "animation-protected" });
  assert.equal(workerCreated, false);
});

test("similarity.worker.ts decodes original once, closes bitmaps immediately, runs hybrid global+patch evaluation on large images, zeroes canvases on dispose, and rejects PNG fallback", async () => {
  const priorCreateImageBitmap = globalThis.createImageBitmap;
  const priorOffscreenCanvas = globalThis.OffscreenCanvas;
  const priorOnmessage = globalThis.onmessage;
  const priorPostMessage = globalThis.postMessage;

  let originalBitmapsCreated = 0;
  let originalClosedBeforeInitDone = false;
  let candidateBitmapsCreated = 0;
  let candidateBitmapsClosed = 0;
  let outputMime = "image/webp";
  const createdCanvases = [];
  const contextOptionsSeen = [];
  const responses = [];

  globalThis.createImageBitmap = async (blob) => {
    const isCandidate = blob.type === "image/webp";
    if (isCandidate) {
      candidateBitmapsCreated++;
      return {
        width: 1600,
        height: 1200,
        close() { candidateBitmapsClosed++; },
      };
    }
    originalBitmapsCreated++;
    let closed = false;
    return {
      width: 2000,
      height: 1500,
      get isClosed() { return closed; },
      close() { closed = true; originalClosedBeforeInitDone = true; },
    };
  };

  globalThis.OffscreenCanvas = class {
    constructor(w, h) {
      this.width = w;
      this.height = h;
      createdCanvases.push(this);
    }
    getContext(_type, opts) {
      contextOptionsSeen.push({ width: this.width, height: this.height, opts });
      return {
        imageSmoothingEnabled: false,
        imageSmoothingQuality: "low",
        clearRect() {},
        drawImage() {},
        getImageData: (_x, _y, w, h) => {
          const data = new Uint8ClampedArray(w * h * 4);
          for (let i = 0; i < data.length; i += 4) {
            const p = i >> 2;
            const v = ((p * 7) ^ (p >> 3)) & 255;
            data[i] = v;
            data[i + 1] = v;
            data[i + 2] = v;
            data[i + 3] = 255;
          }
          return { data };
        },
      };
    }
    async convertToBlob() {
      if (outputMime !== "image/webp") {
        return new Blob(["png-fallback"], { type: outputMime });
      }
      return buildValidWebpBlob(this.width, this.height, 20);
    }
  };
  globalThis.postMessage = msg => responses.push(msg);

  try {
    await import(`../../../src/features/image-compressor/similarity/similarity.worker.ts?session=${Date.now()}`);

    // 1. Large image (1600x1200 > 768) initializes global + 2 detail patches and closes original bitmap immediately
    await globalThis.onmessage({
      data: {
        type: "initSession",
        id: 1,
        original: new Blob(["orig-png"], { type: "image/png" }),
        targetWidth: 1600,
        targetHeight: 1200,
      },
    });
    assert.equal(originalBitmapsCreated, 1);
    assert.equal(originalClosedBeforeInitDone, true);
    assert.equal(responses[0].type, "initSession");
    assert.equal(responses[0].width, 1600);
    assert.equal(responses[0].height, 1200);
    assert.equal(responses[0].patchCount, 2);
    // First canvas is sourceCanvas (1600x1200) requested WITHOUT willReadFrequently
    assert.equal(contextOptionsSeen[0].opts, undefined);

    // 2. encodeAndEvaluate decodes candidate, computes hybrid MS-SSIM, and closes candidate bitmap
    await globalThis.onmessage({
      data: { type: "encodeAndEvaluate", id: 2, quality: 0.78 },
    });
    assert.equal(originalBitmapsCreated, 1, "original must not be re-decoded across rounds");
    assert.equal(candidateBitmapsCreated, 1);
    assert.equal(candidateBitmapsClosed, 1);
    assert.equal(responses[1].type, "encodeAndEvaluate");
    assert.ok(responses[1].similarity > 0.99);

    // 3. skipEvaluateIfOversize bypasses candidate decode when bytes > maxAllowedBytes
    await globalThis.onmessage({
      data: { type: "encodeAndEvaluate", id: 3, quality: 0.5, maxAllowedBytes: 10, skipEvaluateIfOversize: true },
    });
    assert.equal(candidateBitmapsCreated, 1, "oversize candidate with skipEvaluateIfOversize must not call createImageBitmap");
    assert.equal(responses[2].similarity, undefined);

    // 4. WebKit silent PNG fallback in convertToBlob triggers explicit error
    outputMime = "image/png";
    await globalThis.onmessage({
      data: { type: "encodeAndEvaluate", id: 4, quality: 0.8 },
    });
    assert.match(responses[3].error, /WebP encoding is not supported/);

    // 5. dispose zeroes out sourceCanvas and readCanvas dimensions
    await globalThis.onmessage({ data: { type: "dispose", id: 5 } });
    for (const c of createdCanvases) {
      assert.equal(c.width, 0);
      assert.equal(c.height, 0);
    }
  } finally {
    globalThis.createImageBitmap = priorCreateImageBitmap;
    globalThis.OffscreenCanvas = priorOffscreenCanvas;
    globalThis.onmessage = priorOnmessage;
    globalThis.postMessage = priorPostMessage;
  }
});

test("AdaptiveImageCompressor returns unreachable preview in manual-dialog, skips in auto/manual-quick, and falls back when smart support is unavailable", async () => {
  const { AdaptiveImageCompressor } = await import("../../../src/features/image-compressor/similarity/AdaptiveImageCompressor.ts");

  const unreachableCompressor = new AdaptiveImageCompressor(
    {
      name: "fallback-codec",
      encode: async () => { throw new Error("should not call fallback codec when workerFactory is provided"); },
    },
    {
      workerFactory: () => createMockWorker({ similarityForQuality: q => 0.88 + q * 0.08 }),
      decode: async () => ({ width: 32, height: 24 }),
    },
  );

  const cfg = {
    compression: {
      smartEnabled: true,
      targetSimilarity: 0.99,
      minInputBytes: 0,
      maxInputBytes: 10 * 1024 * 1024,
      excludedExtensions: ["gif", "svg", "webp"],
      initialQuality: 0.25, // Must NOT pollute smart search startQuality (0.78)
      manualMaxEdge: 4096,
      minSavingBytes: 0,
      minSavingRatio: 0,
      maxPixels: 1000000,
      maxEncodeMs: 10000,
    },
  };
  const inputPng = new Blob([buildPngBytes({ width: 32, height: 24, extraBytes: 200 })], { type: "image/png" });

  // In auto and manual-quick, unreachable skips
  const autoRes = await unreachableCompressor.encode(inputPng, "chart.png", cfg, undefined, undefined, "auto");
  assert.equal(autoRes.kind, "skipped");
  assert.match(autoRes.reason, /^target-similarity-unreachable:/);
  assert.equal(autoRes.smart?.searchRounds?.[0]?.quality, 0.78, "smart search must start at policy.startQuality 0.78");

  const quickRes = await unreachableCompressor.encode(inputPng, "chart.png", cfg, undefined, undefined, "manual-quick");
  assert.equal(quickRes.kind, "skipped");

  // In manual-dialog, unreachable returns highest-quality candidate with unreachable: true!
  const dialogRes = await unreachableCompressor.encode(inputPng, "chart.png", cfg, undefined, undefined, "manual-dialog");
  assert.equal(dialogRes.kind, "encoded");
  if (dialogRes.kind === "encoded") {
    assert.equal(dialogRes.value.unreachable, true);
    assert.equal(dialogRes.value.quality, 1.0);
    assert.ok(dialogRes.value.similarity < 0.99);
    assert.equal(dialogRes.value.targetSimilarity, 0.99);
  }

  // Host capability fallback when probeSmartCompressionSupport reports unsupported
  let fallbackConfigSeen = null;
  setSmartSupportResolverForTest(() => ({ supported: false, reason: "webp-encode-unsupported" }));
  try {
    const fallbackCompressor = new AdaptiveImageCompressor({
      name: "fixed-codec",
      encode: async (_blob, _name, delegatedCfg) => {
        fallbackConfigSeen = delegatedCfg;
        return {
          kind: "encoded",
          value: {
            file: new File([buildValidWebpBlob(32, 24)], "chart.webp", { type: "image/webp" }),
            originalBytes: inputPng.size,
            outputBytes: 48,
            width: 32,
            height: 24,
            quality: delegatedCfg.compression.initialQuality,
          },
        };
      },
    });
    const fallbackRes = await fallbackCompressor.encode(inputPng, "chart.png", cfg, undefined, undefined, "auto");
    assert.equal(fallbackRes.kind, "encoded");
    assert.equal(fallbackConfigSeen.compression.smartEnabled, false);
  } finally {
    setSmartSupportResolverForTest(undefined);
  }
});

test("AdaptiveImageCompressor enforces maxEncodeMs deadline without unhandled rejections (P2-5)", async () => {
  const { AdaptiveImageCompressor } = await import("../../../src/features/image-compressor/similarity/AdaptiveImageCompressor.ts");
  let terminated = false;
  let unhandled = false;
  const onUnhandled = () => { unhandled = true; };
  process.on("unhandledRejection", onUnhandled);
  try {
    const compressor = new AdaptiveImageCompressor(
      {
        name: "mock-codec",
        encode: async () => ({ kind: "skipped", reason: "unused" }),
      },
      {
        workerFactory: () => {
          const w = {
            onmessage: null,
            onerror: null,
            onmessageerror: null,
            terminate() { terminated = true; },
            postMessage(msg) {
              if (msg.type === "initSession") {
                queueMicrotask(() => w.onmessage?.({ data: { id: msg.id, type: "initSession", success: true, width: 32, height: 24, patchCount: 0 } }));
              }
              // Intentionally hang on "encodeAndEvaluate"
            },
          };
          return w;
        },
      },
    );
    const config = {
      compression: {
        smartEnabled: true,
        targetSimilarity: 0.99,
        minInputBytes: 0,
        maxInputBytes: 10 * 1024 * 1024,
        excludedExtensions: [],
        initialQuality: 0.8,
        manualMaxEdge: 4096,
        minSavingBytes: 0,
        minSavingRatio: 0,
        maxPixels: 1000000,
        maxEncodeMs: 40,
      },
    };
    await assert.rejects(
      compressor.encode(new Blob([buildPngBytes({ width: 32, height: 24 })], { type: "image/png" }), "static.png", config, undefined, undefined, "auto"),
      /deadline|AbortError|cancelled/i,
    );
    await new Promise(r => setTimeout(r, 30));
    assert.equal(terminated, true);
    assert.equal(unhandled, false);
  } finally {
    process.off("unhandledRejection", onUnhandled);
  }
});

test("AdaptiveImageCompressor allows static WebP in manual-quick when smartEnabled is true (D04)", async () => {
  const { AdaptiveImageCompressor } = await import("../../../src/features/image-compressor/similarity/AdaptiveImageCompressor.ts");
  const webpBlob = buildValidWebpBlob(10, 10, 40);

  let workerInitialized = false;
  const compressor = new AdaptiveImageCompressor(
    {
      name: "mock-codec",
      encode: async () => ({ kind: "skipped", reason: "unused" }),
    },
    {
      workerFactory: () => {
        const w = createMockWorker();
        const origPost = w.postMessage.bind(w);
        w.postMessage = msg => {
          if (msg.type === "initSession") workerInitialized = true;
          origPost(msg);
        };
        return w;
      },
      decode: async () => ({ width: 10, height: 10 }),
    },
  );
  const config = {
    compression: {
      smartEnabled: true,
      targetSimilarity: 0.99,
      minInputBytes: 0,
      maxInputBytes: 10 * 1024 * 1024,
      excludedExtensions: ["gif", "svg", "webp"],
      initialQuality: 0.8,
      manualMaxEdge: 4096,
      minSavingBytes: 0,
      minSavingRatio: 0,
      maxPixels: 1000000,
      maxEncodeMs: 10000,
    },
  };
  const res = await compressor.encode(webpBlob, "static.webp", config, undefined, undefined, "manual-quick");
  assert.equal(workerInitialized, true);
  assert.equal(res.kind, "encoded");
});

test("AdaptiveImageCompressor throws on maxInputBytes and preserves non-AbortError deadline vs string abort", async () => {
  const { AdaptiveImageCompressor } = await import("../../../src/features/image-compressor/similarity/AdaptiveImageCompressor.ts");
  const { isAbortError } = await import("../../../src/core/feedback/UiFeedback.ts");
  let workerCreated = false;
  const baseConfig = {
    compression: {
      smartEnabled: true,
      targetSimilarity: 0.99,
      minInputBytes: 0,
      maxInputBytes: 16,
      excludedExtensions: [],
      initialQuality: 0.8,
      manualMaxEdge: 4096,
      minSavingBytes: 0,
      minSavingRatio: 0,
      maxPixels: 1000000,
      maxEncodeMs: 40,
    },
  };
  const compressor = new AdaptiveImageCompressor(
    {
      name: "mock-codec",
      encode: async () => ({ kind: "skipped", reason: "unused" }),
    },
    {
      workerFactory: () => {
        workerCreated = true;
        return {
          onmessage: null,
          onerror: null,
          onmessageerror: null,
          terminate() {},
          postMessage(msg) {
            if (msg.type === "initSession") {
              queueMicrotask(() => this.onmessage?.({ data: { id: msg.id, type: "initSession", success: true, width: 32, height: 24, patchCount: 0 } }));
            }
          },
        };
      },
    },
  );

  await assert.rejects(
    compressor.encode(new Blob([new Uint8Array(32)], { type: "image/png" }), "oversize.png", baseConfig, undefined, undefined, "auto"),
    /Input exceeds byte limit/,
  );
  assert.equal(workerCreated, false);

  const deadlineConfig = {
    compression: { ...baseConfig.compression, maxInputBytes: 10 * 1024 * 1024, maxEncodeMs: 30 },
  };
  await assert.rejects(
    compressor.encode(new Blob([buildPngBytes({ width: 32, height: 24 })], { type: "image/png" }), "slow.png", deadlineConfig, undefined, undefined, "auto"),
    err => err instanceof Error && err.message === "Encode deadline exceeded" && !isAbortError(err),
  );

  const userController = new AbortController();
  const userAbortConfig = {
    compression: { ...baseConfig.compression, maxInputBytes: 10 * 1024 * 1024, maxEncodeMs: 5000 },
  };
  const pending = compressor.encode(
    new Blob([buildPngBytes({ width: 32, height: 24 })], { type: "image/png" }),
    "cancelled.png",
    userAbortConfig,
    userController.signal,
    undefined,
    "auto",
  );
  setTimeout(() => userController.abort("Sync started"), 15);
  await assert.rejects(
    pending,
    err => isAbortError(err) && err instanceof DOMException && err.message === "Sync started",
  );

  // CanvasWebpEncoder.encode must normalize string abort reasons passed through controller.signal
  const { CanvasWebpEncoder } = await import("../../../src/features/image-compressor/services/image.ts");
  const codecAbortController = new AbortController();
  const encoder = new CanvasWebpEncoder(
    (_blob, req) => new Promise((_resolve, reject) => {
      req.signal.addEventListener("abort", () => reject(req.signal.reason), { once: true });
    }),
  );
  const codecPending = encoder.encode(
    new Blob([buildPngBytes({ width: 32, height: 24 })], { type: "image/png" }),
    "plain.png",
    { compression: { ...userAbortConfig.compression, smartEnabled: false } },
    codecAbortController.signal,
    undefined,
    "auto",
  );
  setTimeout(() => codecAbortController.abort("Sync started"), 10);
  await assert.rejects(
    codecPending,
    err => isAbortError(err) && err instanceof DOMException && err.message === "Sync started",
  );
});

test("compressOccurrence logs detailed paths, size change, ratio, and smart metadata via info logger", async () => {
  const { compressOccurrence } = await import("../../../src/features/image-compressor/services/ImageProcessingServices.ts");
  const { buildCompressionNoticeValues } = await import("../../../src/features/image-compressor/policy/formatStats.ts");

  const infoLogs = [];
  const makeServices = (encodedValue) => ({
    origin: "http://127.0.0.1:6806",
    mobile: false,
    userAgent: () => "test",
    config: () => ({}),
    recordsReady: Promise.resolve(),
    records: {
      upsert: async () => {},
      markOperation: async () => {},
    },
    assets: {
      upload: async () => "assets/photo-compressed.webp",
    },
    references: {
      commitOccurrence: async () => "replaced",
    },
    reader: {
      read: async () => ({
        blob: new Blob([new Uint8Array(2048)], { type: "image/png" }),
        name: "photo.png",
      }),
    },
    encoder: {
      name: "mock-encoder",
      encode: async () => ({
        kind: "encoded",
        value: {
          file: new File([new Uint8Array(512)], "photo.webp", { type: "image/webp" }),
          originalBytes: 2048,
          outputBytes: 512,
          width: 64,
          height: 64,
          ...encodedValue,
        },
      }),
    },
    logger: {
      info: (message, data) => infoLogs.push({ message, data }),
    },
  });

  const target = {
    rootID: "20240101010101-abcdefg",
    notebook: "20240101010101-box1234",
    blockID: "20240101010101-blk1234",
    imageOrdinal: 0,
    oldPath: "assets/photo-orig.png",
  };
  const cfg = {
    compression: {
      initialQuality: 0.85,
      manualMaxEdge: 1920,
      minInputBytes: 10,
      minSavingBytes: 10,
      minSavingRatio: 0.05,
      maxInputBytes: 10 * 1024 * 1024,
      maxPixels: 25_000_000,
      maxEncodeMs: 5000,
      excludedExtensions: ["gif", "svg", "webp"],
      smartEnabled: false,
      targetSimilarity: 0.99,
    },
  };

  const controller = new AbortController();
  const standardRes = await compressOccurrence(makeServices({ quality: 0.85 }), target, cfg, controller.signal, { replace: true });
  assert.equal(standardRes.status, "saved");
  assert.equal(infoLogs.length, 1);
  assert.equal(infoLogs[0].data.status, "saved");
  assert.equal(infoLogs[0].data.mode, "auto");
  assert.equal(infoLogs[0].data.sourcePath, "assets/photo-orig.png");
  assert.equal(infoLogs[0].data.compressedPath, "assets/photo-compressed.webp");
  assert.equal(infoLogs[0].data.sizeChange, "2.0 KB -> 512 B");
  assert.equal(infoLogs[0].data.compressionRatio, "-75.0%");
  assert.equal(infoLogs[0].data.quality, 0.85);
  assert.equal(infoLogs[0].data.smart, undefined);

  const smartRes = await compressOccurrence(
    makeServices({
      quality: 0.72,
      similarity: 0.992,
      targetSimilarity: 0.99,
      searchRounds: [{ quality: 0.78, similarity: 0.996, bytes: 700 }, { quality: 0.72, similarity: 0.992, bytes: 512 }],
    }),
    target,
    { compression: { ...cfg.compression, smartEnabled: true } },
    controller.signal,
    { replace: true },
  );
  assert.equal(smartRes.status, "saved");
  assert.equal(infoLogs.length, 2);
  assert.equal(infoLogs[1].data.status, "saved");
  assert.equal(infoLogs[1].data.sourcePath, "assets/photo-orig.png");
  assert.equal(infoLogs[1].data.compressedPath, "assets/photo-compressed.webp");
  assert.equal(infoLogs[1].data.compressionRatio, "-75.0%");
  assert.equal(infoLogs[1].data.quality, undefined);
  assert.deepEqual(infoLogs[1].data.smart, {
    quality: 0.72,
    similarity: 0.992,
    targetSimilarity: 0.99,
    searchRounds: [{ quality: 0.78, similarity: 0.996, bytes: 700 }, { quality: 0.72, similarity: 0.992, bytes: 512 }],
  });

  const skippedServices = makeServices({});
  skippedServices.encoder.encode = async () => ({
    kind: "skipped",
    reason: "target-similarity-unreachable:0.97",
    originalBytes: 2048,
    smart: {
      quality: 1,
      similarity: 0.97,
      targetSimilarity: 0.99,
      searchRounds: [{ quality: 1, similarity: 0.97, bytes: 1800 }],
    },
  });
  const skippedRes = await compressOccurrence(skippedServices, target, { compression: { ...cfg.compression, smartEnabled: true } }, controller.signal, { replace: true });
  assert.equal(skippedRes.status, "skipped");
  assert.equal(infoLogs.length, 3);
  assert.equal(infoLogs[2].data.status, "skipped");
  assert.equal(infoLogs[2].data.sourcePath, "assets/photo-orig.png");
  assert.equal(infoLogs[2].data.reason, "target-similarity-unreachable:0.97");
  assert.equal(infoLogs[2].data.smart.similarity, 0.97);

  const failedServices = makeServices({});
  failedServices.encoder.encode = async () => { throw new Error("decode boom"); };
  await assert.rejects(
    compressOccurrence(failedServices, target, cfg, controller.signal, { replace: true }),
    /decode boom/,
  );
  assert.equal(infoLogs.length, 4);
  assert.equal(infoLogs[3].data.status, "failed");
  assert.equal(infoLogs[3].data.sourcePath, "assets/photo-orig.png");
  assert.equal(infoLogs[3].data.error, "decode boom");

  assert.deepEqual(buildCompressionNoticeValues(2048, 512), {
    original: "2.0 KB",
    compressed: "512 B",
    ratio: "-75.0%",
  });
  assert.deepEqual(buildCompressionNoticeValues(1000, 1200), {
    original: "1000 B",
    compressed: "1.2 KB",
    ratio: "+20.0%",
  });
  assert.deepEqual(buildCompressionNoticeValues(1000, 1000), {
    original: "1000 B",
    compressed: "1000 B",
    ratio: "0.0%",
  });
});
