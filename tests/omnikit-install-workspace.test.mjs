import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { installWorkspace } from "../tools/install-workspace.mjs";

const files = [
  "plugin.json",
  "index.js",
  "index.css",
  "icon.png",
  "README.md",
  "README.zh-CN.md",
  "browser-image-compression.js",
  "assets/omnikit-plugin.svg",
  "assets/omnikit-menu.svg",
  "i18n/en.json",
  "i18n/zh-CN.json",
];

async function prepare(root) {
  const buildDir = path.join(root, "build");
  const workspace = path.join(root, "SiYuan workspace");
  const pluginsDir = path.join(workspace, "data", "plugins");
  await mkdir(buildDir, { recursive: true });
  await mkdir(path.join(workspace, "conf"), { recursive: true });
  await mkdir(path.join(workspace, "data", ".siyuan"), { recursive: true });
  await mkdir(pluginsDir, { recursive: true });
  for (const file of files) {
    const destination = path.join(buildDir, file);
    await mkdir(path.dirname(destination), { recursive: true });
    await writeFile(destination, file === "plugin.json"
      ? JSON.stringify({ name: "siyuan-plugin-omnikit" })
      : `built:${file}`);
  }
  return { buildDir, workspace, pluginsDir };
}

test("installs current build resources and backs up the previous plugin", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "omnikit install test "));
  try {
    const { buildDir, workspace, pluginsDir } = await prepare(root);
    const target = path.join(pluginsDir, "siyuan-plugin-omnikit");
    const messages = [];
    const install = () => installWorkspace(workspace, { buildDir, log: message => messages.push(message) });

    await install();
    for (const file of files) {
      assert.equal(await readFile(path.join(target, file), "utf8"), file === "plugin.json"
        ? JSON.stringify({ name: "siyuan-plugin-omnikit" })
        : `built:${file}`);
    }

    await writeFile(path.join(target, "index.js"), "previous build");
    await install();
    assert.equal(await readFile(path.join(target, "index.js"), "utf8"), "built:index.js");
    const backup = (await readdir(pluginsDir)).find(name => name.startsWith("siyuan-plugin-omnikit.backup-"));
    assert.ok(backup);
    assert.equal(await readFile(path.join(pluginsDir, backup, "index.js"), "utf8"), "previous build");
    assert.ok(messages.some(message => message.startsWith("Previous plugin preserved at:")));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("refuses to replace a directory owned by another plugin", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "omnikit install test "));
  try {
    const { buildDir, workspace, pluginsDir } = await prepare(root);
    const target = path.join(pluginsDir, "siyuan-plugin-omnikit");
    await mkdir(target);
    await writeFile(path.join(target, "plugin.json"), JSON.stringify({ name: "another-plugin" }));

    await assert.rejects(
      installWorkspace(workspace, { buildDir, log: () => {} }),
      /existing target does not identify as siyuan-plugin-omnikit/,
    );
    assert.equal(JSON.parse(await readFile(path.join(target, "plugin.json"), "utf8")).name, "another-plugin");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
