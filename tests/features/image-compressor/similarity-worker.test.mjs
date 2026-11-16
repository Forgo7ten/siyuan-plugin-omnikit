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
