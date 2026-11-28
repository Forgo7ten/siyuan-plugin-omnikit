import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, execFile } from "node:child_process";
import http from "node:http";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

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

    const logs = [];
    const updated = await updateVersion("patch", { projectRoot: root, log: msg => logs.push(msg) });
    assert.equal(updated, "0.1.1");
    assert.ok(logs.some(line => line.includes("0.1.0 -> 0.1.1")));

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

const generateNotesScript = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../scripts/release/generate-notes.sh",
);

function git(cwd, ...args) {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    env: {
      ...process.env,
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_AUTHOR_NAME: "OmniKit Test",
      GIT_AUTHOR_EMAIL: "test@example.com",
      GIT_COMMITTER_NAME: "OmniKit Test",
      GIT_COMMITTER_EMAIL: "test@example.com",
    },
  });
}

async function withMockGitHubApi(handler, fn) {
  const server = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = Buffer.concat(chunks).toString("utf8");
    const result = handler({ method: req.method, url: req.url, body: body ? JSON.parse(body) : null });
    res.writeHead(result.status ?? 200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(result.json));
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  try {
    return await fn(`http://127.0.0.1:${port}`);
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
}

test("generate-notes.sh appends ## Commits after GitHub native release notes", async () => {
  const repo = await mkdtemp(path.join(os.tmpdir(), "omnikit-release-notes-"));
  try {
    git(repo, "init", "-b", "main");
    await writeFile(path.join(repo, "file.txt"), "1\n");
    git(repo, "add", ".");
    git(repo, "commit", "-m", "feat: initial release");
    git(repo, "tag", "v0.1.0");

    await writeFile(path.join(repo, "file.txt"), "2\n");
    git(repo, "add", ".");
    git(repo, "commit", "-m", "fix: first change after v0.1.0");

    await writeFile(path.join(repo, "file.txt"), "3\n");
    git(repo, "add", ".");
    git(repo, "commit", "-m", "feat: newest change for v0.2.0");
    const headSha = git(repo, "rev-parse", "HEAD").trim();

    const requests = [];
    await withMockGitHubApi(req => {
      requests.push(req);
      return {
        status: 200,
        json: {
          body: "**Full Changelog**: https://github.com/owner/repo/compare/v0.1.0...v0.2.0",
        },
      };
    }, async apiUrl => {
      // 1) workflow_dispatch case: RELEASE_TAG does not exist yet
      const outManual = path.join(repo, "notes-manual.md");
      const ghOutput = path.join(repo, "github-output.txt");
      await execFileAsync("bash", [generateNotesScript], {
        cwd: repo,
        env: {
          ...process.env,
          GH_TOKEN: "test-token",
          GH_REPO: "owner/repo",
          RELEASE_TAG: "v0.2.0",
          GITHUB_SHA: headSha,
          GITHUB_API_URL: apiUrl,
          OUTPUT_FILE: outManual,
          GITHUB_OUTPUT: ghOutput,
        },
      });

      const expected = [
        "**Full Changelog**: https://github.com/owner/repo/compare/v0.1.0...v0.2.0",
        "",
        "## Commits",
        "",
        "- feat: newest change for v0.2.0",
        "- fix: first change after v0.1.0",
        "",
      ].join("\n");
      assert.equal(await readFile(outManual, "utf8"), expected);
      assert.equal(await readFile(ghOutput, "utf8"), `notes_file=${outManual}\n`);
      assert.deepEqual(requests[0], {
        method: "POST",
        url: "/repos/owner/repo/releases/generate-notes",
        body: { tag_name: "v0.2.0", target_commitish: headSha, previous_tag_name: "v0.1.0" },
      });

      // 2) push.tags case: RELEASE_TAG already points to HEAD
      git(repo, "tag", "v0.2.0");
      const outTag = path.join(repo, "notes-tag.md");
      await execFileAsync("bash", [generateNotesScript], {
        cwd: repo,
        env: {
          ...process.env,
          GH_TOKEN: "test-token",
          GH_REPO: "owner/repo",
          RELEASE_TAG: "v0.2.0",
          GITHUB_SHA: headSha,
          GITHUB_API_URL: apiUrl,
          OUTPUT_FILE: outTag,
        },
      });
      assert.equal(await readFile(outTag, "utf8"), expected);
    });
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
});

test("generate-notes.sh omits previous_tag_name on first release and preserves GitHub PR body", async () => {
  const repo = await mkdtemp(path.join(os.tmpdir(), "omnikit-release-notes-first-"));
  try {
    git(repo, "init", "-b", "main");
    await writeFile(path.join(repo, "a.txt"), "a\n");
    git(repo, "add", ".");
    git(repo, "commit", "-m", "feat: first commit");

    await writeFile(path.join(repo, "a.txt"), "b\n");
    git(repo, "add", ".");
    git(repo, "commit", "-m", "docs: second commit");
    const headSha = git(repo, "rev-parse", "HEAD").trim();

    const requests = [];
    await withMockGitHubApi(req => {
      requests.push(req);
      return {
        status: 200,
        json: {
          body: "## What's Changed\n* Add docs by @dev in https://github.com/owner/repo/pull/1\n\n**Full Changelog**: https://github.com/owner/repo/commits/v0.1.0",
        },
      };
    }, async apiUrl => {
      const outFirst = path.join(repo, "notes-first.md");
      await execFileAsync("bash", [generateNotesScript], {
        cwd: repo,
        env: {
          ...process.env,
          GH_TOKEN: "test-token",
          GH_REPO: "owner/repo",
          RELEASE_TAG: "v0.1.0",
          GITHUB_SHA: headSha,
          GITHUB_API_URL: apiUrl,
          OUTPUT_FILE: outFirst,
        },
      });
      assert.deepEqual(requests[0].body, {
        tag_name: "v0.1.0",
        target_commitish: headSha,
      });
      assert.equal(
        await readFile(outFirst, "utf8"),
        [
          "## What's Changed",
          "* Add docs by @dev in https://github.com/owner/repo/pull/1",
          "",
          "**Full Changelog**: https://github.com/owner/repo/commits/v0.1.0",
          "",
          "## Commits",
          "",
          "- docs: second commit",
          "- feat: first commit",
          "",
        ].join("\n"),
      );
    });
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
});


test("release.yml reconciles existing tag before generating release notes on manual dispatch", async () => {
  const workflowPath = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    "../../.github/workflows/release.yml",
  );
  const reconcileScript = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    "../../scripts/release/reconcile-tag.sh",
  );
  const workflow = await readFile(workflowPath, "utf8");
  const reconcile = await readFile(reconcileScript, "utf8");
  const reconcileIdx = workflow.indexOf("name: Reconcile release tag");
  const notesIdx = workflow.indexOf("name: Generate release notes");
  assert.ok(reconcileIdx > 0 && notesIdx > 0 && reconcileIdx < notesIdx, "Reconcile release tag must run before Generate release notes");
  assert.match(reconcile, /git tag -d "\$\{RELEASE_TAG\}"/);
});
