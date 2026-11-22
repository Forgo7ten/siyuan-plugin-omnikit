import { test } from "node:test";
import assert from "node:assert/strict";
import { SimilarityWorkerSession } from "../../../src/features/image-compressor/similarity/SimilarityWorkerSession.ts";

function createMockWorker() {
  let messageHandler = null;
  let terminated = false;
  const postedMessages = [];

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
      // Simulate asynchronous worker response
      queueMicrotask(() => {
        if (terminated || !messageHandler) return;
        if (msg.type === "initOriginal") {
          messageHandler({
            data: { id: msg.id, type: "initOriginal", success: true, width: 256, height: 256 },
          });
        } else if (msg.type === "evaluate") {
          messageHandler({
            data: { id: msg.id, type: "evaluate", similarity: 0.9925 },
          });
        }
      });
    },
  };
  return mock;
}

test("SimilarityWorkerSession executes two-stage initOriginal and evaluate protocol", async () => {
  let createdWorker = null;
  const session = new SimilarityWorkerSession({
    workerFactory: () => {
      createdWorker = createMockWorker();
      return createdWorker;
    },
  });

  const dummyOriginal = new Blob(["dummy-original"]);
  const dummyCandidate = new Blob(["dummy-candidate"]);

  const initRes = await session.initOriginal(dummyOriginal, 512);
  assert.equal(initRes.width, 256);
  assert.equal(initRes.height, 256);

  const score = await session.evaluate(dummyCandidate);
  assert.equal(score, 0.9925);

  session.dispose();
  assert.equal(createdWorker.isTerminated, true);
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
        postMessage() {
          // Never respond to simulate hanging work
        },
      };
      return createdWorker;
    },
  });

  const pending = session.evaluate(new Blob(["test"]));
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

