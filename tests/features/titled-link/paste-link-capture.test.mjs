import { test } from "node:test";
import assert from "node:assert/strict";
import { FeatureScope } from "../../../src/core/framework/FeatureScope.ts";
import {
  alignCollapsedPasteBoundary,
  collectCandidateLinksInRange,
  collectPrePasteLinks,
  createRangeFromResolved,
  hasClipboardLinkCandidate,
  isAutomaticLinkCandidate,
  isNodeFullyInsideRange,
  isSingleBareURL,
} from "../../../src/features/titled-link/policy/paste-range.ts";
import { PasteLinkCapture } from "../../../src/features/titled-link/services/PasteLinkCapture.ts";

class MockNode {
  constructor(nodeType, ownerDocument) {
    this.nodeType = nodeType;
    this.ownerDocument = ownerDocument;
    this.parentNode = null;
    this.childNodes = [];
  }
  get parentElement() {
    return this.parentNode && this.parentNode.nodeType === 1 ? this.parentNode : null;
  }
  get isConnected() {
    let cur = this;
    while (cur.parentNode) cur = cur.parentNode;
    return cur === this.ownerDocument?.body || cur === this.ownerDocument;
  }
  contains(node) {
    let cur = node;
    while (cur) {
      if (cur === this) return true;
      cur = cur.parentNode;
    }
    return false;
  }
  appendChild(child) {
    child.parentNode = this;
    this.childNodes.push(child);
    return child;
  }
}

class MockText extends MockNode {
  constructor(data, ownerDocument) {
    super(3, ownerDocument);
    this.textContent = data;
  }
  get length() {
    return this.textContent.length;
  }
}

class MockElement extends MockNode {
  constructor(tagName, ownerDocument, attrs = {}) {
    super(1, ownerDocument);
    this.tagName = tagName.toUpperCase();
    this.attributes = new Map(Object.entries(attrs));
    this.listeners = [];
  }
  getAttribute(name) {
    return this.attributes.has(name) ? this.attributes.get(name) : null;
  }
  setAttribute(name, value) {
    this.attributes.set(name, String(value));
  }
  get textContent() {
    return this.childNodes.map(c => c.textContent ?? "").join("");
  }
  set textContent(value) {
    this.childNodes = value ? [new MockText(String(value), this.ownerDocument)] : [];
    for (const c of this.childNodes) c.parentNode = this;
  }
  matches(selector) {
    if (selector === 'span[data-type~="a"]') {
      const types = (this.getAttribute("data-type") ?? "").split(/\s+/).filter(Boolean);
      return this.tagName === "SPAN" && types.includes("a");
    }
    const classes = (this.getAttribute("class") ?? "").split(/\s+/).filter(Boolean);
    return selector.split(",").map(s => s.trim()).some(part => {
      if (!part) return false;
      if (part.startsWith(".")) return classes.includes(part.slice(1));
      const exactAttr = part.match(/^\[([a-zA-Z0-9_-]+)="([^"]*)"\]$/);
      if (exactAttr) return this.getAttribute(exactAttr[1]) === exactAttr[2];
      const bareAttr = part.match(/^\[([a-zA-Z0-9_-]+)\]$/);
      if (bareAttr) return this.attributes.has(bareAttr[1]);
      return this.tagName === part.toUpperCase();
    });
  }
  closest(selector) {
    let cur = this;
    while (cur) {
      if (cur.nodeType === 1 && cur.matches(selector)) return cur;
      cur = cur.parentNode;
    }
    return null;
  }
  querySelectorAll(selector) {
    const out = [];
    const walk = node => {
      for (const child of node.childNodes) {
        if (child.nodeType === 1) {
          if (child.matches(selector)) out.push(child);
          walk(child);
        }
      }
    };
    walk(this);
    return out;
  }
  addEventListener(type, fn, opts) {
    this.listeners.push({ type, fn, opts });
  }
  removeEventListener(type, fn, opts) {
    const idx = this.listeners.findIndex(l => l.type === type && l.fn === fn && Boolean(l.opts?.capture) === Boolean(opts?.capture));
    if (idx >= 0) this.listeners.splice(idx, 1);
  }
  dispatchCapture(type, event) {
    for (const entry of [...this.listeners]) {
      if (entry.type === type && entry.opts?.capture === true) {
        entry.fn(event);
      }
    }
  }
}

