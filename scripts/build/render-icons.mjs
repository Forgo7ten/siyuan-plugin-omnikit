import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Resvg } from "@resvg/resvg-js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const outputDir = path.join(root, ".generated");

async function renderPng(source, filename, width, height, maxBytes, font = { loadSystemFonts: false }) {
  const input = path.join(root, "assets", source);
  const svg = await readFile(input, "utf8");
  const rendered = new Resvg(svg, {
    fitTo: { mode: "width", value: width },
    font,
  }).render();
  const png = rendered.asPng();
  if (rendered.width !== width || rendered.height !== height) {
    throw new Error(`Expected a ${width}x${height} ${filename}, got ${rendered.width}x${rendered.height}`);
  }
  if (png.byteLength > maxBytes) {
    throw new Error(`${filename} exceeds ${maxBytes} bytes: ${png.byteLength}`);
  }
  const output = path.join(outputDir, filename);
  await writeFile(output, png);
  console.log(`Rendered ${input} -> ${output} (${png.byteLength} bytes, ${width}x${height})`);
}

await mkdir(outputDir, { recursive: true });
await renderPng("omnikit-plugin.svg", "icon.png", 160, 160, 64 * 1024);
await renderPng("omnikit-banner.svg", "preview.png", 1024, 768, 512 * 1024, {
  loadSystemFonts: true,
  sansSerifFamily: "Liberation Sans",
  defaultFontFamily: "Liberation Sans",
});