function buildPngBytes({ width = 10, height = 10, animated = false } = {}) {
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
  chunk("IDAT", new Uint8Array([1, 2, 3, 4]));
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

test("AdaptiveImageCompressor forwards originalInfo and returns skipped cleanly when codec skips", async () => {
  const { AdaptiveImageCompressor } = await import("../../../src/features/image-compressor/similarity/AdaptiveImageCompressor.ts");
  const seenOriginalInfo = [];
  const mockCodec = {
    name: "mock-codec",
    encode: async (_blob, _name, _config, _signal, _onProgress, _mode, options) => {
      seenOriginalInfo.push(options?.originalInfo);
      return { kind: "skipped", reason: "codec-skipped" };
    },
  };
  const compressor = new AdaptiveImageCompressor(mockCodec, {
    workerFactory: () => createMockWorker(),
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

  const result = await compressor.encode(
    new Blob([buildPngBytes({ width: 32, height: 24, animated: false })], { type: "image/png" }),
    "static.png",
    config,
    undefined,
    undefined,
    "auto",
  );
  assert.deepEqual(result, { kind: "skipped", reason: "codec-skipped" });
  assert.equal(seenOriginalInfo.length, 1);
  assert.deepEqual(seenOriginalInfo[0], { mime: "image/png", width: 32, height: 24, animated: false });
});

test("AdaptiveImageCompressor forwards originalInfo dimensions to initOriginal and worker resizes during decode (B-1)", async () => {
  const { AdaptiveImageCompressor } = await import("../../../src/features/image-compressor/similarity/AdaptiveImageCompressor.ts");
  const initMessages = [];
  const compressor = new AdaptiveImageCompressor(
    {
      name: "mock-codec",
      encode: async () => ({ kind: "skipped", reason: "stop-after-init" }),
    },
    {
      workerFactory: () => {
        const w = createMockWorker();
        const origPost = w.postMessage.bind(w);
        w.postMessage = msg => {
          if (msg.type === "initOriginal") initMessages.push(msg);
          origPost(msg);
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
      maxPixels: 32_000_000,
      maxEncodeMs: 10000,
    },
  };
  await compressor.encode(
    new Blob([buildPngBytes({ width: 4000, height: 2000, animated: false })], { type: "image/png" }),
    "large.png",
    config,
    undefined,
    undefined,
    "auto",
  );
  assert.equal(initMessages.length, 1);
  assert.equal(initMessages[0].width, 4000);
  assert.equal(initMessages[0].height, 2000);

  // Verify similarity.worker.ts calls createImageBitmap with resizeWidth/resizeHeight when dimensions are supplied
  const priorCreateImageBitmap = globalThis.createImageBitmap;
  const priorOffscreenCanvas = globalThis.OffscreenCanvas;
  const priorOnmessage = globalThis.onmessage;
  const priorPostMessage = globalThis.postMessage;
  const bitmapCalls = [];
  const responses = [];
  globalThis.createImageBitmap = async (_blob, opts) => {
    bitmapCalls.push(opts);
    return {
      width: opts?.resizeWidth ?? 4000,
      height: opts?.resizeHeight ?? 2000,
      close() {},
    };
  };
  globalThis.OffscreenCanvas = class {
    constructor(w, h) { this.w = w; this.h = h; }
    getContext() {
      return {
        imageSmoothingEnabled: false,
        imageSmoothingQuality: "low",
        drawImage() {},
        getImageData: (_x, _y, w, h) => ({ data: new Uint8ClampedArray(w * h * 4) }),
      };
    }
  };
  globalThis.postMessage = msg => responses.push(msg);
  try {
    await import(`../../../src/features/image-compressor/similarity/similarity.worker.ts?b1=${Date.now()}`);
    await globalThis.onmessage({
      data: { type: "initOriginal", id: 1, original: new Blob(["x"]), maxEdge: 512, width: 4000, height: 2000 },
    });
    await globalThis.onmessage({
      data: { type: "evaluate", id: 2, candidate: new Blob(["y"]) },
    });
    assert.deepEqual(bitmapCalls[0], { resizeWidth: 512, resizeHeight: 256, resizeQuality: "high" });
    assert.deepEqual(bitmapCalls[1], { resizeWidth: 512, resizeHeight: 256, resizeQuality: "high" });
    assert.equal(responses[0].width, 512);
    assert.equal(responses[0].height, 256);
  } finally {
    globalThis.createImageBitmap = priorCreateImageBitmap;
    globalThis.OffscreenCanvas = priorOffscreenCanvas;
    globalThis.onmessage = priorOnmessage;
    globalThis.postMessage = priorPostMessage;
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
        encode: async () => ({
          kind: "encoded",
          value: { file: new File(["webp"], "out.webp", { type: "image/webp" }), originalBytes: 100, outputBytes: 10, width: 32, height: 24 },
        }),
      },
      {
        workerFactory: () => {
          const w = {
            onmessage: null,
            onerror: null,
            onmessageerror: null,
            terminate() { terminated = true; },
            postMessage(msg) {
              if (msg.type === "initOriginal") {
                queueMicrotask(() => w.onmessage?.({ data: { id: msg.id, type: "initOriginal", success: true, width: 32, height: 24 } }));
              }
              // Intentionally hang on "evaluate"
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
  const webpBytes = new Uint8Array(48);
  const view = new DataView(webpBytes.buffer);
  webpBytes.set(Buffer.from("RIFF"), 0); view.setUint32(4, 40, true); webpBytes.set(Buffer.from("WEBP"), 8);
  webpBytes.set(Buffer.from("VP8X"), 12); view.setUint32(16, 10, true);
  webpBytes[24] = 9; webpBytes[27] = 9;
  webpBytes.set(Buffer.from("VP8 "), 30); view.setUint32(34, 10, true);
  webpBytes.set([0x9d, 0x01, 0x2a], 41);
  view.setUint16(44, 10, true); view.setUint16(46, 10, true);

  let codecCalled = false;
  const compressor = new AdaptiveImageCompressor(
    {
      name: "mock-codec",
      encode: async () => {
        codecCalled = true;
        return { kind: "skipped", reason: "insufficient-savings" };
      },
    },
    { workerFactory: () => createMockWorker() },
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
  await compressor.encode(new Blob([webpBytes], { type: "image/webp" }), "static.webp", config, undefined, undefined, "manual-quick");
  assert.equal(codecCalled, true);
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
      encode: async () => ({
        kind: "encoded",
        value: { file: new File(["webp"], "out.webp", { type: "image/webp" }), originalBytes: 100, outputBytes: 10, width: 32, height: 24 },
      }),
    },
    {
      workerFactory: () => {
        workerCreated = true;
        const w = {
          onmessage: null,
          onerror: null,
          onmessageerror: null,
          terminate() {},
          postMessage(msg) {
            if (msg.type === "initOriginal") {
              queueMicrotask(() => w.onmessage?.({ data: { id: msg.id, type: "initOriginal", success: true, width: 32, height: 24 } }));
            }
            // Hang on evaluate to trigger deadline or user abort
          },
        };
        return w;
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

  // BicEncoder.encode must normalize string abort reasons passed through controller.signal to browser-image-compression
  const { BicEncoder } = await import("../../../src/features/image-compressor/services/image.ts");
  const bicAbortController = new AbortController();
  const encoder = new BicEncoder(
    (_file, opts) => new Promise((_resolve, reject) => {
      opts.signal.addEventListener("abort", () => reject(opts.signal.reason), { once: true });
    }),
    "",
  );
  const bicPending = encoder.encode(
    new Blob([buildPngBytes({ width: 32, height: 24 })], { type: "image/png" }),
    "plain.png",
    { compression: { ...userAbortConfig.compression, smartEnabled: false } },
    bicAbortController.signal,
    undefined,
    "auto",
  );
  setTimeout(() => bicAbortController.abort("Sync started"), 10);
  await assert.rejects(
    bicPending,
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
      searchRounds: [{ quality: 0.85, similarity: 0.996, bytes: 700 }, { quality: 0.72, similarity: 0.992, bytes: 512 }],
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
  assert.equal(infoLogs[1].data.quality, undefined, "smart mode keeps quality under smart object without top-level duplicate");
  assert.deepEqual(infoLogs[1].data.smart, {
    quality: 0.72,
    similarity: 0.992,
    targetSimilarity: 0.99,
    searchRounds: [{ quality: 0.85, similarity: 0.996, bytes: 700 }, { quality: 0.72, similarity: 0.992, bytes: 512 }],
  });

  // Skipped task (e.g. smart unreachable) also logs info with reason and smart search summary
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

  // Failed task (non-abort error) logs info with status: "failed" before rethrowing
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
