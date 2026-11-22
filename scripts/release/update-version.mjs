import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import readline from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

export const SEMVER_REGEX = /^[0-9]+\.[0-9]+\.[0-9]+$/;

export function parseSemVer(version) {
  if (typeof version !== "string" || !SEMVER_REGEX.test(version.trim())) {
    throw new Error(`Invalid SemVer format: "${version}". Expected format X.Y.Z`);
  }
  const [major, minor, patch] = version.trim().split(".").map(Number);
  return { major, minor, patch };
}

export function calculateNextVersion(currentVersion, bumpTypeOrVersion) {
  const current = parseSemVer(currentVersion);
  if (!bumpTypeOrVersion || typeof bumpTypeOrVersion !== "string") {
    throw new Error("Missing version bump argument");
  }
  const normalized = bumpTypeOrVersion.trim().toLowerCase();

  if (normalized === "patch") {
    return `${current.major}.${current.minor}.${current.patch + 1}`;
  }
  if (normalized === "minor") {
    return `${current.major}.${current.minor + 1}.0`;
  }
  if (normalized === "major") {
    return `${current.major + 1}.0.0`;
  }

  // Explicit version string
  const custom = bumpTypeOrVersion.trim();
  if (!SEMVER_REGEX.test(custom)) {
    throw new Error(`Invalid bump type or SemVer: "${bumpTypeOrVersion}". Expected patch, minor, major, or X.Y.Z`);
  }
  return custom;
}

export async function promptForVersion(currentVersion) {
  const current = parseSemVer(currentVersion);
  const patchVer = `${current.major}.${current.minor}.${current.patch + 1}`;
  const minorVer = `${current.major}.${current.minor + 1}.0`;
  const majorVer = `${current.major + 1}.0.0`;

  const rl = readline.createInterface({ input, output });
  try {
    console.log(`Current version: ${currentVersion}`);
    console.log("Select version bump:");
    console.log(`  1) patch  -> ${patchVer}`);
    console.log(`  2) minor  -> ${minorVer}`);
    console.log(`  3) major  -> ${majorVer}`);
    console.log("  4) custom -> (enter custom X.Y.Z)");

    const answer = (await rl.question("Choose [1-4] or type version: ")).trim();
    if (answer === "1" || answer.toLowerCase() === "patch") return "patch";
    if (answer === "2" || answer.toLowerCase() === "minor") return "minor";
    if (answer === "3" || answer.toLowerCase() === "major") return "major";
    if (answer === "4") {
      return (await rl.question("Enter new version (X.Y.Z): ")).trim();
    }
    return answer;
  } finally {
    rl.close();
  }
}

export async function updateVersion(bumpTypeOrVersion, { projectRoot = root, log = console.log } = {}) {
  const pkgPath = path.join(projectRoot, "package.json");
  const manifestPath = path.join(projectRoot, "plugin.json");

  const pkgContent = await readFile(pkgPath, "utf8");
  const manifestContent = await readFile(manifestPath, "utf8");

  const pkg = JSON.parse(pkgContent);
  const manifest = JSON.parse(manifestContent);

  if (pkg.version !== manifest.version) {
    throw new Error(`Version mismatch: package.json has ${pkg.version}, plugin.json has ${manifest.version}`);
  }

  const oldVersion = pkg.version;
  const newVersion = calculateNextVersion(oldVersion, bumpTypeOrVersion);

  pkg.version = newVersion;
  manifest.version = newVersion;

  await writeFile(pkgPath, JSON.stringify(pkg, null, 2) + "\n", "utf8");
  await writeFile(manifestPath, JSON.stringify(manifest, null, 2) + "\n", "utf8");

  log(`Updated version: ${oldVersion} -> ${newVersion} in package.json and plugin.json`);
  return newVersion;
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  let bumpArg = process.argv[2];
  if (!bumpArg) {
    if (!process.stdin.isTTY) {
      console.error("Error: Missing version bump argument in non-interactive environment.");
      console.error("Usage: node scripts/release/update-version.mjs [patch|minor|major|X.Y.Z]");
      process.exit(1);
    }
    const pkg = JSON.parse(await readFile(path.join(root, "package.json"), "utf8"));
    bumpArg = await promptForVersion(pkg.version);
  }

  try {
    const newVersion = await updateVersion(bumpArg);
    console.log(`Version successfully updated to ${newVersion}`);
  } catch (err) {
    console.error(`Version update failed: ${err.message}`);
    process.exit(1);
  }
}