function comparePoints(aNode, aOffset, bNode, bOffset) {
  if (aNode === bNode) return aOffset - bOffset;
  const pathOf = node => {
    const path = [];
    let cur = node;
    while (cur) {
      path.unshift(cur);
      cur = cur.parentNode;
    }
    return path;
  };
  const pathA = pathOf(aNode);
  const pathB = pathOf(bNode);
  const minLen = Math.min(pathA.length, pathB.length);
  let lcaIdx = 0;
  for (let i = 0; i < minLen; i++) {
    if (pathA[i] === pathB[i]) lcaIdx = i;
    else break;
  }
  const lca = pathA[lcaIdx];
  const posInLca = (path, idx, offset) => {
    if (idx === path.length - 1) return [offset, 0];
    const child = path[idx + 1];
    return [lca.childNodes.indexOf(child) + 0.5, 1];
  };
  const [pA] = posInLca(pathA, lcaIdx, aOffset);
  const [pB] = posInLca(pathB, lcaIdx, bOffset);
  if (pA !== pB) return pA < pB ? -1 : 1;
  // Same subtree child: deeper node is inside the child at index, compare offsets
  return pathA.length < pathB.length ? -1 : 1;
}

class MockRange {
  constructor() {
    this.startContainer = null;
    this.startOffset = 0;
    this.endContainer = null;
    this.endOffset = 0;
  }
  setStart(node, offset) {
    this.startContainer = node;
    this.startOffset = offset;
  }
  setEnd(node, offset) {
    this.endContainer = node;
    this.endOffset = offset;
  }
  setStartBefore(node) {
    const parent = node.parentNode;
    this.setStart(parent, parent.childNodes.indexOf(node));
  }
  setEndAfter(node) {
    const parent = node.parentNode;
    this.setEnd(parent, parent.childNodes.indexOf(node) + 1);
  }
  collapse(toStart) {
    if (toStart) {
      this.endContainer = this.startContainer;
      this.endOffset = this.startOffset;
    } else {
      this.startContainer = this.endContainer;
      this.startOffset = this.endOffset;
    }
  }
  get collapsed() {
    return this.startContainer === this.endContainer && this.startOffset === this.endOffset;
  }
  get commonAncestorContainer() {
    const ancestors = new Set();
    let cur = this.startContainer;
    while (cur) {
      ancestors.add(cur);
      cur = cur.parentNode;
    }
    cur = this.endContainer;
    while (cur) {
      if (ancestors.has(cur)) return cur;
      cur = cur.parentNode;
    }
    return this.startContainer;
  }
  selectNode(node) {
    const parent = node.parentNode;
    const index = parent.childNodes.indexOf(node);
    this.startContainer = parent;
    this.startOffset = index;
    this.endContainer = parent;
    this.endOffset = index + 1;
  }
  cloneRange() {
    const copy = new MockRange();
    copy.startContainer = this.startContainer;
    copy.startOffset = this.startOffset;
    copy.endContainer = this.endContainer;
    copy.endOffset = this.endOffset;
    return copy;
  }
  compareBoundaryPoints(how, sourceRange) {
    // 0: START_TO_START, 1: START_TO_END (this.end vs source.start), 2: END_TO_END
    if (how === 0) return comparePoints(this.startContainer, this.startOffset, sourceRange.startContainer, sourceRange.startOffset);
    if (how === 1) return comparePoints(this.endContainer, this.endOffset, sourceRange.startContainer, sourceRange.startOffset);
    if (how === 2) return comparePoints(this.endContainer, this.endOffset, sourceRange.endContainer, sourceRange.endOffset);
    return comparePoints(this.startContainer, this.startOffset, sourceRange.endContainer, sourceRange.endOffset);
  }
}

function createMockDocument() {
  const doc = {
    body: null,
    createRange: () => new MockRange(),
  };
  doc.body = new MockElement("body", doc);
  return doc;
}

function createSelection(range) {
  return {
    rangeCount: range ? 1 : 0,
    isCollapsed: range ? range.collapsed : true,
    getRangeAt: () => range,
  };
}

function createClipboardEvent(textPlain = "", textHtml = "") {
  return {
    clipboardData: {
      getData: type => (type === "text/plain" ? textPlain : type === "text/html" ? textHtml : ""),
    },
  };
}

