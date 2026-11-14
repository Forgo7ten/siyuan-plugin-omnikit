import { test } from "node:test";
import assert from "node:assert/strict";
import { shouldAutoCompress } from "../src/features/image-compressor/AutoPolicy.ts";
import { analyzeDocTreeTarget } from "../src/core/MenuRouter.ts";

const basic = { featureEnabled: true, globalEnabled: false, allowlisted: false, hostSupportsUpload: true, rootID: "20250101000000-abcdefg" };
test("OmniKit auto-compression truth table", () => {
  for (const globalEnabled of [false, true]) for (const allowlisted of [false, true]) {
    const expected = globalEnabled || allowlisted;
    assert.equal(shouldAutoCompress({ ...basic, globalEnabled, allowlisted }), expected);
  }
  assert.equal(shouldAutoCompress({ ...basic, featureEnabled: false, globalEnabled: true, allowlisted: true }), false);
  assert.equal(shouldAutoCompress({ ...basic, hostSupportsUpload: false, globalEnabled: true }), false);
  assert.equal(shouldAutoCompress({ ...basic, rootID: "", globalEnabled: true }), false);
});

test("document tree target accepts one file and rejects notebooks or selections", () => {
  const menu = {};
  assert.deepEqual(analyzeDocTreeTarget({
    menu,
    type: "doc",
    items: [{ id: "20250101000000-abcdefg", type: "navigation-file" }],
  }), { target: { rootID: "20250101000000-abcdefg" } });
  assert.equal(analyzeDocTreeTarget({
    menu,
    type: "doc",
    items: [{ id: "doc-a" }, { id: "doc-b" }],
  }).target, undefined);
  assert.equal(analyzeDocTreeTarget({
    menu,
    type: "notebook",
    items: [{ id: "notebook-id" }],
  }).target, undefined);
  assert.equal(analyzeDocTreeTarget({
    menu,
    elements: [{ getAttribute: key => key === "data-type" ? "navigation-root" : "box-id" }],
  }).target, undefined);
});
