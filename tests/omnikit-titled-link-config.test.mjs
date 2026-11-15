import { test } from "node:test";
import assert from "node:assert/strict";
import {
  TITLED_LINK_SETTINGS_FILE,
  defaultTitledLinkConfig,
  parseTitledLinkConfig,
  titledLinkSettingsCodec,
} from "../src/features/titled-link/settings.ts";

test("titled-link settings use the isolated file and documented defaults", () => {
  assert.equal(TITLED_LINK_SETTINGS_FILE, "feature-titled-link-settings.json");
  assert.deepEqual(defaultTitledLinkConfig(), {
    schemaVersion: 1,
    auto: { enabled: true },
    replaceTitle: false,
    maxTitleLength: 80,
    fallbackToHostname: true,
  });
  assert.deepEqual(titledLinkSettingsCodec.parse(titledLinkSettingsCodec.defaults()), defaultTitledLinkConfig());
});

test("titled-link settings parse a complete valid configuration", () => {
  const config = {
    schemaVersion: 1,
    auto: { enabled: false },
    replaceTitle: true,
    maxTitleLength: 0,
    fallbackToHostname: false,
  };
  assert.deepEqual(parseTitledLinkConfig(config), config);
});

test("titled-link settings reject invalid or incomplete values", () => {
  for (const maxTitleLength of [-1, 1.5, 201, Number.NaN]) {
    assert.throws(() => parseTitledLinkConfig({ ...defaultTitledLinkConfig(), maxTitleLength }));
  }
  assert.throws(() => parseTitledLinkConfig({ ...defaultTitledLinkConfig(), schemaVersion: 2 }));
  assert.throws(() => parseTitledLinkConfig({ ...defaultTitledLinkConfig(), auto: {} }));
  assert.throws(() => parseTitledLinkConfig({ ...defaultTitledLinkConfig(), replaceTitle: "yes" }));
  assert.throws(() => parseTitledLinkConfig({ ...defaultTitledLinkConfig(), fallbackToHostname: null }));
});