test("paste-range helpers filter URLs, validate resolved endpoints, and enforce full node containment", () => {
  assert.equal(isSingleBareURL("  https://example.com/a  "), true);
  assert.equal(isSingleBareURL("https://a.com https://b.com"), false);
  assert.equal(isSingleBareURL("hello"), false);
  assert.equal(hasClipboardLinkCandidate("visit https://a.com", ""), true);
  assert.equal(hasClipboardLinkCandidate("", '<a href="https://a.com">link</a>'), true);
  assert.equal(hasClipboardLinkCandidate("plain text", "<b>plain</b>"), false);

  const doc = createMockDocument();
  const editor = new MockElement("div", doc);
  doc.body.appendChild(editor);
  const block = new MockElement("div", doc, { "data-node-id": "b1" });
  editor.appendChild(block);
  const beforeText = new MockText("before ", doc);
  const link = new MockElement("span", doc, { "data-type": "a", "data-href": "https://a.com" });
  link.textContent = "https://a.com";
  const afterText = new MockText(" after", doc);
  block.appendChild(beforeText);
  block.appendChild(link);
  block.appendChild(afterText);

  // Valid endpoints wrapping `link`
  const start = new MockRange();
  start.setStart(beforeText, 7);
  start.collapse(true);
  const end = new MockRange();
  end.setStart(afterText, 0);
  end.collapse(true);

  const built = createRangeFromResolved(editor, start, end);
  assert.ok(built);
  assert.equal(isNodeFullyInsideRange(link, built), true);

  // Partial overlap (range starts inside link text) must NOT be considered fully inside
  const insideStart = new MockRange();
  insideStart.setStart(link.childNodes[0], 2);
  insideStart.collapse(true);
  const partial = createRangeFromResolved(editor, insideStart, end);
  assert.ok(partial);
  assert.equal(isNodeFullyInsideRange(link, partial), false);

  // Out-of-bounds offset or inverted order or outside editor returns null
  const invalidOffset = new MockRange();
  invalidOffset.setStart(beforeText, 99);
  invalidOffset.collapse(true);
  assert.equal(createRangeFromResolved(editor, invalidOffset, end), null);
  assert.equal(createRangeFromResolved(editor, end, start), null);
  assert.equal(createRangeFromResolved(editor, start, start), null);

  const outside = new MockElement("div", doc);
  const outsideText = new MockText("x", doc);
  outside.appendChild(outsideText);
  const outsideRange = new MockRange();
  outsideRange.setStart(outsideText, 0);
  outsideRange.collapse(true);
  assert.equal(createRangeFromResolved(editor, outsideRange, end), null);
});

test("PasteLinkCapture skips non-collapsed selection with single bare URL before allocating trackRange or MutationObserver", () => {
  const prevGetSelection = globalThis.getSelection;
  try {
    const doc = createMockDocument();
    const editor = new MockElement("div", doc);
    doc.body.appendChild(editor);
    const block = new MockElement("div", doc, { "data-node-id": "b1" });
    const text = new MockText("selected words", doc);
    block.appendChild(text);
    editor.appendChild(block);

    const selRange = new MockRange();
    selRange.setStart(text, 0);
    selRange.setEnd(text, 8);
    globalThis.getSelection = () => createSelection(selRange);

    let trackRangeCalls = 0;
    let observerCalls = 0;
    const scope = new FeatureScope();
    const capture = new PasteLinkCapture({
      plugin: {},
      scope,
      isEnabled: () => true,
      onLinksCaptured: () => {},
      MutationObserver: class {
        constructor() { observerCalls += 1; }
        observe() {}
        disconnect() {}
      },
    });

    const protyle = {
      wysiwyg: { element: editor },
      trackRange() { trackRangeCalls += 1; return { id: "h" }; },
      resolveTrackedRange() { return { status: "invalid" }; },
      releaseTrackedRange() {},
    };
    capture.attach(protyle);

    // Even when text/html carries <a>, single bare URL in text/plain with non-collapsed selection skips immediately
    editor.dispatchCapture("paste", createClipboardEvent(
      "https://example.com/anchor",
      '<a href="https://example.com/anchor">https://example.com/anchor</a>',
    ));
    assert.equal(trackRangeCalls, 0);
    assert.equal(observerCalls, 0);
    scope.dispose();
  } finally {
    globalThis.getSelection = prevGetSelection;
  }
});

