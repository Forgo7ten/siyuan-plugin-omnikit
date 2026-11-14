import { randomUUID } from "node:crypto";
import { access, copyFile, lstat, mkdir, readFile, realpath, rename, rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const pluginName = "siyuan-plugin-omnikit";
const scriptPath = fileURLToPath(import.meta.url);
const sourceDir = path.resolve(path.dirname(scriptPath), "../dist");
const requiredFiles = [
  "plugin.json",
  "index.js",
  "index.css",
  "icon.png",
  "README.md",
  "README.zh-CN.md",
  "browser-image-compression.js",
];
const requiredAssets = [
  "assets/omnikit-plugin.svg",
  "assets/omnikit-menu.svg",
  "i18n/en.json",
  "i18n/zh-CN.json",
];

async function requireRealDirectory(target, workspaceRoot) {
  const info = await lstat(target).catch(() => null);
  if (!info?.isDirectory() || info.isSymbolicLink()) {
    throw new Error(`required real directory is missing or is a symlink: ${target}`);
  }
  const resolved = await realpath(target);
  const relative = path.relative(workspaceRoot, resolved);
  if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error(`path resolves outside the workspace: ${target} -> ${resolved}`);
  }
  return resolved;
}

async function readPluginManifest(directory) {
  try {
    return JSON.parse(await readFile(path.join(directory, "plugin.json"), "utf8"));
  } catch {
    return null;
  }
}

export async function installWorkspace(workspaceArg, { buildDir = sourceDir, log = console.log } = {}) {
  if (!workspaceArg) {
    throw new Error('pass the SiYuan workspace root, for example: pnpm run install:workspace -- "C:\\Users\\name\\siyuan"');
  }

  let stagePath;
  let backupPath;
  let targetDir;
  let backedUpExisting = false;
  let published = false;

  try {
    const requestedWorkspace = path.resolve(workspaceArg);
    const workspaceInfo = await lstat(requestedWorkspace).catch(() => null);
    if (!workspaceInfo?.isDirectory() || workspaceInfo.isSymbolicLink()) {
      throw new Error(`workspace root is not a real directory: ${requestedWorkspace}`);
    }
    const workspace = await realpath(requestedWorkspace);
    await requireRealDirectory(path.join(workspace, "conf"), workspace);
    const dataDir = await requireRealDirectory(path.join(workspace, "data"), workspace);
    await requireRealDirectory(path.join(dataDir, ".siyuan"), workspace);
    const pluginsDir = await requireRealDirectory(path.join(dataDir, "plugins"), workspace);

    targetDir = path.join(pluginsDir, pluginName);
    const targetInfo = await lstat(targetDir).catch(error => error.code === "ENOENT" ? null : Promise.reject(error));
    if (targetInfo?.isSymbolicLink()) throw new Error(`refusing symlink plugin target: ${targetDir}`);
    if (targetInfo && !targetInfo.isDirectory()) throw new Error(`plugin target exists and is not a directory: ${targetDir}`);
    if (targetInfo) {
      const installedManifest = await readPluginManifest(targetDir);
      if (installedManifest?.name !== pluginName) {
        throw new Error(`existing target does not identify as ${pluginName}; left untouched: ${targetDir}`);
      }
    }

    for (const file of [...requiredFiles, ...requiredAssets]) {
      await access(path.join(buildDir, file)).catch(() => {
        throw new Error(`build is missing ${file}; run pnpm build first: ${buildDir}`);
      });
    }
    const builtManifest = await readPluginManifest(buildDir);
    if (builtManifest?.name !== pluginName) throw new Error(`build manifest does not identify as ${pluginName}`);

    const suffix = `${Date.now()}-${randomUUID()}`;
    stagePath = path.join(pluginsDir, `.${pluginName}.install-${suffix}`);
    await mkdir(stagePath);
    for (const file of requiredFiles) await copyFile(path.join(buildDir, file), path.join(stagePath, file));
    for (const directory of ["assets", "i18n"]) await mkdir(path.join(stagePath, directory));
    for (const file of requiredAssets) await copyFile(path.join(buildDir, file), path.join(stagePath, file));

    if (targetInfo) {
      backupPath = path.join(pluginsDir, `${pluginName}.backup-${suffix}`);
      await rename(targetDir, backupPath);
      backedUpExisting = true;
    }
    await rename(stagePath, targetDir);
    stagePath = undefined;
    published = true;

    log(`Installed ${pluginName} to: ${targetDir}`);
    if (backupPath) log(`Previous plugin preserved at: ${backupPath}`);
    log("Reload the plugin in SiYuan's plugin manager, or restart SiYuan to load it.");
  } catch (error) {
    if (stagePath) await rm(stagePath, { recursive: true, force: true }).catch(() => {});
    if (backedUpExisting && !published) {
      await rename(backupPath, targetDir).catch(restoreError => {
        log(`Restore failed; the previous plugin remains at ${backupPath}: ${restoreError.message}`);
      });
    }
    throw error;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(scriptPath)) {
  installWorkspace(process.argv[2]).catch(error => {
    console.error(`Install failed: ${error.message}`);
    process.exitCode = 1;
  });
}
