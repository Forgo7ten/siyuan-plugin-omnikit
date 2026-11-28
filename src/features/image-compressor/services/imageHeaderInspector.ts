export interface ImageInfo {
  mime: "image/png" | "image/jpeg" | "image/webp";
  width: number;
  height: number;
  animated: boolean;
}

const text = (b: Uint8Array, at: number, n: number) => String.fromCharCode(...b.subarray(at, at + n));

export function inspectImage(b: Uint8Array): ImageInfo {
  const v = new DataView(b.buffer, b.byteOffset, b.byteLength);
  if ([137, 80, 78, 71, 13, 10, 26, 10].every((x, i) => b[i] === x)) {
    let p = 8, w = 0, h = 0, animated = false, data = false;
    while (p + 12 <= b.length) {
      const n = v.getUint32(p), tag = text(b, p + 4, 4);
      if (n > b.length - p - 12) throw new Error("Truncated PNG");
      if (!w && tag !== "IHDR") throw new Error("Missing PNG header");
      if (tag === "IHDR") {
        if (w || n !== 13) throw new Error("Invalid PNG header");
        w = v.getUint32(p + 8);
        h = v.getUint32(p + 12);
        if (!w || !h) throw new Error("Empty PNG dimensions");
      }
      if (["acTL", "fcTL", "fdAT"].includes(tag)) animated = true;
      if (tag === "IDAT" && n) data = true;
      if (tag === "IEND") {
        if (!data || n !== 0 || p + 12 !== b.length) throw new Error("Invalid PNG end");
        return { mime: "image/png", width: w, height: h, animated };
      }
      p += n + 12;
    }
    throw new Error("PNG is incomplete");
  }
  if (b.length >= 12 && text(b, 0, 4) === "RIFF" && text(b, 8, 4) === "WEBP") {
    if (v.getUint32(4, true) + 8 !== b.length) throw new Error("WebP length mismatch");
    let p = 12, w = 0, h = 0, animated = false, data = false;
    while (p + 8 <= b.length) {
      const tag = text(b, p, 4), n = v.getUint32(p + 4, true), q = p + 8;
      if (n > b.length - q) throw new Error("Truncated WebP");
      if (tag === "VP8X") {
        if (n !== 10) throw new Error("Invalid WebP extended header");
        animated ||= (b[q] & 2) !== 0;
        w = 1 + b[q + 4] + (b[q + 5] << 8) + (b[q + 6] << 16);
        h = 1 + b[q + 7] + (b[q + 8] << 8) + (b[q + 9] << 16);
      } else if (tag === "VP8 ") {
        if (n < 10 || text(b, q + 3, 3) !== "\x9d\x01\x2a") throw new Error("Invalid WebP frame");
        if (!w) { w = v.getUint16(q + 6, true) & 0x3fff; h = v.getUint16(q + 8, true) & 0x3fff; }
        data = true;
      } else if (tag === "VP8L") {
        if (n < 5 || b[q] !== 0x2f) throw new Error("Invalid lossless WebP frame");
        const bits = v.getUint32(q + 1, true);
        if (!w) { w = (bits & 0x3fff) + 1; h = ((bits >>> 14) & 0x3fff) + 1; }
        data = true;
      }
      if (tag === "ANIM" || tag === "ANMF") animated = true;
      p += 8 + n + (n & 1);
    }
    if (p !== b.length || !w || !h || (!data && !animated)) throw new Error("Invalid WebP");
    return { mime: "image/webp", width: w, height: h, animated };
  }
  if (b[0] === 255 && b[1] === 216) {
    let p = 2, w = 0, h = 0, orientation = 1;
    while (p + 1 < b.length) {
      if (b[p++] !== 255) throw new Error("Invalid JPEG marker");
      while (b[p] === 255) p++;
      const marker = b[p++];
      if (marker === 218 || marker === 217) break;
      if (marker === 1 || (marker >= 208 && marker <= 215)) continue;
      if (p + 2 > b.length) throw new Error("Truncated JPEG");
      const n = v.getUint16(p);
      if (n < 2 || n > b.length - p) throw new Error("Truncated JPEG segment");
      if (marker === 225 && n >= 14 && text(b, p + 2, 4) === "Exif" && b[p + 6] === 0 && b[p + 7] === 0) {
        const tiffStart = p + 8;
        const isLittle = b[tiffStart] === 0x49 && b[tiffStart + 1] === 0x49;
        const isBig = b[tiffStart] === 0x4d && b[tiffStart + 1] === 0x4d;
        if ((isLittle || isBig) && v.getUint16(tiffStart + 2, isLittle) === 42) {
          const ifdOffset = v.getUint32(tiffStart + 4, isLittle);
          if (ifdOffset >= 8 && tiffStart + ifdOffset + 2 <= b.length) {
            const entries = v.getUint16(tiffStart + ifdOffset, isLittle);
            for (let i = 0; i < entries; i++) {
              const entryPos = tiffStart + ifdOffset + 2 + i * 12;
              if (entryPos + 12 > b.length) break;
              const tag = v.getUint16(entryPos, isLittle);
              if (tag === 0x0112) {
                orientation = v.getUint16(entryPos + 8, isLittle);
                break;
              }
            }
          }
        }
      }
      if ([192, 193, 194].includes(marker)) {
        if (n < 8 || ![1, 3].includes(b[p + 7])) throw new Error("Unsupported JPEG colour components");
        h = v.getUint16(p + 3);
        w = v.getUint16(p + 5);
      }
      p += n;
    }
    if (!w || !h) throw new Error("Unsupported/incomplete JPEG");
    if (orientation >= 5 && orientation <= 8) {
      const temp = w;
      w = h;
      h = temp;
    }
    return { mime: "image/jpeg", width: w, height: h, animated: false };
  }
  throw new Error("Unsupported image signature; GIF/SVG/HEIF/AVIF are not converted by this engine");
}
