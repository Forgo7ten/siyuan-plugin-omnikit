import type { DesktopBridge, Downloaded, ReadOptions } from "./download.ts";
import { requireRemotePermission } from "./download.ts";
export type NodeRequire = (name: string) => any;
export type LocalConsent = (realPath: string) => Promise<boolean>;
function abort(signal?: AbortSignal): void { if (signal?.aborted) throw new DOMException("Operation cancelled", "AbortError"); }
function publicIPv4(address: string): boolean {
  const p = address.split(".").map(Number); if (p.length !== 4 || p.some(x => !Number.isInteger(x) || x < 0 || x > 255)) return false;
  const [a, b, c] = p;
  return !(a === 0 || a === 10 || a === 127 || a >= 224 || a === 100 && b >= 64 && b <= 127 || a === 169 && b === 254 || a === 172 && b >= 16 && b <= 31 || a === 192 && (b === 168 || b === 0 && (c === 0 || c === 2) || b === 88 && c === 99) || a === 198 && (b === 18 || b === 19 || b === 51 && c === 100) || a === 203 && b === 0 && c === 113);
}
/** Call only after desktop capability detection. Node built-ins are loaded only on demand. */
export function createDesktopBridge(load: NodeRequire, approve: LocalConsent): DesktopBridge {
  const fs = load("node:fs/promises"), url = load("node:url"), dns = load("node:dns/promises"), https = load("node:https"), http = load("node:http");
  return {
    async readFile(fileURL: string, options: ReadOptions): Promise<Downloaded> {
      const u = new URL(fileURL); if (u.protocol !== "file:" || u.host && u.host !== "localhost" || u.search || u.hash) throw new Error("Invalid or network file URL");
      const real: string = await fs.realpath(url.fileURLToPath(u)); abort(options.signal);
      if (!await approve(real)) throw new Error("Local file read not authorised"); abort(options.signal);
      const handle = await fs.open(real, "r"), controller = new AbortController();
      const relay = () => controller.abort(options.signal?.reason);
      options.signal?.addEventListener("abort", relay, { once: true });
      const timer = setTimeout(() => controller.abort(new Error("File read timed out")), options.timeoutMs);
      try {
        const before = await handle.stat(); if (!before.isFile() || !before.size || before.size > options.maxBytes) throw new Error("Not a regular file or exceeds byte limit");
        const chunks: Uint8Array[] = []; let position = 0;
        while (position < before.size) { abort(controller.signal); const buffer = new Uint8Array(Math.min(262144, before.size - position)); const result = await handle.read(buffer, 0, buffer.length, position); if (!result.bytesRead) throw new Error("Local file shortened while reading"); position += result.bytesRead; chunks.push(buffer.slice(0, result.bytesRead)); }
        const after = await handle.stat(); abort(controller.signal);
        if (before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ino !== after.ino) throw new Error("Local file changed while reading");
        return { blob: new Blob(chunks.map(chunk => chunk.slice().buffer as ArrayBuffer)), name: real.replace(/\\/g, "/").split("/").pop() || "image" };
      } finally { clearTimeout(timer); options.signal?.removeEventListener("abort", relay); await handle.close(); }
    },
    async download(raw: string, options: ReadOptions): Promise<Downloaded> {
      let current = requireRemotePermission(raw);
      for (let redirects = 0; redirects <= 3; redirects++) {
        abort(options.signal);
        const addresses: Array<{ address: string; family: number }> = await dns.lookup(current.hostname, { all: true, family: 4 });
        abort(options.signal);
        const address = addresses[0]?.address ?? current.hostname;
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
            family: 4,
            headers: { Accept: "image/*", "Accept-Encoding": "identity" },
            lookup: (_h: string, opts: any, cb: any) => opts?.all ? cb(null, [{ address, family: 4 }]) : cb(null, address, 4)
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
          const timer = setTimeout(() => { finish(new Error("Download timed out")); request.destroy(); }, options.timeoutMs);
          request.on("close", () => clearTimeout(timer));
          request.on("error", finish);
          if (options.signal?.aborted) onAbort(); else request.end();
        });
        if (result.location) {
          if (redirects === 3) throw new Error("Too many redirects");
          const next = new URL(result.location, current);
          current = requireRemotePermission(next.href);
          continue;
        }
        const fileName = current.pathname.split("/").pop() || "image";
        return { blob: result.blob!, name: decodeURIComponent(fileName) };
      }
      throw new Error("Download did not complete");
    },
  };
}
