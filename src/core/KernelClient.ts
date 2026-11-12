import { fetchPost } from "siyuan";

export interface KernelResponse<T> { code: number; data: T; msg: string; }
export type KernelFetchPost = typeof fetchPost;
export interface KernelRequestOptions { signal?: AbortSignal; timeout?: number; }

/** Thin adapter over SiYuan's callback API. A rejected write may already have reached the kernel. */
export class KernelRequestError extends Error {
  readonly outcome: "not-sent" | "unknown";
  readonly code?: number;
  constructor(message: string, outcome: "not-sent" | "unknown", name = "Error", code?: number) {
    super(message);
    this.name = name;
    this.outcome = outcome;
    this.code = code;
  }
}

export class KernelClient {
  private readonly request: KernelFetchPost;

  constructor(request: KernelFetchPost = fetchPost) { this.request = request; }

  post<T>(path: string, body: unknown, options: KernelRequestOptions = {}): Promise<KernelResponse<T>> {
    const { signal } = options;
    const timeout = Number.isFinite(options.timeout) && (options.timeout ?? 0) > 0 ? options.timeout! : 30_000;
    if (signal?.aborted) return Promise.reject(new KernelRequestError("Operation cancelled", "not-sent", "AbortError"));
    return new Promise((resolve, reject) => {
      let settled = false;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const cleanup = () => {
        if (timer !== undefined) clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
      };
      const settle = (fn: () => void) => {
        if (settled) return;
        settled = true;
        cleanup();
        fn();
      };
      const onAbort = () => settle(() => reject(new KernelRequestError("Operation cancelled", "unknown", "AbortError")));
      signal?.addEventListener("abort", onAbort, { once: true });
      timer = setTimeout(() => settle(() => reject(new KernelRequestError("Request timed out", "unknown", "TimeoutError"))), timeout);
      try {
        this.request(path, body, response => {
          const result = response as unknown as KernelResponse<T>;
          if (result?.code !== 0) settle(() => reject(new KernelRequestError(result?.msg || `SiYuan API failed: ${path}`, "unknown", "Error", result?.code)));
          else settle(() => resolve(result));
        }, undefined, response => settle(() => reject(new KernelRequestError(response?.msg || `SiYuan request failed: ${path}`, "unknown", "Error", response?.code))), signal, timeout);
      } catch (error) {
        settle(() => reject(new KernelRequestError(error instanceof Error ? error.message : String(error), "unknown")));
      }
    });
  }
}