test("PasteLinkCapture handles multi-link paste, excludes pre-paste links in block, ignores unrelated plain-text paste, and releases handles", async () => {
  const prevGetSelection = globalThis.getSelection;
  const prevRange = globalThis.Range;
  try {
    globalThis.Range = { START_TO_START: 0, START_TO_END: 1, END_TO_END: 2 };
    const doc = createMockDocument();
    const editor = new MockElement("div", doc);
    doc.body.appendChild(editor);
    const block = new MockElement("div", doc, { "data-node-id": "b1" });
    editor.appendChild(block);

    const existingSameUrl = new MockElement("span", doc, { "data-type": "a", "data-href": "https://example.com/one" });
    existingSameUrl.textContent = "https://example.com/one";
    const beforeText = new MockText(" ", doc);
    const afterText = new MockText(" tail", doc);
    block.appendChild(existingSameUrl);
    block.appendChild(beforeText);
    block.appendChild(afterText);

    const cursor = new MockRange();
    cursor.setStart(beforeText, 1);
    cursor.collapse(true);
    globalThis.getSelection = () => createSelection(cursor);

    const tracked = new Map();
    const released = [];
    let handleSeq = 0;
    let observerCallback;
    let observerDisconnected = 0;
    let flushCalls = 0;
    const timers = new Map();
    const clearedTimers = [];
    let nextTimerId = 1;
    const capturedBatches = [];

    const scope = new FeatureScope();
    const capture = new PasteLinkCapture({
      plugin: { name: "omnikit" },
      scope,
      isEnabled: () => true,
      onLinksCaptured: (links, protyle) => { capturedBatches.push({ links, protyle }); },
      quietMs: 50,
      deadlineMs: 30_000,
      setTimer: fn => {
        const id = nextTimerId++;
        timers.set(id, fn);
        return id;
      },
      clearTimer: id => {
        clearedTimers.push(id);
        timers.delete(id);
      },
      MutationObserver: class {
        constructor(cb) { observerCallback = cb; }
        observe() {}
        disconnect() { observerDisconnected += 1; }
      },
    });

    const protyle = {
      wysiwyg: { element: editor },
      trackRange(range, options) {
        const handle = { id: `h-${++handleSeq}`, affinity: options.affinity };
        tracked.set(handle, range.cloneRange());
        return handle;
      },
      resolveTrackedRange(handle) {
        const range = tracked.get(handle);
        return range ? { status: "resolved", range } : { status: "invalid" };
      },
      releaseTrackedRange(handle) {
        if (tracked.delete(handle)) released.push(handle.id);
      },
      async flushPendingTransactions() {
        flushCalls += 1;
      },
    };
    capture.attach(protyle);

    // 1. Trigger HTML multi-link paste
    editor.dispatchCapture("paste", createClipboardEvent(
      "https://example.com/one https://example.com/two",
      '<a href="https://example.com/one">https://example.com/one</a> <a href="https://example.com/two">https://example.com/two</a> <a href="https://example.com/titled">Custom</a>',
    ));
    assert.equal(tracked.size, 2);

    // 2. Subsequent plain-text paste must NOT cancel the pending URL paste capture
    editor.dispatchCapture("paste", createClipboardEvent("plain words", "<span>plain words</span>"));
    assert.equal(tracked.size, 2);
    assert.equal(observerDisconnected, 0);

    // 3. Simulate SiYuan inserting new links + titled link + code-block link between start & end handles
    const pastedOne = new MockElement("span", doc, { "data-type": "a", "data-href": "https://example.com/one" });
    pastedOne.textContent = "https://example.com/one";
    const space = new MockText(" ", doc);
    const pastedTwo = new MockElement("span", doc, { "data-type": "a", "data-href": "https://example.com/two" });
    pastedTwo.textContent = "https://example.com/two";
    const pastedTitled = new MockElement("span", doc, { "data-type": "a", "data-href": "https://example.com/titled" });
    pastedTitled.textContent = "Custom";
    const code = new MockElement("code", doc);
    const codeLink = new MockElement("span", doc, { "data-type": "a", "data-href": "https://example.com/code" });
    codeLink.textContent = "https://example.com/code";
    code.appendChild(codeLink);

    block.childNodes = [existingSameUrl, beforeText, pastedOne, space, pastedTwo, pastedTitled, code, afterText];
    for (const child of block.childNodes) child.parentNode = block;
    // Update end handle to sit after inserted nodes (at start of afterText)
    const endHandle = [...tracked.keys()][1];
    const endRange = new MockRange();
    endRange.setStart(afterText, 0);
    endRange.collapse(true);
    tracked.set(endHandle, endRange);

    observerCallback();
    // Fire quiet timer
    const quietTimerId = [...timers.keys()].at(-1);
    await timers.get(quietTimerId)();

    assert.equal(flushCalls, 1);
    assert.equal(capturedBatches.length, 1);
    assert.deepEqual(capturedBatches[0].links, [pastedOne, pastedTwo]);
    assert.equal(observerDisconnected, 1);
    assert.deepEqual(released.sort(), ["h-1", "h-2"]);
    assert.equal(tracked.size, 0);
    assert.ok(clearedTimers.length >= 1);
    scope.dispose();
  } finally {
    globalThis.getSelection = prevGetSelection;
    globalThis.Range = prevRange;
  }
});

