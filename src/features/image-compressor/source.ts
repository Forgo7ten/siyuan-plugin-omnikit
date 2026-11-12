export type ImageSource =
  | { kind: "asset"; raw: string; key: string; path: string; fetchURL: string; box?: string; name: string }
  | { kind: "remote"; raw: string; key: string; url: string; name: string }
  | { kind: "file"; raw: string; key: string; fileURL: string; name: string };
const ID = /^\d{14}-[a-z0-9]{7}$/;
function segment(value: string): string {
  const decoded = decodeURIComponent(value);
  if (!decoded || decoded === "." || decoded === ".." || /[\/\\\u0000-\u001f]/.test(decoded)) throw new Error("Unsafe path segment");
  return encodeURIComponent(decoded);
}
function nameOf(path: string): string { const value = path.replace(/\\/g, "/").split("/").pop() || "image"; try { return decodeURIComponent(value); } catch { return value; } }
function asset(raw: string, origin: string): ImageSource {
  const path = raw.split(/[?#]/)[0].replace(/^\.?\//, "");
  if (!path.startsWith("assets/")) throw new Error("Not an asset path");
  const canonical = path.split("/").map(segment).join("/");
  const u = new URL(raw.replace(/^\.\//, "/").replace(/^assets\//, "/assets/"), origin);
  if (u.hash || [...u.searchParams.keys()].some(key => key !== "box") || u.searchParams.getAll("box").length > 1) throw new Error("Unsupported asset URL suffix");
  const box = u.searchParams.get("box") || undefined;
  if (box && !ID.test(box)) throw new Error("Invalid asset notebook");
  const suffix = box ? `?box=${box}` : "";
  return { kind: "asset", raw, key: `asset:${canonical}${suffix}`, path: canonical, fetchURL: new URL(`/${canonical}${suffix}`, origin).href, box, name: nameOf(path) };
}
export function resolveSource(raw: string, kernelOrigin: string): ImageSource {
  if (!raw || raw !== raw.trim() || /[\u0000-\u001f]/.test(raw)) throw new Error("Invalid image source");
  if (/^(?:\.\\)?assets\\/.test(raw)) return asset(raw.replace(/\\/g, "/"), kernelOrigin);
  if (/^(?:\.\/*)?assets\//.test(raw) || /^\/assets\//.test(raw)) return asset(raw, kernelOrigin);
  if (/^[a-zA-Z]:[\\/]/.test(raw) || /^file:/i.test(raw) || /^\\\\/.test(raw) || raw.startsWith("/") && !raw.startsWith("//")) {
    if (/^\\\\/.test(raw)) throw new Error("UNC/network file reads are disabled");
    let u: URL;
    if (/^[a-zA-Z]:[\\/]/.test(raw)) u = new URL(`file:///${raw.replace(/\\/g, "/").split("/").map((part, i) => i ? encodeURIComponent(part) : part.toUpperCase()).join("/")}`);
    else if (raw.startsWith("/")) u = new URL("file://" + raw.split("/").map(encodeURIComponent).join("/"));
    else { const normalized = raw.replace(/^file:\/\/([a-zA-Z]:[\\/])/i, "file:///$1").replace(/\\/g, "/"); if (/%(?:2f|5c|00)/i.test(normalized)) throw new Error("Encoded file separator refused"); u = new URL(normalized); }
    if (u.protocol !== "file:" || u.search || u.hash || u.username || u.password || u.hostname && u.hostname !== "localhost") throw new Error("Invalid or network file URL");
    return { kind: "file", raw, key: `file:${u.href}`, fileURL: u.href, name: nameOf(u.pathname) };
  }
  const u = new URL(raw.startsWith("//") ? `https:${raw}` : raw);
  if (u.origin === kernelOrigin && u.pathname.startsWith("/assets/")) return asset(u.pathname + u.search + u.hash, kernelOrigin);
  if (!["https:", "http:"].includes(u.protocol) || u.username || u.password) throw new Error("Only HTTP(S) image links are supported");
  return { kind: "remote", raw, key: `remote:${u.href}`, url: u.href, name: nameOf(u.pathname) };
}
export function trySource(raw: string, origin: string): ImageSource | undefined { try { return resolveSource(raw, origin); } catch { return undefined; } }
export function outputName(sourceName: string): string {
  const base = sourceName.replace(/\\/g, "/").split("/").pop() || "image";
  const stem = base.replace(/\.[a-zA-Z0-9]{1,10}$/, "").replace(/[\u0000-\u001f<>:"/\\|?*]/g, "_").replace(/[. ]+$/, "") || "image";
  return Array.from(stem).slice(0, 120).join("") + ".webp";
}
export function imageSourceAttribute(image: HTMLImageElement): string | undefined { return (image.hasAttribute("data-src") ? image.getAttribute("data-src") : image.getAttribute("src")) || undefined; }
