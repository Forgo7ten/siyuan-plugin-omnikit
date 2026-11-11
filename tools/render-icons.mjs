import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Resvg } from "@resvg/resvg-js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const input = path.join(root, "assets", "omnikit-plugin.svg");
const outputDir = path.join(root, ".generated");
const output = path.join(outputDir, "icon.png");
const svg = await readFile(input, "utf8");
const rendered = new Resvg(svg, {
  fitTo: { mode: "width", value: 160 },
  font: { loadSystemFonts: false },
}).render();
const png = rendered.asPng();

if (rendered.width !== 160 || rendered.height !== 160) {
  throw new Error(`Expected a 160x160 plugin icon, got ${rendered.width}x${rendered.height}`);
}
if (png.byteLength > 64 * 1024) {
  throw new Error(`Plugin icon exceeds 64 KiB: ${png.byteLength}`);
}

await mkdir(outputDir, { recursive: true });
await writeFile(output, png);
console.log(`Rendered ${input} -> ${output} (${png.byteLength} bytes, 160x160)`);