test("PasteLinkCapture immediately finishes with no-candidate when non-uploading DOM settles without eligible links, and waits while uploading", async () => {
  const prevGetSelection = globalThis.getSelection;
  const prevRange = globalThis.Range;
  try {
    globalThis.Range = { START_TO_START: 0, START_TO_END: 1, END_TO_END: 2 };
    const doc = createMockDocument();
    const editor = new MockElement("div", doc);
    doc.body.appendChild(editor);
    const block = new MockElement("div", doc, { "data-node-id": "b1" });
    const text = new MockText("abc", doc);
    block.appendChild(text);
    editor.appendChild(block);

    const cursor = new MockRange();
    cursor.setStart(text, 3);
    cursor.collapse(true);
    globalThis.getSelection = () => createSelection(cursor);

    const tracked = new Map();
    const timers = new Map();
    let nextTimerId = 1;
    let observerCallback;
    let observerDisconnected = 0;
    let uploading = false;

    const scope = new FeatureScope();
    const capture = new PasteLinkCapture({
      plugin: {},
      scope,
      isEnabled: () => true,
      onLinksCaptured: () => {},
      setTimer: (fn, ms) => {
        const id = nextTimerId++;
        timers.set(id, { fn, ms });
        return id;
      },
      clearTimer: id => { timers.delete(id); },
      MutationObserver: class {
        constructor(cb) { observerCallback = cb; }
        observe() {}
        disconnect() { observerDisconnected += 1; }
      },
    });

    let seq = 0;
    let flushCalls = 0;
    const protyle = {
      wysiwyg: { element: editor },
      isUploading: () => uploading,
      async flushPendingTransactions() {
        flushCalls += 1;
      },
      trackRange(range) {
        const handle = { id: ++seq };
        tracked.set(handle, range.cloneRange());
        return handle;
      },
      resolveTrackedRange: handle => ({ status: "resolved", range: tracked.get(handle) }),
      releaseTrackedRange: handle => { tracked.delete(handle); },
    };
    capture.attach(protyle);

    const fireQuietTimer = async () => {
      const entry = [...timers.entries()].find(([, t]) => t.ms < 30_000);
      assert.ok(entry, "expected quiet timer to be scheduled");
      timers.delete(entry[0]);
      await entry[1].fn();
      return entry[1].ms;
    };

    // Case 1: Paste URL text that SiYuan does not auto-convert (plain text inserted, !range.collapsed, !links.length, not uploading)
    editor.dispatchCapture("paste", createClipboardEvent("https://example.com/plain", ""));
    assert.equal(tracked.size, 2);
    const inserted = new MockText("https://example.com/plain", doc);
    block.appendChild(inserted);
    const endHandle1 = [...tracked.keys()][1];
    const endRange1 = new MockRange();
    endRange1.setStart(inserted, inserted.length);
    endRange1.collapse(true);
    tracked.set(endHandle1, endRange1);

    observerCallback();
    await fireQuietTimer();
    assert.equal(flushCalls, 0, "no-candidate must not invoke flushPendingTransactions");
    assert.equal(tracked.size, 0);
    assert.equal(observerDisconnected, 1);
    assert.equal(timers.size, 0, "deadlineTimer must be cleared immediately on no-candidate");

    // Case 2: While uploading, !links.length keeps capture alive at 500ms without flushing until upload completes
    uploading = true;
    editor.dispatchCapture("paste", createClipboardEvent("https://example.com/uploading", '<img src="a.png">'));
    assert.equal(tracked.size, 2);
    const placeholder = new MockText("uploading", doc);
    block.appendChild(placeholder);
    const endHandle2 = [...tracked.keys()][1];
    const endRange2 = new MockRange();
    endRange2.setStart(placeholder, placeholder.length);
    endRange2.collapse(true);
    tracked.set(endHandle2, endRange2);

    observerCallback();
    await fireQuietTimer();
    assert.equal(flushCalls, 0, "must not flushPendingTransactions while uploading");
    assert.equal(tracked.size, 2, "must not release early while upload is active");
    const busyTimer = [...timers.values()].find(t => t.ms < 30_000);
    assert.equal(busyTimer?.ms, 500, "uploading recheck must use 500ms backoff");

    // Upload finishes with no candidate links -> next quiet check finishes cleanly with zero flush
    uploading = false;
    await fireQuietTimer();
    assert.equal(flushCalls, 0);
    assert.equal(tracked.size, 0);
    assert.equal(timers.size, 0);
    scope.dispose();
  } finally {
    globalThis.getSelection = prevGetSelection;
    globalThis.Range = prevRange;
  }
});

