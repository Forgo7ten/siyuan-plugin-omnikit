import type { ImageSource } from "./source.ts";
export interface Downloaded { blob: Blob; name: string }
export interface ReadOptions {
  maxBytes: number;
  timeoutMs: number;
  signal?: AbortSignal;
  allowedOrigins?: ReadonlySet<string>;
  providedFiles?: ReadonlyMap<string, File>;
}
export interface DesktopBridge {
  readFile(fileURL: string, options: ReadOptions): Promise<Downloaded>;
  download(url: string, options: ReadOptions): Promise<Downloaded>;
}
function abort(signal?: AbortSignal): void {
  if (signal?.aborted) throw new DOMException("Operation cancelled", "AbortError");
}
export function requireRemotePermission(raw: string, _origins?: ReadonlySet<string>): URL {
  const u = new URL(raw);
  if (!["https:", "http:"].includes(u.protocol) || u.username || u.password) {
    throw new Error("Only HTTP(S) image links are supported");
  }
  return u;
}
export async function boundedResponse(response: Response, limit: number, signal?: AbortSignal): Promise<Blob> {
  if (!response.ok || !response.body) throw new Error(`Image download failed: HTTP ${response.status}`);
  const declared = response.headers.get("content-length");
  if (declared && Number(declared) > limit) { await response.body.cancel(); throw new Error("Image exceeds byte limit"); }
  const reader = response.body.getReader(), chunks: Uint8Array[] = []; let size = 0;
  const cancel = () => { void reader.cancel().catch(() => undefined); };
  signal?.addEventListener("abort", cancel, { once: true });
  try {
    for (;;) { abort(signal); const { done, value } = await reader.read(); abort(signal); if (done) break; size += value.byteLength; if (size > limit) throw new Error("Image exceeds byte limit"); chunks.push(value); }
    if (!size) throw new Error("Empty download");
    return new Blob(chunks.map(chunk => chunk.slice().buffer as ArrayBuffer), { type: response.headers.get("content-type")?.split(";")[0] || "" });
  } catch (error) { await reader.cancel().catch(() => undefined); throw error; }
  finally { signal?.removeEventListener("abort", cancel); reader.releaseLock(); }
}
export class SourceReader {
  constructor(private readonly fetcher: typeof fetch = fetch, private readonly desktop?: DesktopBridge) {}
  async read(source: ImageSource, options: ReadOptions): Promise<Downloaded> {
    abort(options.signal);
    const provided = options.providedFiles?.get(source.key);
    if (provided) { if (provided.size > options.maxBytes) throw new Error("Selected file exceeds byte limit"); return { blob: provided, name: provided.name }; }
    if (source.kind === "file") { if (!this.desktop) throw new Error("This frontend cannot read a computer path; select the image file instead"); return this.desktop.readFile(source.fileURL, options); }
    if (source.kind === "remote") {
      requireRemotePermission(source.url);
      if (this.desktop) return this.desktop.download(source.url, options);
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new Error("Download timed out")), options.timeoutMs);
    const relay = () => controller.abort(options.signal?.reason);
    options.signal?.addEventListener("abort", relay, { once: true });
    try {
      const url = source.kind === "asset" ? source.fetchURL : source.url;
      const response = await this.fetcher(url, { credentials: source.kind === "asset" ? "same-origin" : "omit", referrerPolicy: "no-referrer", redirect: "error", signal: controller.signal });
      return { blob: await boundedResponse(response, options.maxBytes, controller.signal), name: source.name };
    } finally { clearTimeout(timer); options.signal?.removeEventListener("abort", relay); }
  }
}
