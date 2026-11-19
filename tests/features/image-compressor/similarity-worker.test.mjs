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
        } else {
          messageHandler({
            data: { id: msg.id, similarity: 0.985 },
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

test("SimilarityWorkerSession supports one-shot evaluateDirect", async () => {
  let createdWorker = null;
  const session = new SimilarityWorkerSession({
    workerFactory: () => {
      createdWorker = createMockWorker();
      return createdWorker;
    },
  });

  const dummyA = new Blob(["orig"]);
  const dummyB = new Blob(["cand"]);
  const score = await session.evaluateDirect(dummyA, dummyB);
  assert.equal(score, 0.985);

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
