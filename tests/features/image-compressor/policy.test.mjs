import { test } from "node:test";
import assert from "node:assert/strict";
import { autoAllowed, defaultImageFeatureConfig, IMAGE_FEATURE_ID } from "../../../src/features/image-compressor/policy/parseImageConfig.ts";
import { extractDocTreeDocumentIDs } from "../../../src/core/feedback/MenuRouter.ts";

const rootID = "20250101000000-abcdefg";

test("OmniKit auto-compression truth table via parseImageConfig.autoAllowed", () => {
  assert.equal(IMAGE_FEATURE_ID, "imageCompressor");
  for (const globalEnabled of [false, true]) {
    for (const allowlisted of [false, true]) {
      const cfg = defaultImageFeatureConfig();
      cfg.auto.globalEnabled = globalEnabled;
      if (allowlisted) cfg.auto.pageAllowlist[rootID] = { grantedAt: 1 };
      const expected = globalEnabled || allowlisted;
      assert.equal(autoAllowed(cfg, rootID, true), expected);
      assert.equal(autoAllowed(cfg, rootID), expected);
    }
  }
  const enabledCfg = defaultImageFeatureConfig();
  enabledCfg.auto.globalEnabled = true;
  enabledCfg.auto.pageAllowlist[rootID] = { grantedAt: 1 };
  assert.equal(autoAllowed(enabledCfg, rootID, false), false);
  assert.equal(autoAllowed(enabledCfg, "", true), false);
  assert.equal(autoAllowed(enabledCfg, undefined, true), false);
  assert.equal(autoAllowed(enabledCfg, "not-a-node-id", true), false);
});

test("extractDocTreeDocumentIDs handles SiYuan navigation.ts payloads and boxDocEnabled documents", () => {
  const menu = {};
  assert.deepEqual(extractDocTreeDocumentIDs({
    menu,
    type: "doc",
    items: [{ id: "20250101000000-abcdefg", notebookId: "box-1", path: "/20250101000000-abcdefg.sy" }],
  }), ["20250101000000-abcdefg"]);

  assert.deepEqual(extractDocTreeDocumentIDs({
    menu,
    type: "doc",
    items: [{ id: "box-1", notebookId: "box-1", path: "/box-1.sy" }],
  }), ["box-1"]);

  assert.deepEqual(extractDocTreeDocumentIDs({
    menu,
    type: "notebooks",
    items: [
      { id: "box-1", notebookId: "box-1", path: "/" },
      { id: "box-2", notebookId: "box-2", path: "/" },
    ],
  }), []);

  assert.deepEqual(extractDocTreeDocumentIDs({
    menu,
    type: "notebook",
    items: [{ id: "box-1", notebookId: "box-1", path: "/" }],
  }), []);

  assert.deepEqual(extractDocTreeDocumentIDs({
    menu,
    type: "items",
    items: [
      { id: "box-1", notebookId: "box-1", path: "/" },
      { id: "doc-a", notebookId: "box-1", path: "/doc-a.sy" },
    ],
  }), ["doc-a"]);

  assert.deepEqual(extractDocTreeDocumentIDs({
    menu,
    elements: [
      { getAttribute: key => key === "data-type" ? "navigation-root" : "box-1" },
      { getAttribute: key => key === "data-type" ? "navigation-closed" : "box-2" },
      { getAttribute: key => key === "data-type" ? "navigation-file" : "doc-c" },
    ],
  }), ["doc-c"]);
});
