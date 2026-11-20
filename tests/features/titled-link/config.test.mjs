import { test } from "node:test";
import assert from "node:assert/strict";
import {
  TITLED_LINK_SETTINGS_FILE,
  defaultTitledLinkConfig,
  parseTitledLinkConfig,
  titledLinkSettingsCodec,
} from "../../../src/features/titled-link/policy/settings.ts";

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

