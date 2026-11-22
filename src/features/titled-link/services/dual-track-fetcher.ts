export interface KernelPostClient {
  post<T>(path: string, body: unknown, options?: { signal?: AbortSignal; timeout?: number }): Promise<{ data: T }>;
}

export interface ForwardProxyData {
  url: string;
  status: number;
  contentType: string;
  body: string;
  bodyEncoding: string;
  headers: Record<string, string[]>;
  elapsed: number;
}

export interface TitleResource {
  readonly transport: "direct" | "proxy";
  readonly status: number;
  readonly ok: boolean;
  readonly contentType: string;
  readonly body: ReadableStream<Uint8Array> | Uint8Array;
}

export interface FetchTitleResourceOptions {
  readonly url: string;
  readonly frontend?: string;
  readonly userAgent: string;
  readonly kernelClient: KernelPostClient;
  readonly signal?: AbortSignal;
  readonly fetchImpl?: typeof fetch;
  readonly timeoutMs?: number;
  readonly logger?: { debug?(message: string, data?: unknown): void };
}

const DEFAULT_TIMEOUT_MS = 8_000;
const DEFAULT_MAX_BYTES = 64 * 1024;

export async function fetchTitleResource(options: FetchTitleResourceOptions): Promise<TitleResource> {
  const timeoutMs = positiveTimeout(options.timeoutMs);
  const transport = isNativeDesktop(options.frontend) ? "direct" : "proxy";
  options.logger?.debug?.("选择链接标题抓取轨道", { url: options.url, frontend: options.frontend, transport });
  if (transport === "direct") {
    return fetchDirect(options, timeoutMs);
  }
  return fetchThroughProxy(options, timeoutMs);
}

function isNativeDesktop(frontend?: string): boolean {
  return frontend === "desktop" || frontend === "desktop-window";
}

async function fetchDirect(options: FetchTitleResourceOptions, timeoutMs: number): Promise<TitleResource> {
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  if (options.signal?.aborted) {
    throw options.signal.reason ?? new DOMException("Operation cancelled", "AbortError");
  }
  const timeoutController = new AbortController();
  const timeout = setTimeout(() => timeoutController.abort(new DOMException("Request timed out", "TimeoutError")), timeoutMs);
  const onAbort = () => timeoutController.abort(options.signal?.reason ?? new DOMException("Operation cancelled", "AbortError"));
  options.signal?.addEventListener("abort", onAbort, { once: true });
  const cleanup = () => {
    clearTimeout(timeout);
    options.signal?.removeEventListener("abort", onAbort);
  };

  try {
    const response = await fetchImpl(options.url, {
      method: "GET",
      headers: { "User-Agent": options.userAgent },
      credentials: "omit",
      referrerPolicy: "no-referrer",
      signal: timeoutController.signal,
    });
    const contentType = response.headers.get("content-type") ?? "";
    options.logger?.debug?.("直连抓取网页响应", {
      url: options.url,
      status: response.status,
      ok: response.ok,
      contentType,
    });
    if (!response.body) {
      cleanup();
      return {
        transport: "direct",
        status: response.status,
        ok: response.ok,
        contentType,
        body: new Uint8Array(0),
      };
    }
    return {
      transport: "direct",
      status: response.status,
      ok: response.ok,
      contentType,
      body: withLifecycle(response.body, cleanup, timeoutController.signal, options.signal),
    };
  } catch (error) {
    cleanup();
    if (timeoutController.signal.aborted && !options.signal?.aborted) {
      throw new DOMException("Request timed out", "TimeoutError");
    }
    throw error;
  }
}

async function requestProxy(
  options: FetchTitleResourceOptions,
  timeoutMs: number,
  extraHeaders: Array<Record<string, string>>,
): Promise<{ data: ForwardProxyData }> {
  return options.kernelClient.post<ForwardProxyData>("/api/network/forwardProxy", {
    url: options.url,
    method: "GET",
    timeout: timeoutMs,
    responseEncoding: "base64",
    headers: [{ "User-Agent": options.userAgent }, { Referer: "" }, ...extraHeaders],
  }, { signal: options.signal, timeout: timeoutMs });
}