test("PasteLinkCapture handles trackRange failure and destroy/dispose cleanup idempotently", () => {
  const prevGetSelection = globalThis.getSelection;
  try {
    const doc = createMockDocument();
    const editor = new MockElement("div", doc);
    doc.body.appendChild(editor);
    const block = new MockElement("div", doc, { "data-node-id": "b1" });
    const text = new MockText("abc", doc);
    block.appendChild(text);
    editor.appendChild(block);

    const cursor = new MockRange();
    cursor.setStart(text, 0);
    cursor.collapse(true);
    globalThis.getSelection = () => createSelection(cursor);

    const released = [];
    let callCount = 0;
    const scope = new FeatureScope();
    const capture = new PasteLinkCapture({
      plugin: {},
      scope,
      isEnabled: () => true,
      onLinksCaptured: () => {},
      MutationObserver: class {
        observe() {}
        disconnect() {}
      },
    });

    const protyle = {
      wysiwyg: { element: editor },
      trackRange() {
        callCount += 1;
        if (callCount === 2) throw new Error("host rejected end boundary");
        return { id: `handle-${callCount}` };
      },
      resolveTrackedRange() { return { status: "invalid" }; },
      releaseTrackedRange(handle) { released.push(handle.id); },
    };
    capture.attach(protyle);
    editor.dispatchCapture("paste", createClipboardEvent("https://example.com", ""));
    assert.deepEqual(released, ["handle-1"]);

    // Now succeed on trackRange and verify detach cleans up handles idempotently
    callCount = 0;
    protyle.trackRange = () => ({ id: `handle-${++callCount}` });
    editor.dispatchCapture("paste", createClipboardEvent("https://example.com/2", ""));
    capture.detach(protyle);
    capture.detach(protyle);
    assert.deepEqual(released, ["handle-1", "handle-1", "handle-2"]);
    scope.dispose();
  } finally {
    globalThis.getSelection = prevGetSelection;
  }
});

test("PasteLinkCapture skips flush during IME composition and immediately releases handles on empty/collapsed range with zero flush", async () => {
  const prevGetSelection = globalThis.getSelection;
  const prevRange = globalThis.Range;
  try {
    globalThis.Range = { START_TO_START: 0, START_TO_END: 1, END_TO_END: 2 };
    const doc = createMockDocument();
    const editor = new MockElement("div", doc);
    doc.body.appendChild(editor);
    const block = new MockElement("div", doc, { "data-node-id": "b1" });
    const text = new MockText("before ", doc);
    const tail = new MockText(" after", doc);
    block.appendChild(text);
    block.appendChild(tail);
    editor.appendChild(block);

    const cursor = new MockRange();
    cursor.setStart(text, text.length);
    cursor.collapse(true);
    globalThis.getSelection = () => createSelection(cursor);

    const tracked = new Map();
    const timers = new Map();
    let nextTimerId = 1;
    let observerCallback;
    let observerDisconnected = 0;
    let flushCalls = 0;
    let composing = true;
    const captured = [];

    const scope = new FeatureScope();
    const capture = new PasteLinkCapture({
      plugin: {},
      scope,
      isEnabled: () => true,
      isComposing: () => composing,
      onLinksCaptured: links => { captured.push(links); },
      setTimer: (fn, ms) => {
        const id = nextTimerId++;
        timers.set(id, { fn, ms });
        return id;
      },
      clearTimer: id => { timers.delete(id); },
      MutationObserver: class {
        constructor(cb) { observerCallback = cb; }
        observe() {}
        disconnect() { observerDisconnected += 1; }
      },
    });

    let seq = 0;
    const protyle = {
      wysiwyg: { element: editor },
      async flushPendingTransactions() { flushCalls += 1; },
      trackRange(range) {
        const handle = { id: ++seq };
        tracked.set(handle, range.cloneRange());
        return handle;
      },
      resolveTrackedRange: handle => ({ status: "resolved", range: tracked.get(handle) }),
      releaseTrackedRange: handle => { tracked.delete(handle); },
    };
    capture.attach(protyle);

    const fireQuietTimer = async () => {
      const entry = [...timers.entries()].find(([, t]) => t.ms < 30_000);
      assert.ok(entry, "expected quiet timer");
      timers.delete(entry[0]);
      await entry[1].fn();
      return entry[1].ms;
    };

    // Case 1: IME composing delays evaluation at 500ms without flushing, then flushes once after IME ends
    editor.dispatchCapture("paste", createClipboardEvent("https://example.com/ime", ""));
    const pasted = new MockElement("span", doc, { "data-type": "a", "data-href": "https://example.com/ime" });
    pasted.textContent = "https://example.com/ime";
    block.childNodes = [text, pasted, tail];
    for (const c of block.childNodes) c.parentNode = block;
    const endHandle = [...tracked.keys()][1];
    const endRange = new MockRange();
    endRange.setStart(tail, 0);
    endRange.collapse(true);
    tracked.set(endHandle, endRange);

    observerCallback();
    await fireQuietTimer();
    assert.equal(flushCalls, 0, "must not flush while IME is composing");
    assert.equal(captured.length, 0);
    assert.equal(tracked.size, 2);
    const recheckEntry = [...timers.values()].find(t => t.ms < 30_000);
    assert.equal(recheckEntry?.ms, 500);

    composing = false;
    await fireQuietTimer();
    assert.equal(flushCalls, 1);
    assert.equal(captured.length, 1);
    assert.deepEqual(captured[0], [pasted]);
    assert.equal(tracked.size, 0);
    assert.equal(timers.size, 0);

    // Case 2: Collapsed/empty range (!range) immediately finishes with empty-range, zero flush, and no 30s hang
    editor.dispatchCapture("paste", createClipboardEvent("https://example.com/ignored", ""));
    assert.equal(tracked.size, 2);
    // Start and end boundaries remain collapsed at the same point -> createRangeFromResolved returns null
    observerCallback();
    await fireQuietTimer();
    assert.equal(flushCalls, 1, "empty-range must not invoke flushPendingTransactions");
    assert.equal(tracked.size, 0, "empty-range must release trackRange handles immediately");
    assert.equal(observerDisconnected, 2, "empty-range must disconnect MutationObserver immediately");
    assert.equal(timers.size, 0, "empty-range must clear 30s deadlineTimer immediately");
    scope.dispose();
  } finally {
    globalThis.getSelection = prevGetSelection;
    globalThis.Range = prevRange;
  }
});

