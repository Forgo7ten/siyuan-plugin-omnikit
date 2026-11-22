import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Resvg } from "@resvg/resvg-js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const input = path.join(root, "assets", "omnikit-plugin.svg");
const outputDir = path.join(root, ".generated");
const svg = await readFile(input, "utf8");

async function renderSquarePng(filename, size, maxBytes) {
  const rendered = new Resvg(svg, {
    fitTo: { mode: "width", value: size },
    font: { loadSystemFonts: false },
  }).render();
  const png = rendered.asPng();
  if (rendered.width !== size || rendered.height !== size) {
    throw new Error(`Expected a ${size}x${size} ${filename}, got ${rendered.width}x${rendered.height}`);
  }
  if (png.byteLength > maxBytes) {
    throw new Error(`${filename} exceeds ${maxBytes} bytes: ${png.byteLength}`);
  }
  const output = path.join(outputDir, filename);
  await writeFile(output, png);
  console.log(`Rendered ${input} -> ${output} (${png.byteLength} bytes, ${size}x${size})`);
}

await mkdir(outputDir, { recursive: true });
await renderSquarePng("icon.png", 160, 64 * 1024);
await renderSquarePng("preview.png", 512, 256 * 1024);
