import { readFile } from "node:fs/promises";
import path from "node:path";
import { execSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const SEMVER_REGEX = /^[0-9]+\.[0-9]+\.[0-9]+$/;

function runStep(name, command) {
  console.log("\n========================================");
  console.log(`▶ Step: ${name}`);
  console.log(`  Running: ${command}`);
  console.log("========================================");
  try {
    execSync(command, { cwd: root, stdio: "inherit" });
  } catch {
    console.error(`\n✖ Step failed: ${name}`);
    process.exit(1);
  }
}

export async function verifyVersions(projectRoot = root) {
  console.log("\n========================================");
  console.log("▶ Step 1: Verify version consistency and format");
  console.log("========================================");

  const pkg = JSON.parse(await readFile(path.join(projectRoot, "package.json"), "utf8"));
  const manifest = JSON.parse(await readFile(path.join(projectRoot, "plugin.json"), "utf8"));

  if (!pkg.version || !SEMVER_REGEX.test(pkg.version)) {
    throw new Error(`package.json version "${pkg.version}" does not conform to SemVer X.Y.Z`);
  }
  if (!manifest.version || !SEMVER_REGEX.test(manifest.version)) {
    throw new Error(`plugin.json version "${manifest.version}" does not conform to SemVer X.Y.Z`);
  }
  if (pkg.version !== manifest.version) {
    throw new Error(`Version mismatch: package.json is ${pkg.version}, plugin.json is ${manifest.version}`);
  }

  console.log(`✔ Verified version ${pkg.version} across package.json and plugin.json`);
  return pkg.version;
}

export async function runReleasePipeline() {
  console.log("Starting OmniKit Local Release Pipeline...");

  // 1. Verify versions
  const version = await verifyVersions(root);
  const tag = `v${version}`;

  // 2. Type check
  runStep("2. Type and Svelte Check", "pnpm check");

  // 3. Tests
  runStep("3. Unit Tests", "pnpm test");

  // 4. Production build
  runStep("4. Production Build", "pnpm build:app");

  // 5. Package verify
  runStep("5. Package Verification", "node scripts/release/verify-package.mjs");

  // 6. Test package.zip archive integrity
  runStep("6. Archive Integrity Test", "unzip -t package.zip");

  // 7. Ready prompt & instructions
  console.log("\n================================================================");
  console.log("✔ All release verification steps completed successfully!");
  console.log(`  Release Tag: ${tag} (Version: ${version})`);
  console.log("================================================================");
  console.log("\nNext Steps for Deployment:");
  console.log("\nOption A: Manual Release via GitHub Actions (Recommended)");
  console.log("  1. Commit and push version updates:");
  console.log("     git add package.json plugin.json");
  console.log(`     git commit -m "chore(release): bump to ${version}"`);
  console.log("     git push origin main");
  console.log("  2. Navigate to GitHub Actions -> \"Release OmniKit\" -> \"Run workflow\"");
  console.log("\nOption B: Direct Tag Push");
  console.log("  1. Commit changes:");
  console.log("     git add package.json plugin.json");
  console.log(`     git commit -m "chore(release): bump to ${version}"`);
  console.log("  2. Tag and push:");
  console.log(`     git tag ${tag}`);
  console.log(`     git push origin ${tag}`);
  console.log("================================================================\n");
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  runReleasePipeline().catch(err => {
    console.error(`Release pipeline failed: ${err.message}`);
    process.exit(1);
  });
}