test("C-BUG-01 & C-BUG-02: PasteLinkCapture skips read-only editors/blocks and .av / NodeAttributeView containers without allocating trackRange", () => {
  const prevGetSelection = globalThis.getSelection;
  try {
    const doc = createMockDocument();
    const editor = new MockElement("div", doc, { contenteditable: "true" });
    doc.body.appendChild(editor);

    const lockedBlock = new MockElement("div", doc, { "data-node-id": "b-ro", contenteditable: "false" });
    const lockedText = new MockText("locked", doc);
    lockedBlock.appendChild(lockedText);

    const avBlock = new MockElement("div", doc, { "data-node-id": "b-av", "data-type": "NodeAttributeView", class: "av" });
    const avText = new MockText("cell", doc);
    avBlock.appendChild(avText);

    const normalBlock = new MockElement("div", doc, { "data-node-id": "b-ok", contenteditable: "true" });
    const normalText = new MockText("ok", doc);
    normalBlock.appendChild(normalText);

    editor.appendChild(lockedBlock);
    editor.appendChild(avBlock);
    editor.appendChild(normalBlock);

    let activeRange = new MockRange();
    globalThis.getSelection = () => createSelection(activeRange);

    let trackRangeCalls = 0;
    const scope = new FeatureScope();
    const capture = new PasteLinkCapture({
      plugin: {},
      scope,
      isEnabled: () => true,
      onLinksCaptured: () => {},
      MutationObserver: class { observe() {} disconnect() {} },
    });

    const protyle = {
      disabled: true,
      wysiwyg: { element: editor },
      trackRange() { trackRangeCalls += 1; return { id: "h" }; },
      resolveTrackedRange() { return { status: "invalid" }; },
      releaseTrackedRange() {},
    };
    capture.attach(protyle);

    // 1. Editor disabled -> 0 trackRange calls
    activeRange.setStart(normalText, 0);
    activeRange.collapse(true);
    editor.dispatchCapture("paste", createClipboardEvent("https://example.com/1", ""));
    assert.equal(trackRangeCalls, 0);

    // 2. Editor enabled, caret inside contenteditable="false" block -> 0 trackRange calls
    protyle.disabled = false;
    activeRange = new MockRange();
    activeRange.setStart(lockedText, 0);
    activeRange.collapse(true);
    editor.dispatchCapture("paste", createClipboardEvent("https://example.com/2", ""));
    assert.equal(trackRangeCalls, 0);

    // 3. Caret inside .av / NodeAttributeView -> 0 trackRange calls
    activeRange = new MockRange();
    activeRange.setStart(avText, 0);
    activeRange.collapse(true);
    editor.dispatchCapture("paste", createClipboardEvent("https://example.com/3", ""));
    assert.equal(trackRangeCalls, 0);

    scope.dispose();
  } finally {
    globalThis.getSelection = prevGetSelection;
  }
});

