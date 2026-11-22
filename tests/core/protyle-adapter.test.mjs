import { test } from "node:test";
import assert from "node:assert/strict";
import {
  resolveEditorRootID,
  resolveNotebookID,
  resolveProtyleElement,
  resolveWysiwygElement,
  resolveProtyleRunner,
  listEditorsSafe,
  combineSignals,
} from "../../src/core/host/ProtyleAdapter.ts";

test("resolveEditorRootID unpacks rootID across standard event and editor structures", () => {
  // 1. Direct detail.data.rootID (e.g. click-editortitleicon)
  assert.equal(
    resolveEditorRootID({ detail: { data: { rootID: "root-detail-data-1" } } }),
    "root-detail-data-1",
  );

  // 2. Event detail: detail.protyle.block.rootID
  assert.equal(
    resolveEditorRootID({ detail: { protyle: { block: { rootID: "root-detail-protyle-2" } } } }),
    "root-detail-protyle-2",
  );

  // 3. IProtyle instance: protyle.block.rootID
  assert.equal(
    resolveEditorRootID({ block: { rootID: "root-block-3" } }),
    "root-block-3",
  );

  // 4. Protyle wrapper: { protyle: { block: { rootID } } }
  assert.equal(
    resolveEditorRootID({ protyle: { block: { rootID: "root-wrapper-4" } } }),
    "root-wrapper-4",
  );

  // 5. Non-object or empty returns undefined
  assert.equal(resolveEditorRootID(null), undefined);
  assert.equal(resolveEditorRootID(undefined), undefined);
  assert.equal(resolveEditorRootID("invalid"), undefined);
  assert.equal(resolveEditorRootID({}), undefined);
  assert.equal(resolveEditorRootID({ data: { rootID: "" } }), undefined);
});

test("resolveNotebookID unpacks notebook ID across standard structures", () => {
  // 1. Direct protyle.notebookId
  assert.equal(resolveNotebookID({ notebookId: "nb-1" }), "nb-1");

  // 2. protyle.block.box
  assert.equal(resolveNotebookID({ block: { box: "box-2" } }), "box-2");

  // 3. event detail: detail.protyle.notebookId
  assert.equal(resolveNotebookID({ detail: { protyle: { notebookId: "nb-3" } } }), "nb-3");

  // 4. event detail: detail.protyle.block.box
  assert.equal(resolveNotebookID({ detail: { protyle: { block: { box: "box-4" } } } }), "box-4");

  // 5. detail.data.box
  assert.equal(resolveNotebookID({ detail: { data: { box: "box-5" } } }), "box-5");

  // 6. open-menu-doctree: detail.items[0].notebookId
  assert.equal(
    resolveNotebookID({ detail: { items: [{ id: "doc-1", notebookId: "nb-6" }] } }),
    "nb-6",
  );

  // 7. Invalid returns undefined
  assert.equal(resolveNotebookID(null), undefined);
  assert.equal(resolveNotebookID({}), undefined);
  assert.equal(resolveNotebookID({ notebookId: "" }), undefined);
});

test("resolveProtyleElement extracts editor DOM element and enforces HTMLElement when present", () => {
  const mockElement = { tagName: "DIV", className: "protyle" };

  // 1. Direct element (non-DOM environment fallback checks tagName)
  assert.equal(resolveProtyleElement({ element: mockElement }), mockElement);

  // 2. detail.protyle.element
  assert.equal(
    resolveProtyleElement({ detail: { protyle: { element: mockElement } } }),
    mockElement,
  );

  // 3. Protyle wrapper: { protyle: { element } }
  assert.equal(resolveProtyleElement({ protyle: { element: mockElement } }), mockElement);

  // 4. When HTMLElement exists, plain objects with tagName are rejected
  const prevHTMLElement = globalThis.HTMLElement;
  class FakeHTMLElement {
    tagName = "DIV";
  }
  globalThis.HTMLElement = FakeHTMLElement;
  try {
    const realEl = new FakeHTMLElement();
    assert.equal(resolveProtyleElement({ element: realEl }), realEl);
    assert.equal(resolveProtyleElement({ element: mockElement }), undefined);
  } finally {
    globalThis.HTMLElement = prevHTMLElement;
  }

  // 5. Invalid
  assert.equal(resolveProtyleElement(null), undefined);
  assert.equal(resolveProtyleElement({}), undefined);
  assert.equal(resolveProtyleElement({ element: "not-an-element" }), undefined);
});

