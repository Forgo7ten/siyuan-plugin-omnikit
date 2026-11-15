import { test } from "node:test";
import assert from "node:assert/strict";
import {
  resolveEditorRootID,
  resolveNotebookID,
  resolveProtyleRunner,
  combineSignals,
} from "../src/core/ProtyleAdapter.ts";

test("resolveEditorRootID unpacks rootID across various event and editor structures", () => {
  // 1. Direct detail.data.rootID (e.g. click-editortitleicon)
  assert.equal(
    resolveEditorRootID({ detail: { data: { rootID: "root-detail-data-1" } } }),
    "root-detail-data-1",
  );

  // 2. Fallback to detail.data.id
  assert.equal(
    resolveEditorRootID({ detail: { data: { id: "root-detail-id-2" } } }),
    "root-detail-id-2",
  );

  // 3. Protyle instance: protyle.block.rootID
  assert.equal(
    resolveEditorRootID({ protyle: { block: { rootID: "root-block-3" } } }),
    "root-block-3",
  );

  // 4. Nested Protyle instance: protyle.protyle.block.rootID
  assert.equal(
    resolveEditorRootID({ protyle: { protyle: { block: { rootID: "root-nested-4" } } } }),
    "root-nested-4",
  );

  // 5. Editor wrapper: editor.protyle.block.rootID
  assert.equal(
    resolveEditorRootID({ editor: { protyle: { block: { rootID: "root-editor-5" } } } }),
    "root-editor-5",
  );

  // 6. IProtyle getInstance()
  assert.equal(
    resolveEditorRootID({
      getInstance() {
        return { block: { rootID: "root-instance-6" } };
      },
    }),
    "root-instance-6",
  );

  // 7. Non-object or empty returns undefined
  assert.equal(resolveEditorRootID(null), undefined);
  assert.equal(resolveEditorRootID(undefined), undefined);
  assert.equal(resolveEditorRootID("invalid"), undefined);
  assert.equal(resolveEditorRootID({}), undefined);
  assert.equal(resolveEditorRootID({ data: { rootID: "" } }), undefined);
});

test("resolveNotebookID unpacks notebook ID across various structures", () => {
  // 1. Direct protyle.notebookId
  assert.equal(resolveNotebookID({ notebookId: "nb-1" }), "nb-1");

  // 2. protyle.block.box
  assert.equal(resolveNotebookID({ block: { box: "box-2" } }), "box-2");

  // 3. nested protyle.protyle.notebookId
  assert.equal(resolveNotebookID({ protyle: { notebookId: "nb-3" } }), "nb-3");

  // 4. nested protyle.protyle.block.box
  assert.equal(resolveNotebookID({ protyle: { block: { box: "box-4" } } }), "box-4");

  // 5. detail.data.box
  assert.equal(resolveNotebookID({ detail: { data: { box: "box-5" } } }), "box-5");

  // 6. IProtyle getInstance()
  assert.equal(
    resolveNotebookID({
      getInstance() {
        return { notebookId: "nb-6" };
      },
    }),
    "nb-6",
  );

  // 7. Invalid returns undefined
  assert.equal(resolveNotebookID(null), undefined);
  assert.equal(resolveNotebookID({}), undefined);
  assert.equal(resolveNotebookID({ notebookId: "" }), undefined);
});

test("resolveProtyleRunner extracts runner with updateTransactionElement", () => {
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

  // 3. Nested target.protyle
  const nestedWrapper = {
    protyle: directRunner,
  };
  assert.equal(resolveProtyleRunner(nestedWrapper), directRunner);

  // 4. Invalid target returns null
  assert.equal(resolveProtyleRunner(null), null);
  assert.equal(resolveProtyleRunner({}), null);
  assert.equal(resolveProtyleRunner({ updateTransactionElement: "not-a-function" }), null);
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