async function fetchThroughProxy(options: FetchTitleResourceOptions, timeoutMs: number): Promise<TitleResource> {
  // Request the first 64 KiB via Range to limit proxy payload size on Range-capable servers,
  // and pass Accept-Encoding: identity under kernel DisableAutoDecode() to avoid transport ambiguity.
  let response = await requestProxy(options, timeoutMs, [
    { Range: `bytes=0-${DEFAULT_MAX_BYTES - 1}` },
    { "Accept-Encoding": "identity" },
  ]);
  if (response.data?.status === 416) {
    options.logger?.debug?.("代理抓取返回 416，去掉 Range 头重试", { url: options.url });
    response = await requestProxy(options, timeoutMs, [{ "Accept-Encoding": "identity" }]);
  }
  const data = response.data;
  options.logger?.debug?.("代理抓取网页响应", {
    url: options.url,
    status: data?.status,
    contentType: data?.contentType ?? "",
    encoding: data?.bodyEncoding,
  });
  if (!data || typeof data !== "object" || !Number.isInteger(data.status)) {
    throw new Error("Invalid forward proxy response");
  }
  const ok = data.status >= 200 && data.status < 300;
  const proxyContentType = data.contentType ?? "";
  if (!ok) {
    return {
      transport: "proxy",
      status: data.status,
      ok: false,
      contentType: proxyContentType,
      body: new Uint8Array(0),
    };
  }
  if (data.bodyEncoding !== "base64" && data.bodyEncoding !== "base64-std") {
    throw new Error(`Unexpected forward proxy encoding: ${data.bodyEncoding}`);
  }
  return {
    transport: "proxy",
    status: data.status,
    ok: true,
    contentType: proxyContentType,
    body: typeof data.body === "string" ? decodeBase64(data.body, DEFAULT_MAX_BYTES) : new Uint8Array(0),
  };
}

export function decodeBase64(value: string, maxBytes = DEFAULT_MAX_BYTES): Uint8Array {
  const boundedBytes = Number.isInteger(maxBytes) && maxBytes > 0 ? maxBytes : DEFAULT_MAX_BYTES;
  const maxChars = Math.ceil((boundedBytes + 1) / 3) * 4;
  let cleaned = "";
  let padding = 0;
  let runStart = -1;

  for (let index = 0; index < value.length && cleaned.length + (runStart >= 0 ? index - runStart : 0) < maxChars; index += 1) {
    const code = value.charCodeAt(index);
    if (code === 9 || code === 10 || code === 12 || code === 13 || code === 32) {
      if (runStart >= 0) {
        cleaned += value.slice(runStart, index);
        runStart = -1;
      }
      continue;
    }

    const isBase64Digit =
      (code >= 65 && code <= 90) ||
      (code >= 97 && code <= 122) ||
      (code >= 48 && code <= 57) ||
      code === 43 ||
      code === 47;

    if (isBase64Digit) {
      if (padding > 0) {
        throw new Error("Invalid base64 data after padding");
      }
      if (runStart < 0) runStart = index;
      continue;
    }

    if (code === 61) {
      const currentLength = cleaned.length + (runStart >= 0 ? index - runStart : 0);
      if (currentLength % 4 < 2 || padding >= 2) {
        throw new Error("Invalid base64 padding");
      }
      padding += 1;
      if (runStart < 0) runStart = index;
      continue;
    }

    throw new Error(`Invalid base64 character at index ${index}`);
  }

  if (runStart >= 0) {
    const remaining = maxChars - cleaned.length;
    cleaned += value.slice(runStart, Math.min(value.length, runStart + remaining));
  }

  if (cleaned.length % 4 !== 0) {
    throw new Error("Invalid base64 length");
  }

  const decoded = globalThis.atob(cleaned);
  const bytes = new Uint8Array(decoded.length);
  for (let index = 0; index < decoded.length; index += 1) bytes[index] = decoded.charCodeAt(index);
  return bytes;
}

function positiveTimeout(value?: number): number {
  return Number.isFinite(value) && (value ?? 0) > 0 ? value! : DEFAULT_TIMEOUT_MS;
}

function withLifecycle(
  stream: ReadableStream<Uint8Array>,
  cleanup: () => void,
  timeoutSignal: AbortSignal,
  callerSignal?: AbortSignal,
): ReadableStream<Uint8Array> {
  const reader = stream.getReader();
  const onAbort = () => {
    void reader.cancel(timeoutSignal.reason).catch(() => undefined);
  };
  if (timeoutSignal.aborted) {
    onAbort();
  } else {
    timeoutSignal.addEventListener("abort", onAbort, { once: true });
  }
  let finished = false;
  const finish = () => {
    if (finished) return;
    finished = true;
    timeoutSignal.removeEventListener("abort", onAbort);
    cleanup();
  };
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const result = await reader.read();
        if (timeoutSignal.aborted) {
          finish();
          controller.error(
            callerSignal?.aborted
              ? (callerSignal.reason ?? new DOMException("Operation cancelled", "AbortError"))
              : new DOMException("Request timed out", "TimeoutError"),
          );
          return;
        }
        if (result.done) {
          finish();
          controller.close();
        } else {
          controller.enqueue(result.value);
        }
      } catch (error) {
        finish();
        if (timeoutSignal.aborted && !callerSignal?.aborted) {
          controller.error(new DOMException("Request timed out", "TimeoutError"));
        } else {
          controller.error(error);
        }
      }
    },
    async cancel(reason) {
      finish();
      await reader.cancel(reason);
    },
  });
}
