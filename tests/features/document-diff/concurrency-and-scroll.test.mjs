import { test } from "node:test";
import assert from "node:assert/strict";
import { linkedY, monotoneAnchors } from "../../../src/features/document-diff/model/anchors.ts";
import { ComputeCoordinator } from "../../../src/features/document-diff/runtime/ComputeCoordinator.ts";
import { DirtyGate } from "../../../src/features/document-diff/runtime/DirtyGate.ts";
import { ScrollSync } from "../../../src/features/document-diff/runtime/ScrollSync.ts";

test("DirtyGate prevents older snapshots from certifying newer edits and swaps cleanly", () => {
  const gate = new DirtyGate();
  assert.equal(gate.pending, false);

  const rev1 = gate.edit("left");
  assert.equal(gate.pending, true);
  const captured = gate.capture();
  assert.equal(captured.left, rev1);

  // User types again while snapshot for rev1 is still in flight
  const rev2 = gate.edit("left");
  gate.acknowledge("left", captured.left, true);
  assert.equal(gate.pending, true);

  // Failed parity check does not clear pending
  gate.acknowledge("left", rev2, false);
  assert.equal(gate.pending, true);

  // Verified parity check for latest revision clears pending
  gate.acknowledge("left", rev2, true);
  assert.equal(gate.pending, false);

  // Swap preserves dirty side ownership
  gate.edit("right");
  assert.equal(gate.isSidePending("right"), true);
  gate.swapSides();
  assert.equal(gate.isSidePending("left"), true);
  assert.equal(gate.isSidePending("right"), false);
});

test("ComputeCoordinator suspends while either side is in IME composition and drops stale results", async () => {
  const published = [];
  const resolvers = [];
  let clock = 1000;

  const coord = new ComputeCoordinator(
    signal =>
      new Promise((resolve, reject) => {
        signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
        resolvers.push(resolve);
      }),
    value => published.push(value),
    () => {},
    15,
    () => clock,
  );

  // Both sides start IME; left ends first -> still suspended until right ends
  coord.compositionStart("left");
  coord.compositionStart("right");
  coord.compositionEnd("left");
  await new Promise(r => setTimeout(r, 30));
  assert.equal(resolvers.length, 0);

  coord.compositionEnd("right");
  await new Promise(r => setTimeout(r, 30));
  assert.equal(resolvers.length, 1);

  // Trigger a newer immediate request before first resolves -> first must be ignored
  const firstResolve = resolvers[0];
  coord.immediate();
  assert.equal(resolvers.length, 2);
  firstResolve("stale");
  resolvers[1]("fresh");
  await new Promise(r => setTimeout(r, 10));

  assert.deepEqual(published, ["fresh"]);
  coord.dispose();
});

test("monotoneAnchors uses LIS to retain valid chain past a moved block and ScrollSync honors user preemption", () => {
  const raw = [
    { leftY: 0, rightY: 0 },
    { leftY: 100, rightY: 900 }, // One moved block jumping down
    { leftY: 200, rightY: 250 },
    { leftY: 400, rightY: 500 },
    { leftY: 600, rightY: 750 },
  ];
  const chain = monotoneAnchors(raw);
  assert.deepEqual(chain, [
    { leftY: 0, rightY: 0 },
    { leftY: 200, rightY: 250 },
    { leftY: 400, rightY: 500 },
    { leftY: 600, rightY: 750 },
  ]);
  assert.equal(linkedY(300, chain, "left"), 375);

  function createMockScroller(height = 2000, clientHeight = 400) {
    const map = new Map();
    return {
      scrollTop: 0,
      scrollHeight: height,
      clientHeight,
      addEventListener(type, fn) {
        if (!map.has(type)) map.set(type, new Set());
        map.get(type).add(fn);
      },
      removeEventListener(type, fn) {
        map.get(type)?.delete(fn);
      },
      emit(type, extra = {}) {
        const evt = Object.assign(new Event(type), extra);
        for (const fn of map.get(type) ?? []) fn(evt);
      },
    };
  }

  let now = 100;
  const left = createMockScroller();
  const right = createMockScroller();
  const sync = new ScrollSync(left, right, () => chain, () => now);

  // Left user scroll updates right.scrollTop; right's programmatic scroll echo does not bounce back
  left.scrollTop = 200;
  left.emit("scroll");
  const expectedRightTop = right.scrollTop;
  assert.ok(expectedRightTop > 200);

  const prevLeftTop = left.scrollTop;
  right.emit("scroll"); // programmatic echo
  assert.equal(left.scrollTop, prevLeftTop);

  // Immediate user wheel gesture on right preempts suppression window and syncs back to left
  right.emit("wheel");
  right.scrollTop = 500;
  right.emit("scroll");
  assert.ok(left.scrollTop > 300);

  // Verify `onUnmappedScroll`, `onBeforeApplyScroll`, and `applyProgrammaticScroll` when anchors are empty
  let unmappedCalls = 0;
  let beforeApplyCalls = 0;
  const fallbackLeft = createMockScroller(4000, 400);
  const fallbackRight = createMockScroller(4000, 400);
  const fallbackSync = new ScrollSync(
    fallbackLeft,
    fallbackRight,
    () => [],
    () => now,
    {
      onUnmappedScroll(fromSide, readingY) {
        unmappedCalls++;
        assert.equal(fromSide, "left");
        return readingY + 300;
      },
      onBeforeApplyScroll(_targetSide, targetTop) {
        beforeApplyCalls++;
        return targetTop;
      },
    },
  );
  fallbackLeft.scrollTop = 600;
  fallbackLeft.emit("scroll");
  assert.equal(unmappedCalls, 1);
  assert.equal(beforeApplyCalls, 1);
  assert.equal(fallbackRight.scrollTop, 900);

  // Programmatic scroll application suppresses echo on target side, while non-scroll keydown (e.g. Ctrl+C) does NOT break echo guard
  fallbackSync.applyProgrammaticScroll("left", 1200, "right");
  assert.equal(fallbackLeft.scrollTop, 1200);
  const rightBeforeEcho = fallbackRight.scrollTop;
  fallbackLeft.emit("keydown", { key: "Control" });
  fallbackLeft.emit("scroll");
  assert.equal(fallbackRight.scrollTop, rightBeforeEcho);

  // `suppressEcho` guards against host-induced scrollTop adjustment (e.g. CB_GET_BEFORE height compensation)
  fallbackSync.suppressEcho("right");
  fallbackRight.emit("scroll");
  assert.equal(fallbackLeft.scrollTop, 1200);

  fallbackSync.dispose();
  sync.dispose();
});
