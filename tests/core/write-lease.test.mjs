import { test } from "node:test";
import assert from "node:assert/strict";
import { withBlockWriteLease } from "../../src/core/host/BlockWriteLease.ts";

test("withBlockWriteLease serializes operations for the same notebook/blockID", async () => {
  const order = [];
  let active = 0;
  let maxConcurrent = 0;
  let releaseFirst;
  let markFirstStarted;
  const firstStarted = new Promise(resolve => { markFirstStarted = resolve; });
  const firstBlocked = new Promise(resolve => { releaseFirst = resolve; });

  const first = withBlockWriteLease("box-1", "block-1", undefined, async () => {
    active++;
    maxConcurrent = Math.max(maxConcurrent, active);
    order.push("first:start");
    markFirstStarted();
    await firstBlocked;
    order.push("first:end");
    active--;
    return "first";
  });

  const second = withBlockWriteLease("box-1", "block-1", undefined, async () => {
    active++;
    maxConcurrent = Math.max(maxConcurrent, active);
    order.push("second");
    active--;
    return "second";
  });

  await firstStarted;
  assert.deepEqual(order, ["first:start"]);

  releaseFirst();
  assert.deepEqual(await Promise.all([first, second]), ["first", "second"]);
  assert.equal(maxConcurrent, 1);
  assert.deepEqual(order, ["first:start", "first:end", "second"]);
});

test("withBlockWriteLease runs different keys concurrently", async () => {
  let releaseA;
  let bCompleted = false;
  const aBlocked = new Promise(resolve => { releaseA = resolve; });

  const taskA = withBlockWriteLease("box-1", "block-a", undefined, async () => {
    await aBlocked;
  });
  const taskB = withBlockWriteLease("box-1", "block-b", undefined, async () => {
    bCompleted = true;
  });

  await taskB;
  assert.equal(bCompleted, true);
  releaseA();
  await taskA;
});

test("withBlockWriteLease rejects immediately if signal is already aborted", async () => {
  const controller = new AbortController();
  controller.abort();
  let executed = false;

  await assert.rejects(
    withBlockWriteLease("box-1", "block-1", controller.signal, async () => {
      executed = true;
    }),
    error => error.name === "AbortError",
  );
  assert.equal(executed, false);
});

test("withBlockWriteLease aborts queued waiter without breaking active exclusion or subsequent waiters", async () => {
  const order = [];
  let releaseFirst;
  let markFirstStarted;
  const firstStarted = new Promise(resolve => { markFirstStarted = resolve; });
  const firstBlocked = new Promise(resolve => { releaseFirst = resolve; });

  const first = withBlockWriteLease("box-2", "block-1", undefined, async () => {
    order.push("first:start");
    markFirstStarted();
    await firstBlocked;
    order.push("first:end");
    return 1;
  });

  await firstStarted;

  const waiterController = new AbortController();
  const abortedWaiter = withBlockWriteLease("box-2", "block-1", waiterController.signal, async () => {
    order.push("aborted:should-not-run");
    return 2;
  });

  const third = withBlockWriteLease("box-2", "block-1", undefined, async () => {
    order.push("third");
    return 3;
  });

  waiterController.abort();
  await assert.rejects(abortedWaiter, error => error.name === "AbortError");
  assert.deepEqual(order, ["first:start"]);

  // A fourth caller arriving while first is still active must still wait behind first
  const fourth = withBlockWriteLease("box-2", "block-1", undefined, async () => {
    order.push("fourth");
    return 4;
  });
  await Promise.resolve();
  await Promise.resolve();
  assert.deepEqual(order, ["first:start"]);

  releaseFirst();
  assert.equal(await first, 1);
  assert.equal(await third, 3);
  assert.equal(await fourth, 4);
  assert.deepEqual(order, ["first:start", "first:end", "third", "fourth"]);
});

test("withBlockWriteLease cleans up after a failing operation so subsequent callers proceed", async () => {
  await assert.rejects(
    withBlockWriteLease("box-3", "block-1", undefined, async () => {
      throw new Error("boom");
    }),
    /boom/,
  );

  const next = await withBlockWriteLease("box-3", "block-1", undefined, async () => "ok");
  assert.equal(next, "ok");
});
