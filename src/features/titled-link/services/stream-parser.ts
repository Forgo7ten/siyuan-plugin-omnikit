import type { TitleResource } from "./dual-track-fetcher.ts";

export interface DecodedTitleResource {
  readonly html: string;
  readonly charset: string;
  readonly bytesRead: number;
  readonly truncated: boolean;
}

export interface ReadTitleResourceOptions {
  readonly signal?: AbortSignal;
  readonly maxBytes?: number;
  readonly logger?: { debug?(message: string, data?: unknown): void };
}

const DEFAULT_MAX_BYTES = 64 * 1024;
const OVERLAP_TAIL_CHARS = 64;
// Stop only at </head> so <meta property="og:title"> / twitter:title after an empty <title></title> are preserved.
const HEAD_END_PATTERN = /<\/head\s*>/i;
const LATIN1_DECODER = new TextDecoder("latin1");

export async function readAndDecodeTitleResource(
  resource: TitleResource,
  options: ReadTitleResourceOptions = {},
): Promise<DecodedTitleResource> {
  throwIfAborted(options.signal);
  if (resource.body instanceof Uint8Array) {
    const bytes = resource.body.subarray(0, maxBytes(options.maxBytes));
    return decodeHtmlBytes(bytes, resource.contentType, resource.body.byteLength > bytes.byteLength);
  }
  return readAndDecodeStream(resource.body, resource.contentType, options);
}

export async function readAndDecodeStream(
  stream: ReadableStream<Uint8Array>,
  contentType = "",
  options: ReadTitleResourceOptions = {},
): Promise<DecodedTitleResource> {
  throwIfAborted(options.signal);
  const reader = stream.getReader();
  const limit = maxBytes(options.maxBytes);
  const chunks: Uint8Array[] = [];
  let total = 0;
  let tail = "";
  let truncated = false;
  const onAbort = () => {
    void reader.cancel(options.signal?.reason).catch(() => undefined);
  };
  options.signal?.addEventListener("abort", onAbort, { once: true });

  try {
    while (total < limit) {
      throwIfAborted(options.signal);
      const result = await reader.read();
      throwIfAborted(options.signal);
      if (result.done) break;
      const remaining = limit - total;
      const chunk = result.value.subarray(0, remaining);
      chunks.push(chunk);
      total += chunk.byteLength;

      const windowText = tail + LATIN1_DECODER.decode(chunk);
      if (HEAD_END_PATTERN.test(windowText)) {
        truncated = true;
        options.logger?.debug?.("流式读取命中 </head> 提前停止", { bytesRead: total });
        await reader.cancel("HTML head closed");
        break;
      }
      tail = windowText.length > OVERLAP_TAIL_CHARS
        ? windowText.slice(-OVERLAP_TAIL_CHARS)
        : windowText;

      if (total >= limit) {
        truncated = true;
        options.logger?.debug?.("流式读取达到字节上限截断", { bytesRead: total, limit });
        await reader.cancel("HTML read limit reached");
        break;
      }
    }
    return decodeHtmlBytes(concatenate(chunks, total), contentType, truncated);
  } catch (error) {
    await reader.cancel(error).catch(() => undefined);
    throw error;
  } finally {
    options.signal?.removeEventListener("abort", onAbort);
    reader.releaseLock();
  }
}

export function decodeHtmlBytes(bytes: Uint8Array, contentType = "", truncated = false): DecodedTitleResource {
  const charset = sniffCharset(bytes, contentType);
  let decoder: TextDecoder;
  try {
    decoder = new TextDecoder(charset);
  } catch {
    decoder = new TextDecoder("utf-8");
  }
  return {
    html: decoder.decode(bytes),
    charset: decoder.encoding,
    bytesRead: bytes.byteLength,
    truncated,
  };
}

export function sniffCharset(bytes: Uint8Array, contentType = ""): string {
  const header = contentType.match(/charset\s*=\s*["']?\s*([^\s;"']+)/i)?.[1];
  if (header) return normalizeCharset(header);
  const prefix = LATIN1_DECODER.decode(bytes.subarray(0, Math.min(bytes.byteLength, 8 * 1024)));
  const directMeta = prefix.match(/<meta\b[^>]*\bcharset\s*=\s*["']?\s*([^\s;"'/>]+)/i)?.[1];
  if (directMeta) return normalizeCharset(directMeta);
  const httpEquiv = prefix.match(/<meta\b[^>]*\bcontent\s*=\s*["'][^"']*charset\s*=\s*([^\s;"']+)/i)?.[1];
  return normalizeCharset(httpEquiv ?? "utf-8");
}

function normalizeCharset(value: string): string {
  const normalized = value.trim().toLowerCase();
  if (normalized === "gb2312") return "gbk";
  if (normalized === "utf8") return "utf-8";
  return normalized;
}

function concatenate(chunks: readonly Uint8Array[], total: number): Uint8Array {
  const result = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return result;
}

function maxBytes(value?: number): number {
  return Number.isInteger(value) && (value ?? 0) > 0 ? value! : DEFAULT_MAX_BYTES;
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw signal.reason ?? new DOMException("Operation cancelled", "AbortError");
}
