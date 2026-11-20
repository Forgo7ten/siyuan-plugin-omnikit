export interface AssetAddress {
  readonly raw: string;
  readonly kernelPath: string;
  readonly key: string;
  readonly fetchURL: string;
  readonly box?: string;
}

export type ImageSource =
  | (AssetAddress & { kind: "asset"; path: string; name: string })
  | { kind: "remote"; raw: string; key: string; url: string; name: string }
  | { kind: "file"; raw: string; key: string; fileURL: string; name: string };

const ID = /^\d{14}-[a-z0-9]{7}$/;

function validateLiteralSegment(value: string): string {
  if (!value || value === "." || value === ".." || /[\/\\\u0000-\u001f\u007f]/.test(value)) {
    throw new Error("Unsafe path segment");
  }
  return value;
}

function decodeUrlSegment(value: string): string {
  let decoded: string;
  try {
    decoded = decodeURIComponent(value);
  } catch {
    throw new Error("Invalid encoded asset segment");
  }
  return validateLiteralSegment(decoded);
}

function nameOf(path: string): string {
  const value = path.replace(/\\/g, "/").split("/").pop() || "image";
  return value;
}

function urlNameOf(pathname: string): string {
  const value = pathname.replace(/\\/g, "/").split("/").pop() || "image";
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function parseAssetParts(input: string): { pathPart: string; queryPart: string; hashPart: string } {
  const hashIdx = input.indexOf("#");
  const beforeHash = hashIdx >= 0 ? input.slice(0, hashIdx) : input;
  const hashPart = hashIdx >= 0 ? input.slice(hashIdx) : "";
  const queryIdx = beforeHash.indexOf("?");
  const pathPart = queryIdx >= 0 ? beforeHash.slice(0, queryIdx) : beforeHash;
  const queryPart = queryIdx >= 0 ? beforeHash.slice(queryIdx + 1) : "";
  return { pathPart, queryPart, hashPart };
}

function asset(raw: string, origin: string, input: string, decodePathname: boolean): Extract<ImageSource, { kind: "asset" }> {
  const { pathPart, queryPart } = parseAssetParts(input);
  const stripped = pathPart.replace(/^\.\//, "").replace(/^\/+/, "");
  if (!stripped.startsWith("assets/")) throw new Error("Not an asset path");
  const rawSegments = stripped.slice("assets/".length).split("/");
  if (!rawSegments.length) throw new Error("Unsafe path segment");
  const literalSegments = rawSegments.map(seg => decodePathname ? decodeUrlSegment(seg) : validateLiteralSegment(seg));
  const literalPath = `assets/${literalSegments.join("/")}`;

  const params = new URLSearchParams(queryPart);
  const boxes = params.getAll("box");
  if (boxes.length > 1) throw new Error("Invalid asset notebook");
  let box: string | undefined;
  if (params.has("box")) {
    box = boxes[0];
    if (!box || !ID.test(box)) throw new Error("Invalid asset notebook");
  }

  const suffix = box ? `?box=${box}` : "";
  const kernelPath = `${literalPath}${suffix}`;
  const encodedPath = `assets/${literalSegments.map(encodeURIComponent).join("/")}`;
  return {
    kind: "asset",
    raw,
    key: `asset:${kernelPath}`,
    path: literalPath,
    kernelPath,
    fetchURL: new URL(`/${encodedPath}${suffix}`, origin).href,
    box,
    name: literalSegments[literalSegments.length - 1] || "image",
  };
}

export function resolveSource(raw: string, kernelOrigin: string): ImageSource {
  if (!raw || raw !== raw.trim() || /[\u0000-\u001f\u007f]/.test(raw)) throw new Error("Invalid image source");
  if (/^(?:\.\\)?assets\\/.test(raw)) return asset(raw, kernelOrigin, raw.replace(/\\/g, "/"), false);
  if (/^(?:\.\/*)?assets\//.test(raw) || /^\/assets\//.test(raw)) return asset(raw, kernelOrigin, raw, false);
  if (/^[a-zA-Z]:[\\/]/.test(raw) || /^file:/i.test(raw) || /^\\\\/.test(raw) || raw.startsWith("/") && !raw.startsWith("//")) {
    if (/^\\\\/.test(raw)) throw new Error("UNC/network file reads are disabled");
    let u: URL;
    if (/^[a-zA-Z]:[\\/]/.test(raw)) u = new URL(`file:///${raw.replace(/\\/g, "/").split("/").map((part, i) => i ? encodeURIComponent(part) : part.toUpperCase()).join("/")}`);
    else if (raw.startsWith("/")) u = new URL("file://" + raw.split("/").map(encodeURIComponent).join("/"));
    else { const normalized = raw.replace(/^file:\/\/([a-zA-Z]:[\\/])/i, "file:///$1").replace(/\\/g, "/"); if (/%(?:2f|5c|00)/i.test(normalized)) throw new Error("Encoded file separator refused"); u = new URL(normalized); }
    if (u.protocol !== "file:" || u.search || u.hash || u.username || u.password || u.hostname && u.hostname !== "localhost") throw new Error("Invalid or network file URL");
    return { kind: "file", raw, key: `file:${u.href}`, fileURL: u.href, name: urlNameOf(u.pathname) };
  }
  const u = new URL(raw.startsWith("//") ? `https:${raw}` : raw);
  if (u.origin === kernelOrigin && u.pathname.startsWith("/assets/")) return asset(raw, kernelOrigin, u.pathname + u.search + u.hash, true);
  if (!["https:", "http:"].includes(u.protocol) || u.username || u.password) throw new Error("Only HTTP(S) image links are supported");
  return { kind: "remote", raw, key: `remote:${u.href}`, url: u.href, name: urlNameOf(u.pathname) };
}

export function trySource(raw: string, origin: string): ImageSource | undefined {
  try { return resolveSource(raw, origin); } catch { return undefined; }
}

/** Compares two raw asset strings by physical kernel identity (case-sensitive literal path + box). */
export function sameAsset(left: string, right: string, origin: string): boolean {
  const a = trySource(left, origin);
  const b = trySource(right, origin);
  return Boolean(a && b && a.kind === "asset" && b.kind === "asset" && a.key === b.key);
}

/**
 * Builds the DOM replacement attribute value for a new kernel asset path while
 * preserving decorative query params (e.g. `?width=`) and `#fragment` from `oldRaw`,
 * and never copying a stale `box` from `oldRaw` or dropping `newKernelPath`'s `box`.
 */
export function buildReplacementPath(oldRaw: string, newKernelPath: string, origin: string): string {
  const next = resolveSource(newKernelPath, origin);
  if (next.kind !== "asset") throw new Error("Replacement path must be an asset");
  let normalizedOld = oldRaw;
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(oldRaw)) {
    try {
      const u = new URL(oldRaw);
      normalizedOld = `${u.pathname}${u.search}${u.hash}`;
    } catch {
      normalizedOld = oldRaw;
    }
  }
  const { queryPart, hashPart } = parseAssetParts(normalizedOld.replace(/\\/g, "/"));
  const decorativeParams = queryPart
    ? queryPart.split("&").filter(part => part.length > 0 && !/^box(?:=|$)/i.test(part))
    : [];
  const allParams = [
    ...(next.box ? [`box=${next.box}`] : []),
    ...decorativeParams,
  ];
  const query = allParams.length > 0 ? `?${allParams.join("&")}` : "";
  return `${next.path}${query}${hashPart}`;
}

export function outputName(sourceName: string): string {
  const base = nameOf(sourceName);
  const stem = base.replace(/\.[a-zA-Z0-9]{1,10}$/, "").replace(/[\u0000-\u001f<>:"/\\|?*]/g, "_").replace(/[. ]+$/, "") || "image";
  return Array.from(stem).slice(0, 120).join("") + ".webp";
}

export function imageSourceAttribute(image: HTMLImageElement): string | undefined {
  return (image.hasAttribute("data-src") ? image.getAttribute("data-src") : image.getAttribute("src")) || undefined;
}