test("resolveWysiwygElement extracts editable wysiwyg element across Protyle, IProtyle, and event detail", () => {
  const wysiwygEl = { addEventListener() {}, contains() { return true; } };
  assert.equal(resolveWysiwygElement({ wysiwyg: { element: wysiwygEl } }), wysiwygEl);
  assert.equal(resolveWysiwygElement({ protyle: { wysiwyg: { element: wysiwygEl } } }), wysiwygEl);
  assert.equal(resolveWysiwygElement({ detail: { protyle: { wysiwyg: { element: wysiwygEl } } } }), wysiwygEl);
  assert.equal(resolveWysiwygElement({ wysiwyg: { element: { addEventListener() {} } } }), undefined);
  assert.equal(resolveWysiwygElement(null), undefined);
});

test("resolveProtyleRunner extracts runner with updateTransactionElement including event detail IProtyle", () => {
  // 1. Direct runner
  const directRunner = {
    updateTransactionElement(_element, _oldHTML) {},
  };
  assert.equal(resolveProtyleRunner(directRunner), directRunner);

  // 2. IProtyle with getInstance()
  const instanceRunner = {
    updateTransactionElement(_element, _oldHTML) {},
  };
  const iProtyle = {
    getInstance() {
      return instanceRunner;
    },
  };
  assert.equal(resolveProtyleRunner(iProtyle), instanceRunner);

  // 3. Event object with { detail: { protyle: IProtyle } }
  assert.equal(resolveProtyleRunner({ detail: { protyle: iProtyle } }), instanceRunner);

  // 4. Nested target.protyle
  const nestedWrapper = {
    protyle: directRunner,
  };
  assert.equal(resolveProtyleRunner(nestedWrapper), directRunner);

  // 5. Invalid target returns null
  assert.equal(resolveProtyleRunner(null), null);
  assert.equal(resolveProtyleRunner({}), null);
  assert.equal(resolveProtyleRunner({ updateTransactionElement: "not-a-function" }), null);
});

test("listEditorsSafe handles missing, throwing, and non-array getters without breaking callers", () => {
  assert.deepEqual(listEditorsSafe(undefined), []);
  assert.deepEqual(listEditorsSafe(() => [{ id: 1 }]), [{ id: 1 }]);
  assert.deepEqual(listEditorsSafe(() => null), []);

  const warnings = [];
  const result = listEditorsSafe(
    () => { throw new TypeError("mobile.editor undefined"); },
    { warn(msg, err) { warnings.push({ msg, err }); } },
  );
  assert.deepEqual(result, []);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0].msg, /枚举已打开编辑器失败/);
});

test("combineSignals combines signals natively with AbortSignal.any", () => {
  // 1. 0 signals returns undefined
  assert.equal(combineSignals(), undefined);
  assert.equal(combineSignals(undefined, undefined), undefined);

  // 2. 1 valid signal returns the signal directly
  const c1 = new AbortController();
  assert.equal(combineSignals(c1.signal), c1.signal);
  assert.equal(combineSignals(undefined, c1.signal, undefined), c1.signal);

  // 3. Multiple signals returned combined signal
  const c2 = new AbortController();
  const c3 = new AbortController();
  const combined = combineSignals(c2.signal, c3.signal);
  assert.ok(combined);
  assert.equal(combined.aborted, false);

  // Aborting c3 should abort combined
  c3.abort(new Error("c3 cancelled"));
  assert.equal(combined.aborted, true);

  // 4. Already aborted signal
  const c4 = new AbortController();
  c4.abort("already aborted");
  const combinedAborted = combineSignals(c1.signal, c4.signal);
  assert.ok(combinedAborted);
  assert.equal(combinedAborted.aborted, true);
});
