import type { DesktopBridge, Downloaded, ReadOptions } from "./download.ts";
import { requireRemotePermission } from "./download.ts";

export type NodeRequire = (name: string) => any;

const MAX_REDIRECT_LOOP_GUARD = 20;

function abort(signal?: AbortSignal): void {
  if (signal?.aborted) throw new DOMException("Operation cancelled", "AbortError");
}

function sanitizedUserAgent(raw?: string): string | undefined {
  if (raw === undefined || raw === "") return undefined;
  if (raw.length > 256 || /[\r\n\u0000-\u001f\u007f]/.test(raw)) throw new Error("Invalid User-Agent");
  return raw;
}

/** Call only after desktop capability detection. Node built-ins are loaded only on demand. */
export function createDesktopBridge(load: NodeRequire): DesktopBridge {
  const https = load("node:https"), http = load("node:http");
  return {
    async download(raw: string, options: ReadOptions): Promise<Downloaded> {
      let current = requireRemotePermission(raw);
      const userAgent = sanitizedUserAgent(options.userAgent);
      const deadline = Date.now() + Math.max(1, options.timeoutMs);

      for (let redirects = 0; redirects <= MAX_REDIRECT_LOOP_GUARD; redirects++) {
        abort(options.signal);
        const remainingMs = deadline - Date.now();
        if (remainingMs <= 0) throw new Error("Download timed out");

        const result = await new Promise<{ blob?: Blob; location?: string }>((resolve, reject) => {
          let settled = false, response: any;
          const finish = (error?: unknown, value?: { blob?: Blob; location?: string }) => {
            if (settled) return;
            settled = true;
            options.signal?.removeEventListener("abort", onAbort);
            error ? reject(error) : resolve(value!);
          };
          const request = (current.protocol === "https:" ? https : http).request(current, {
            method: "GET",
            agent: false,
            headers: { Accept: "image/*", "Accept-Encoding": "identity", ...(userAgent ? { "User-Agent": userAgent } : {}) },
          }, (res: any) => {
            response = res;
            const status = res.statusCode ?? 0;
            if ([301, 302, 303, 307, 308].includes(status) && typeof res.headers.location === "string") {
              finish(undefined, { location: res.headers.location });
              res.destroy();
              return;
            }
            if (status < 200 || status >= 300) {
              finish(new Error(`Remote HTTP ${status}`));
              res.destroy();
              return;
            }
            if (res.headers["content-encoding"] && res.headers["content-encoding"] !== "identity") {
              finish(new Error("Unexpected compressed transfer"));
              res.destroy();
              return;
            }
            if (Number(res.headers["content-length"]) > options.maxBytes) {
              finish(new Error("Image exceeds byte limit"));
              res.destroy();
              return;
            }
            const chunks: Uint8Array[] = [];
            let size = 0;
            res.on("data", (chunk: Uint8Array) => {
              size += chunk.byteLength;
              if (size > options.maxBytes) {
                finish(new Error("Image exceeds byte limit"));
                res.destroy();
                request.destroy();
              } else {
                chunks.push(new Uint8Array(chunk));
              }
            });
            res.on("end", () => size ? finish(undefined, { blob: new Blob(chunks.map(chunk => chunk.slice().buffer as ArrayBuffer), { type: res.headers["content-type"]?.split(";")[0] || "" }) }) : finish(new Error("Empty response")));
            res.on("aborted", () => finish(new Error("Response aborted")));
            res.on("error", finish);
          });
          const onAbort = () => { finish(new DOMException("Cancelled", "AbortError")); response?.destroy(); request.destroy(); };
          options.signal?.addEventListener("abort", onAbort, { once: true });
          const timer = setTimeout(() => { finish(new Error("Download timed out")); request.destroy(); }, remainingMs);
          request.on("close", () => clearTimeout(timer));
          request.on("error", finish);
          if (options.signal?.aborted) onAbort(); else request.end();
        });
        if (result.location) {
          if (redirects === MAX_REDIRECT_LOOP_GUARD) throw new Error("Too many redirects");
          const next = new URL(result.location, current);
          current = requireRemotePermission(next.href);
          continue;
        }
        const fileName = current.pathname.split("/").pop() || "image";
        let decodedName = fileName;
        try {
          decodedName = decodeURIComponent(fileName);
        } catch {
          // Keep raw segment when percent-encoding is malformed
        }
        return { blob: result.blob!, name: decodedName };
      }
      throw new Error("Download did not complete");
    },
  };
}
