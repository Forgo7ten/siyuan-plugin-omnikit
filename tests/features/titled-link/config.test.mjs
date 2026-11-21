import { test } from "node:test";
import assert from "node:assert/strict";
import {
  TITLED_LINK_SETTINGS_FILE,
  defaultTitledLinkConfig,
  parseTitledLinkConfig,
  titledLinkSettingsCodec,
} from "../../../src/features/titled-link/policy/settings.ts";
import { resolveAutoPasteHelp } from "../../../src/features/titled-link/ui/autoPasteHelp.ts";

test("titled-link settings use the isolated file and documented defaults", () => {
  assert.equal(TITLED_LINK_SETTINGS_FILE, "feature-titled-link-settings.json");
  assert.deepEqual(defaultTitledLinkConfig(), {
    schemaVersion: 1,
    auto: { enabled: true },
    replaceTitle: false,
    fallbackToHostname: true,
  });
  assert.deepEqual(titledLinkSettingsCodec.parse(titledLinkSettingsCodec.defaults()), defaultTitledLinkConfig());
});

test("titled-link settings parse a complete valid configuration and ignore legacy maxTitleLength", () => {
  const config = {
    schemaVersion: 1,
    auto: { enabled: false },
    replaceTitle: true,
    fallbackToHostname: false,
  };
  assert.deepEqual(parseTitledLinkConfig(config), config);
  assert.deepEqual(parseTitledLinkConfig({ ...config, maxTitleLength: 42 }), config);
});

test("titled-link settings reject invalid or incomplete values", () => {
  assert.throws(() => parseTitledLinkConfig({ ...defaultTitledLinkConfig(), schemaVersion: 2 }));
  assert.throws(() => parseTitledLinkConfig({ ...defaultTitledLinkConfig(), auto: {} }));
  assert.throws(() => parseTitledLinkConfig({ ...defaultTitledLinkConfig(), replaceTitle: "yes" }));
  assert.throws(() => parseTitledLinkConfig({ ...defaultTitledLinkConfig(), fallbackToHostname: null }));
});

test("resolveAutoPasteHelp formats runtime SiYuan language labels when available and falls back otherwise", () => {
  const calls = [];
  const t = (key, values) => {
    calls.push({ key, values });
    return values ? `${key}:${JSON.stringify(values)}` : key;
  };

  assert.equal(
    resolveAutoPasteHelp(t, {
      configGroupBehavior: "  Behavior  ",
      pasteURLAutoConvert: "  Auto-convert URLs on paste ",
    }),
    'feature.titledLink.settings.autoHelpDynamic:{"group":"Behavior","setting":"Auto-convert URLs on paste"}',
  );

  assert.equal(resolveAutoPasteHelp(t, { configGroupBehavior: "   ", pasteURLAutoConvert: "Setting" }), "feature.titledLink.settings.autoHelp");
  assert.equal(resolveAutoPasteHelp(t, { configGroupBehavior: "Behavior", pasteURLAutoConvert: "" }), "feature.titledLink.settings.autoHelp");
  assert.equal(resolveAutoPasteHelp(t, { configGroupBehavior: 123, pasteURLAutoConvert: "Setting" }), "feature.titledLink.settings.autoHelp");

  const prevSiyuan = globalThis.siyuan;
  try {
    globalThis.siyuan = undefined;
    assert.equal(resolveAutoPasteHelp(t), "feature.titledLink.settings.autoHelp");

    globalThis.siyuan = {
      languages: {
        configGroupBehavior: "行为",
        pasteURLAutoConvert: "粘贴 URL 自动转链接",
      },
    };
    assert.equal(
      resolveAutoPasteHelp(t),
      'feature.titledLink.settings.autoHelpDynamic:{"group":"行为","setting":"粘贴 URL 自动转链接"}',
    );
  } finally {
    globalThis.siyuan = prevSiyuan;
  }
});

