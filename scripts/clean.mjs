import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

export function cleanArtifacts(projectRoot = root, { log = console.log } = {}) {
  const targets = ["dist", ".generated", "package.zip"];
  const removed = [];

  for (const target of targets) {
    const fullPath = path.resolve(projectRoot, target);
    if (fs.existsSync(fullPath)) {
      fs.rmSync(fullPath, { recursive: true, force: true });
      removed.push(target);
      log(`Removed: ${target}`);
    }
  }

  return removed;
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  cleanArtifacts();
}
