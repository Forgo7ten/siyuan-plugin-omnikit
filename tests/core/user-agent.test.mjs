import { test } from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_USER_AGENT, SettingsManager } from "../../src/core/store/SettingsManager.ts";

function plugin(initialCore) {
  const writes = [];
  const storage = new Map(initialCore === undefined ? [] : [["omnikit-core.json", structuredClone(initialCore)]]);
  const host = {
    writes,
    storage,
    loadDataCalls: 0,
    async loadData(name) { host.loadDataCalls += 1; return storage.get(name) ?? ""; },
    async saveData(name, value) { writes.push(name); storage.set(name, structuredClone(value)); },
  };
  return host;
}

function createFileGetFetch(storage, pluginName = "siyuan-plugin-omnikit") {
  const prefix = `/data/storage/petal/${pluginName}/`;
  return async (url, request) => {
    assert.equal(url, "/api/file/getFile");
    assert.equal(request.method, "POST");
    const { path } = JSON.parse(request.body);
    assert.ok(path.startsWith(prefix), `Unexpected storage path: ${path}`);
    const name = path.slice(prefix.length);
    assert.equal(path, `/data/storage/petal/${pluginName}/${name}`);
    assert.ok(!name.includes("/"));
    if (!storage.has(name)) {
      return new Response(JSON.stringify({ code: 404, msg: "not found" }), { status: 202 });
    }
    const raw = storage.get(name);
    return new Response(typeof raw === "string" ? raw : JSON.stringify(raw), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  };
}

const feature = {
  id: "sample",
  file: "feature-sample-settings.json",
  defaultEnabled: true,
  codec: {
    defaults: () => ({ schemaVersion: 1, value: "default" }),
    parse(raw) {
      if (raw?.schemaVersion !== 1 || typeof raw.value !== "string") throw new Error("bad feature config");
      return structuredClone(raw);
    },
  },
};

test("core settings initialize with the preset Chrome User-Agent without writing missing files", async () => {
  const host = plugin();
  const settings = new SettingsManager(host, [feature], createFileGetFetch(host.storage));
  await settings.load();

  assert.equal(host.loadDataCalls, 0);
  assert.deepEqual(host.writes, []);
  assert.equal(settings.getGeneral().userAgent, DEFAULT_USER_AGENT);
  assert.equal(settings.getUserAgent(), DEFAULT_USER_AGENT);
  assert.match(settings.getGeneral().userAgent, /Chrome\/157\.0\.0\.0/);
});

test("core settings read, write, and restore blank User-Agent to the preset on save", async () => {
  const host = plugin();
  const settings = new SettingsManager(host, [feature], createFileGetFetch(host.storage));
  await settings.load();

  await settings.updateGeneral({ userAgent: "OmniKit-Test/1.0" });

  assert.equal(host.loadDataCalls, 0);
  assert.equal(settings.getGeneral().userAgent, "OmniKit-Test/1.0");
  assert.equal(settings.getUserAgent(), "OmniKit-Test/1.0");
  assert.equal(host.storage.get("omnikit-core.json").general.userAgent, "OmniKit-Test/1.0");

  await settings.updateGeneral({ userAgent: "   " });
  assert.equal(settings.getGeneral().userAgent, DEFAULT_USER_AGENT);
  assert.equal(host.storage.get("omnikit-core.json").general.userAgent, DEFAULT_USER_AGENT);

  await assert.rejects(
    settings.updateGeneral({ userAgent: "bad\r\nInjected: yes" }),
    /Invalid general User-Agent/,
  );
});

test("load backfills empty or missing userAgent to default and writes core file", async () => {
  for (const initialGeneral of [
    { debugLog: true },
    { debugLog: true, userAgent: "" },
    { debugLog: true, userAgent: "   \t  " },
  ]) {
    const host = plugin({
      schemaVersion: 1,
      general: initialGeneral,
      featureStates: { imageCompressor: { enabled: true } },
    });
    const settings = new SettingsManager(host, [feature], createFileGetFetch(host.storage));

    await settings.load();

    assert.equal(host.loadDataCalls, 0);
    assert.deepEqual(settings.getGeneral(), { debugLog: true, userAgent: DEFAULT_USER_AGENT });
    assert.equal(settings.getUserAgent(), DEFAULT_USER_AGENT);
    assert.deepEqual(host.writes, ["omnikit-core.json"]);
    assert.deepEqual(host.storage.get("omnikit-core.json"), {
      schemaVersion: 1,
      general: { debugLog: true, userAgent: DEFAULT_USER_AGENT },
      featureStates: { imageCompressor: { enabled: true } },
    });
  }
});

test("load skips core disk write when userAgent is already non-empty and survives backfill write error", async () => {
  const configuredHost = plugin({
    schemaVersion: 1,
    general: { debugLog: false, userAgent: "Custom/3.0" },
    featureStates: {},
  });
  const configuredSettings = new SettingsManager(configuredHost, [feature], createFileGetFetch(configuredHost.storage));
  await configuredSettings.load();
  assert.deepEqual(configuredHost.writes, []);
  assert.equal(configuredSettings.getGeneral().userAgent, "Custom/3.0");

  const failingHost = plugin({
    schemaVersion: 1,
    general: { debugLog: true, userAgent: "" },
    featureStates: {},
  });
  failingHost.saveData = async () => {
    throw new Error("disk full");
  };
  const warnings = [];
  const origWarn = console.warn;
  console.warn = (...args) => warnings.push(args.join(" "));
  try {
    const failingSettings = new SettingsManager(failingHost, [feature], createFileGetFetch(failingHost.storage));
    await failingSettings.load();
    assert.equal(failingSettings.getGeneral().userAgent, "");
    assert.equal(failingSettings.getUserAgent(), DEFAULT_USER_AGENT);
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /omnikit-core\.json/);
  } finally {
    console.warn = origWarn;
  }
});

test("resetAll restores core and feature settings without touching data files", async () => {
  const host = plugin();
  host.storage.set("feature-sample-records.json", { records: ["keep"] });
  const settings = new SettingsManager(host, [feature], createFileGetFetch(host.storage));
  await settings.load();
  await settings.updateGeneral({ debugLog: true, userAgent: "Custom/2.0" });
  await settings.setFeatureEnabled("sample", false);
  await settings.updateFeature("sample", config => { config.value = "changed"; });

  await settings.resetAll();

  assert.equal(host.loadDataCalls, 0);
  assert.deepEqual(settings.core.snapshot(), {
    schemaVersion: 1,
    general: { debugLog: false, userAgent: DEFAULT_USER_AGENT },
    featureStates: {},
  });
  assert.deepEqual(settings.getFeature("sample"), { schemaVersion: 1, value: "default" });
  assert.deepEqual(host.storage.get("feature-sample-records.json"), { records: ["keep"] });
  assert.ok(!host.writes.includes("feature-sample-records.json"));
});