test("C-BUG-04 & C-BUG-05: consecutive paste at inline SPAN[data-type] boundary aligns cloned range without touching live Selection, and percent-encoded bare URLs are captured", async () => {
  const prevGetSelection = globalThis.getSelection;
  const prevRange = globalThis.Range;
  try {
    globalThis.Range = { START_TO_START: 0, START_TO_END: 1, END_TO_END: 2 };
    const doc = createMockDocument();
    const editor = new MockElement("div", doc, { contenteditable: "true" });
    doc.body.appendChild(editor);
    const block = new MockElement("div", doc, { "data-node-id": "b-seq", contenteditable: "true" });
    editor.appendChild(block);

    const firstLink = new MockElement("span", doc, { "data-type": "a", "data-href": "https://example.com/first" });
    firstLink.textContent = "First Title";
    block.appendChild(firstLink);

    // Unit check: alignCollapsedPasteBoundary handles start/end of inline SPAN for both Text child and SPAN element without mutating original
    const firstText = firstLink.childNodes[0];
    const atEndText = new MockRange();
    atEndText.setStart(firstText, firstText.length);
    atEndText.collapse(true);
    const alignedEnd = alignCollapsedPasteBoundary(atEndText);
    assert.equal(atEndText.startContainer, firstText, "must not mutate original range");
    assert.equal(alignedEnd.startContainer, block);
    assert.equal(alignedEnd.startOffset, 1);
    assert.equal(alignedEnd.collapsed, true);

    const atStartSpan = new MockRange();
    atStartSpan.setStart(firstLink, 0);
    atStartSpan.collapse(true);
    const alignedStart = alignCollapsedPasteBoundary(atStartSpan);
    assert.equal(alignedStart.startContainer, block);
    assert.equal(alignedStart.startOffset, 0);
    assert.equal(alignedStart.collapsed, true);

    const atMiddle = new MockRange();
    atMiddle.setStart(firstText, 3);
    atMiddle.collapse(true);
    const alignedMid = alignCollapsedPasteBoundary(atMiddle);
    assert.equal(alignedMid.startContainer, firstText);
    assert.equal(alignedMid.startOffset, 3);

    // End-to-end PasteLinkCapture: caret stays collapsed at end of firstLink while pasting 2nd percent-encoded URL
    let liveSelectionMutated = false;
    const liveSelectionRange = atEndText;
    globalThis.getSelection = () => ({
      rangeCount: 1,
      isCollapsed: true,
      getRangeAt: () => liveSelectionRange,
      removeAllRanges() { liveSelectionMutated = true; },
      addRange() { liveSelectionMutated = true; },
    });

    const tracked = new Map();
    const timers = new Map();
    let nextTimerId = 1;
    let observerCallback;
    let seq = 0;
    const captured = [];
    const scope = new FeatureScope();
    const capture = new PasteLinkCapture({
      plugin: {},
      scope,
      isEnabled: () => true,
      onLinksCaptured: links => { captured.push(links); },
      setTimer: (fn, ms) => {
        const id = nextTimerId++;
        timers.set(id, { fn, ms });
        return id;
      },
      clearTimer: id => { timers.delete(id); },
      MutationObserver: class {
        constructor(cb) { observerCallback = cb; }
        observe() {}
        disconnect() {}
      },
    });

    const protyle = {
      wysiwyg: { element: editor },
      async flushPendingTransactions() {},
      trackRange(range) {
        const handle = { id: ++seq };
        tracked.set(handle, range.cloneRange());
        return handle;
      },
      resolveTrackedRange: handle => ({ status: "resolved", range: tracked.get(handle) }),
      releaseTrackedRange: handle => { tracked.delete(handle); },
    };
    capture.attach(protyle);

    const encodedHref = "https://example.com/docs/%E6%B5%8B%E8%AF%95%E6%89%8B%E5%86%8C.pdf";
    const decodedText = "https://example.com/docs/测试手册.pdf";
    assert.equal(isAutomaticLinkCandidate(decodedText, encodedHref), true);

    editor.dispatchCapture("paste", createClipboardEvent(encodedHref, ""));
    assert.equal(liveSelectionMutated, false, "PasteLinkCapture must never mutate live Selection");
    assert.equal(liveSelectionRange.startContainer, firstText, "live Selection range must remain inside SPAN for SiYuan beforePaste");
    assert.equal(tracked.size, 2);

    // Simulate real SiYuan SpinBlockDOM replacing the whole block with new DOM nodes AND invalidating collapsed
    // trackRange handles (due to overlapping `close:span` boundary tokens), including a pre-existing identical URL!
    const replacementBlock = new MockElement("div", doc, { "data-node-id": "b-seq", contenteditable: "true" });
    const spunFirstLink = new MockElement("span", doc, { "data-type": "a", "data-href": "https://example.com/first" });
    spunFirstLink.textContent = "First Title";
    const spaceNode = new MockText(" ", doc);
    const secondLink = new MockElement("span", doc, { "data-type": "a", "data-href": encodedHref });
    secondLink.textContent = decodedText;
    replacementBlock.appendChild(spunFirstLink);
    replacementBlock.appendChild(spaceNode);
    replacementBlock.appendChild(secondLink);
    editor.childNodes = [replacementBlock];
    replacementBlock.parentNode = editor;
    block.parentNode = null;
    protyle.resolveTrackedRange = () => ({ status: "invalid" });

    observerCallback();
    const quietEntry = [...timers.entries()].find(([, t]) => t.ms < 30_000);
    assert.ok(quietEntry);
    await quietEntry[1].fn();

    assert.equal(captured.length, 1);
    assert.deepEqual(captured[0], [secondLink]);
    assert.equal(tracked.size, 0);
    scope.dispose();
  } finally {
    globalThis.getSelection = prevGetSelection;
    globalThis.Range = prevRange;
  }
});
