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
}

const DEFAULT_TIMEOUT_MS = 8_000;

export async function fetchTitleResource(options: FetchTitleResourceOptions): Promise<TitleResource> {
  const timeoutMs = positiveTimeout(options.timeoutMs);
  if (isNativeDesktop(options.frontend)) {
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
  const onAbort = () => timeoutController.abort(options.signal?.reason);
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
    if (!response.body) throw new Error("Response body is unavailable");
    return {
      transport: "direct",
      status: response.status,
      ok: response.ok,
      contentType: response.headers.get("content-type") ?? "",
      body: withLifecycle(response.body, cleanup, options.signal),
    };
  } catch (error) {
    cleanup();
    throw error;
  }
}

async function fetchThroughProxy(options: FetchTitleResourceOptions, timeoutMs: number): Promise<TitleResource> {
  // TODO(titled-link 3.3): SiYuan forwardProxy calls response.Bytes() before returning JSON.
  // Its current API cannot expose a stream or cancel the remote TCP connection at </title>.
  // Keep this transport limitation visible until a host API supports bounded streaming.
  const response = await options.kernelClient.post<ForwardProxyData>("/api/network/forwardProxy", {
    url: options.url,
    method: "GET",
    timeout: timeoutMs,
    responseEncoding: "base64",
    headers: [
      { "User-Agent": options.userAgent },
      { Referer: "" },
    ],
  }, { signal: options.signal, timeout: timeoutMs });
  const data = response.data;
  if (data.bodyEncoding !== "base64" && data.bodyEncoding !== "base64-std") {
    throw new Error(`Unexpected forward proxy encoding: ${data.bodyEncoding}`);
  }
  return {
    transport: "proxy",
    status: data.status,
    ok: data.status >= 200 && data.status < 300,
    contentType: data.contentType ?? "",
    body: decodeBase64(data.body),
  };
}

function decodeBase64(value: string): Uint8Array {
  const decoded = globalThis.atob(value);
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
  signal?: AbortSignal,
): ReadableStream<Uint8Array> {
  const reader = stream.getReader();
  const onAbort = () => {
    void reader.cancel(signal?.reason).catch(() => undefined);
  };
  signal?.addEventListener("abort", onAbort, { once: true });
  let finished = false;
  const finish = () => {
    if (finished) return;
    finished = true;
    signal?.removeEventListener("abort", onAbort);
    cleanup();
  };
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const result = await reader.read();
        if (result.done) {
          finish();
          controller.close();
        } else {
          controller.enqueue(result.value);
        }
      } catch (error) {
        finish();
        controller.error(error);
      }
    },
    async cancel(reason) {
      finish();
      await reader.cancel(reason);
    },
  });
}
