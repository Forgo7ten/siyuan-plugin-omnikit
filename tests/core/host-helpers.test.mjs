import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createRuntimeId } from "../../src/core/host/id.ts";
import { describeError } from "../../src/core/host/describeError.ts";
import { PROTECTED_CONTAINER_SELECTOR, isInsideProtectedContainer } from "../../src/core/host/dom.ts";

test("createRuntimeId generates unique prefixed IDs without crypto.randomUUID", () => {
  const ids = new Set();
  for (let i = 0; i < 10_000; i++) {
    const id = createRuntimeId("img-task");
    assert.match(id, /^img-task-[0-9a-z]+-[0-9a-z]+$/);
    ids.add(id);
  }
  assert.equal(ids.size, 10_000);
});

test("describeError formats Error, { msg, code }, string, and fallback", () => {
  assert.equal(describeError(new Error("boom")), "boom");
  assert.equal(describeError(new TypeError("")), "TypeError");
  assert.equal(describeError({ msg: "Invalid argument", code: -1 }), "Invalid argument (code -1)");
  assert.equal(describeError({ msg: "Only message" }), "Only message");
  assert.equal(describeError({ code: 403 }), "Error (code 403)");
  assert.equal(describeError("plain failure"), "plain failure");
  assert.equal(describeError({}), "Unknown error");
  assert.equal(describeError(null), "Unknown error");
  assert.equal(describeError(undefined), "Unknown error");
});

test("PROTECTED_CONTAINER_SELECTOR and isInsideProtectedContainer check protected ancestors", () => {
  assert.equal(
    PROTECTED_CONTAINER_SELECTOR,
    '[data-type="NodeCodeBlock"], [data-type="NodeBlockQueryEmbed"], [data-type="NodeAttributeView"], [data-type="NodeMathBlock"], [data-type="NodeHTMLBlock"], .protyle-wysiwyg__embed, .av, .render-node, pre, code',
  );
  let capturedSelector;
  const protectedNode = {
    closest(selector) {
      capturedSelector = selector;
      return {};
    },
  };
  const normalNode = {
    closest() {
      return null;
    },
  };
  assert.equal(isInsideProtectedContainer(protectedNode), true);
  assert.equal(capturedSelector, PROTECTED_CONTAINER_SELECTOR);
  assert.equal(isInsideProtectedContainer(normalNode), false);
});

test("core styles/index.scss does not contain feature-specific image-records selectors", async () => {
  const scss = await readFile(new URL("../../src/styles/index.scss", import.meta.url), "utf8");
  assert.doesNotMatch(scss, /\.image-records__/);
});
