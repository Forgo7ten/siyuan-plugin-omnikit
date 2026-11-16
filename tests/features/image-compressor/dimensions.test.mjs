import { test } from "node:test";
import assert from "node:assert/strict";
import { BicEncoder } from "../../../src/features/image-compressor/services/image.ts";
import { defaultImageFeatureConfig } from "../../../src/features/image-compressor/policy/parseImageConfig.ts";

function png(width, height) {
  const b = new Uint8Array(58);
  b.set([137, 80, 78, 71, 13, 10, 26, 10]);
  const view = new DataView(b.buffer);
  view.setUint32(8, 13); b.set([73, 72, 68, 82], 12);
  view.setUint32(16, width); view.setUint32(20, height);
  view.setUint32(33, 1); b.set([73, 68, 65, 84], 37);
  b.set([73, 69, 78, 68], 50);
  return new Blob([b], { type: "image/png" });
}

function webp(width, height) {
  const b = new Uint8Array(48);
  const view = new DataView(b.buffer);
  b.set(Buffer.from("RIFF"), 0); view.setUint32(4, 40, true); b.set(Buffer.from("WEBP"), 8);
  b.set(Buffer.from("VP8X"), 12); view.setUint32(16, 10, true);
  let value = width - 1;
  b[24] = value & 255; b[25] = value >> 8 & 255; b[26] = value >> 16 & 255;
  value = height - 1;
  b[27] = value & 255; b[28] = value >> 8 & 255; b[29] = value >> 16 & 255;
  b.set(Buffer.from("VP8 "), 30); view.setUint32(34, 10, true);
  b.set([0x9d, 0x01, 0x2a], 41);
  view.setUint16(44, width, true); view.setUint16(46, height, true);
  return new Blob([b], { type: "image/webp" });
}

function config() {
  const value = defaultImageFeatureConfig();
  value.compression.minInputBytes = 0;
  value.compression.minSavingBytes = 0;
  value.compression.minSavingRatio = 0;
  return value;
}

test("automatic mode keeps exact source dimensions even above manual edge", async () => {
  let options;
  const encoder = new BicEncoder(async (_file, received) => { options = received; return webp(5000, 2500); },
    "worker.js", async () => ({ width: 5000, height: 2500 }));
  const result = await encoder.encode(png(5000, 2500), "photo.png", config(), undefined, undefined, "auto");
  assert.equal(result.kind, "encoded");
  assert.equal(options.maxWidthOrHeight, 5000);
  assert.equal(options.alwaysKeepResolution, true);
});

test("manual dialog scales proportionally and rejects wrong output dimensions", async () => {
  let options;
  const encoder = new BicEncoder(async (_file, received) => { options = received; return webp(4096, 2048); },
    "worker.js", async () => ({ width: 4096, height: 2048 }));
  const result = await encoder.encode(png(5000, 2500), "photo.png", config(), undefined, undefined, "manual-dialog");
  assert.equal(result.kind, "encoded");
  assert.equal(options.maxWidthOrHeight, 4096);
  assert.equal(options.alwaysKeepResolution, false);

  const bad = new BicEncoder(async () => webp(4096, 2000), "worker.js", async () => ({ width: 4096, height: 2000 }));
  await assert.rejects(bad.encode(png(5000, 2500), "photo.png", config(), undefined, undefined, "manual-dialog"),
    /Unexpected output dimensions/);
});

test("inspectImage extracts EXIF orientation and swaps dimensions correctly", async () => {
  const { inspectImage } = await import("../../../src/features/image-compressor/services/image.ts");
  const bytes = new Uint8Array([
    0xFF, 0xD8, // SOI
    // APP1 Exif segment
    0xFF, 0xE1, 0x00, 0x22, // Length: 34
    0x45, 0x78, 0x69, 0x66, 0x00, 0x00, // Exif\0\0
    0x49, 0x49, // Little endian
    0x2A, 0x00, // 42
    0x08, 0x00, 0x00, 0x00, // Offset to 0th IFD (8)
    0x01, 0x00, // 1 entry
    0x12, 0x01, // Tag: 0x0112 (Orientation)
    0x03, 0x00, // Type: SHORT (3)
    0x01, 0x00, 0x00, 0x00, // Count: 1
    0x06, 0x00, 0x00, 0x00, // Value: 6 (rotate 90 CW)
    0x00, 0x00, 0x00, 0x00, // Next IFD: 0
    // SOF0 (Baseline DCT)
    0xFF, 0xC0, 0x00, 0x0B,
    0x08, // 8-bit precision
    0x05, 0xDC, // Height: 1500
    0x0B, 0xB8, // Width: 3000
    0x01, // 1 component
    0x01, 0x11, 0x00,
    // EOI
    0xFF, 0xD9,
  ]);
  const info = inspectImage(bytes);
  assert.equal(info.mime, "image/jpeg");
  // Due to orientation 6, effective width and height are swapped
  assert.equal(info.width, 1500);
  assert.equal(info.height, 3000);
});
