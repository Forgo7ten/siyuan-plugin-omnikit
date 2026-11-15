import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { existsSync } from "node:fs";

import {
  calculateNextVersion,
  parseSemVer,
  updateVersion,
} from "../../scripts/release/update-version.mjs";
import { cleanArtifacts } from "../../scripts/clean.mjs";
import { verifyVersions } from "../../scripts/release/release.mjs";

test("parseSemVer validates and splits standard X.Y.Z strings", () => {
  assert.deepEqual(parseSemVer("0.1.0"), { major: 0, minor: 1, patch: 0 });
  assert.deepEqual(parseSemVer("1.20.300"), { major: 1, minor: 20, patch: 300 });

  assert.throws(() => parseSemVer("v1.0.0"), /Invalid SemVer format/);
  assert.throws(() => parseSemVer("1.0"), /Invalid SemVer format/);
  assert.throws(() => parseSemVer("1.0.0-beta"), /Invalid SemVer format/);
  assert.throws(() => parseSemVer(""), /Invalid SemVer format/);
  assert.throws(() => parseSemVer(null), /Invalid SemVer format/);
});

test("calculateNextVersion computes patch, minor, major, and custom versions correctly", () => {
  assert.equal(calculateNextVersion("0.1.0", "patch"), "0.1.1");
  assert.equal(calculateNextVersion("0.1.0", "minor"), "0.2.0");
  assert.equal(calculateNextVersion("0.1.0", "major"), "1.0.0");

  assert.equal(calculateNextVersion("1.5.3", "patch"), "1.5.4");
  assert.equal(calculateNextVersion("1.5.3", "minor"), "1.6.0");
  assert.equal(calculateNextVersion("1.5.3", "major"), "2.0.0");

  assert.equal(calculateNextVersion("0.1.0", "0.3.5"), "0.3.5");

  assert.throws(() => calculateNextVersion("0.1.0", "invalid"), /Invalid bump type or SemVer/);
  assert.throws(() => calculateNextVersion("0.1.0", "v0.2.0"), /Invalid bump type or SemVer/);
  assert.throws(() => calculateNextVersion("0.1.0", ""), /Missing version bump argument/);
});

test("updateVersion updates package.json and plugin.json atomically", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "omnikit-version-test-"));
  try {
    const pkg = { name: "test-plugin", version: "0.1.0" };
    const manifest = { name: "test-plugin", version: "0.1.0" };

    await writeFile(path.join(root, "package.json"), JSON.stringify(pkg, null, 2) + "\n");
    await writeFile(path.join(root, "plugin.json"), JSON.stringify(manifest, null, 2) + "\n");

    const updated = await updateVersion("patch", { projectRoot: root, log: () => {} });
    assert.equal(updated, "0.1.1");

    const updatedPkg = JSON.parse(await readFile(path.join(root, "package.json"), "utf8"));
    const updatedManifest = JSON.parse(await readFile(path.join(root, "plugin.json"), "utf8"));

    assert.equal(updatedPkg.version, "0.1.1");
    assert.equal(updatedManifest.version, "0.1.1");

    // Test mismatch rejection
    await writeFile(path.join(root, "plugin.json"), JSON.stringify({ ...manifest, version: "0.2.0" }));
    await assert.rejects(
      () => updateVersion("patch", { projectRoot: root, log: () => {} }),
      /Version mismatch/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("cleanArtifacts safely removes dist, .generated, and package.zip while preserving other files", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "omnikit-clean-test-"));
  try {
    const distDir = path.join(root, "dist");
    const genDir = path.join(root, ".generated");
    const zipFile = path.join(root, "package.zip");
    const keepFile = path.join(root, "keep.txt");

    await mkdir(distDir, { recursive: true });
    await writeFile(path.join(distDir, "index.js"), "content");
    await mkdir(genDir, { recursive: true });
    await writeFile(path.join(genDir, "icon.png"), "icon");
    await writeFile(zipFile, "zip data");
    await writeFile(keepFile, "do not delete");

    const removed = cleanArtifacts(root, { log: () => {} });

    assert.deepEqual(removed.sort(), [".generated", "dist", "package.zip"].sort());
    assert.ok(!existsSync(distDir));
    assert.ok(!existsSync(genDir));
    assert.ok(!existsSync(zipFile));
    assert.ok(existsSync(keepFile));

    // Test idempotence
    const removedSecond = cleanArtifacts(root, { log: () => {} });
    assert.deepEqual(removedSecond, []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("verifyVersions validates manifest and package version synchronization", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "omnikit-verify-version-test-"));
  try {
    await writeFile(
      path.join(root, "package.json"),
      JSON.stringify({ version: "0.1.0" }, null, 2),
    );
    await writeFile(
      path.join(root, "plugin.json"),
      JSON.stringify({ version: "0.1.0" }, null, 2),
    );

    const version = await verifyVersions(root);
    assert.equal(version, "0.1.0");

    await writeFile(
      path.join(root, "package.json"),
      JSON.stringify({ version: "0.1.1" }, null, 2),
    );
    await assert.rejects(() => verifyVersions(root), /Version mismatch/);

    await writeFile(
      path.join(root, "package.json"),
      JSON.stringify({ version: "invalid" }, null, 2),
    );
    await writeFile(
      path.join(root, "plugin.json"),
      JSON.stringify({ version: "invalid" }, null, 2),
    );
    await assert.rejects(() => verifyVersions(root), /does not conform to SemVer X\.Y\.Z/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
