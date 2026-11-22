import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { translate } from "../../src/i18n/translate.ts";

function extractPlaceholders(text) {
  const found = new Set();
  for (const match of text.matchAll(/\$\{([a-zA-Z0-9_]+)\}|\{([a-zA-Z0-9_]+)\}/g)) {
    found.add(match[1] ?? match[2]);
  }
  return [...found].sort();
}

test("zh-CN.json and en.json have identical keys and matching placeholders", async () => {
  const zh = JSON.parse(await readFile(new URL("../../src/i18n/zh-CN.json", import.meta.url), "utf8"));
  const en = JSON.parse(await readFile(new URL("../../src/i18n/en.json", import.meta.url), "utf8"));

  assert.deepEqual(Object.keys(zh).sort(), Object.keys(en).sort());
  for (const key of Object.keys(en)) {
    assert.equal(typeof zh[key], "string", `zh-CN key ${key} must be string`);
    assert.equal(typeof en[key], "string", `en key ${key} must be string`);
    assert.deepEqual(
      extractPlaceholders(zh[key]),
      extractPlaceholders(en[key]),
      `placeholder mismatch for key "${key}"`,
    );
  }
});

test("translate preserves unknown or prototype placeholders and falls back to missing key", () => {
  const dict = {
    greeting: "Hello ${name}, count=${count}, proto=${toString}",
  };

  assert.equal(translate(dict, "missing.key"), "missing.key");
  assert.equal(
    translate(dict, "greeting", { name: "Ada" }),
    "Hello Ada, count=${count}, proto=${toString}",
  );
  assert.equal(
    translate(dict, "greeting", { name: "Ada", count: 0 }),
    "Hello Ada, count=0, proto=${toString}",
  );
});
