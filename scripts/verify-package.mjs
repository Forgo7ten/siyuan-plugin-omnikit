import { existsSync, readFileSync, statSync } from "node:fs";
import assert from "node:assert/strict";

const required = [
  "dist/index.js", "dist/index.css", "dist/plugin.json",
  "dist/README.md", "dist/README.zh-CN.md",
  "dist/i18n/en.json", "dist/i18n/zh-CN.json",
  "dist/browser-image-compression.js", "dist/icon.png",
  "dist/assets/omnikit-menu.svg", "dist/assets/omnikit-plugin.svg", "package.zip",
];
for (const path of required) {
  assert.ok(existsSync(path), `Missing build artifact: ${path}`);
  assert.ok(statSync(path).size > 0, `Empty build artifact: ${path}`);
}
assert.ok(!existsSync("icon.png"), "icon.png is generated only as a build artifact");
const icon = readFileSync("dist/icon.png");
assert.deepEqual(icon.subarray(0, 8), Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
assert.equal(icon.readUInt32BE(16), 160, "marketplace icon width");
assert.equal(icon.readUInt32BE(20), 160, "marketplace icon height");
assert.ok(icon.byteLength <= 64 * 1024, "marketplace icon must be at most 64 KiB");
for (const readme of ["README.md", "README.zh-CN.md"]) {
  assert.match(readFileSync(readme, "utf8"), /assets\/omnikit-plugin\.svg/);
}
const pkg = JSON.parse(readFileSync("package.json", "utf8"));
const manifest = JSON.parse(readFileSync("dist/plugin.json", "utf8"));
assert.equal(manifest.name, "siyuan-plugin-omnikit");
assert.equal(pkg.version, manifest.version);
assert.equal(manifest.minAppVersion, "3.8.0");
for (const locale of ["en", "zh-CN"]) {
  JSON.parse(readFileSync(`dist/i18n/${locale}.json`, "utf8"));
}

// Inspect ZIP central-directory names without an additional runtime dependency.
const archive = readFileSync("package.zip");
let eocd = -1;
for (let offset = Math.max(0, archive.length - 22 - 0xffff); offset <= archive.length - 22; offset++) {
  if (archive.readUInt32LE(offset) === 0x06054b50) eocd = offset;
}
assert.notEqual(eocd, -1, "package.zip has no end-of-central-directory record");
const entryCount = archive.readUInt16LE(eocd + 10);
let cursor = archive.readUInt32LE(eocd + 16);
const zipEntries = [];
for (let index = 0; index < entryCount; index++) {
  assert.equal(archive.readUInt32LE(cursor), 0x02014b50, `Invalid ZIP entry ${index}`);
  const nameLength = archive.readUInt16LE(cursor + 28);
  const extraLength = archive.readUInt16LE(cursor + 30);
  const commentLength = archive.readUInt16LE(cursor + 32);
  zipEntries.push(archive.toString("utf8", cursor + 46, cursor + 46 + nameLength));
  cursor += 46 + nameLength + extraLength + commentLength;
}
for (const path of [
  "index.js", "index.css", "plugin.json", "i18n/en.json", "i18n/zh-CN.json",
  "browser-image-compression.js", "icon.png",
  "assets/omnikit-menu.svg", "assets/omnikit-plugin.svg",
]) {
  assert.ok(zipEntries.includes(path), `Missing package.zip entry: ${path}`);
}
assert.ok(!zipEntries.includes("kernel.js"), "package.zip must not contain the legacy kernel bundle");
assert.ok(!zipEntries.some(path => path.startsWith("node_modules/")), "package.zip must not contain node_modules");
console.log("OmniKit Vite build package structure verified (not an in-app runtime test)");
