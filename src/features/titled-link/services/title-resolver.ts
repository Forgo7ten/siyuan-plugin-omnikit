import type { FeatureScope } from "../../../core/framework/FeatureScope.ts";
import type { KernelClient } from "../../../core/host/KernelClient.ts";
import type { Logger } from "../../../core/host/Logger.ts";
import {
  DEFAULT_MAX_TITLE_LENGTH,
  type TitleFetchFailureReason,
  type TitleFetchResult,
  type TitledLinkConfig,
} from "../policy/types.ts";
import { fetchTitleResource } from "./dual-track-fetcher.ts";
import { extractStaticFileName } from "./static-file.ts";
import { readAndDecodeTitleResource } from "./stream-parser.ts";
import { TitleCache } from "./title-cache.ts";
import { finalizeTitle, resolveNormalizedTitle } from "./title-normalizer.ts";

export type TitleResolveMode = "auto" | "manual" | "batch";

export interface TitleResolverOptions {
  readonly scope: FeatureScope;
  readonly kernel: KernelClient;
  readonly cache: TitleCache;
  readonly frontend: () => string;
  readonly getUserAgent: () => string;
  readonly fetchImpl?: typeof fetch;
  readonly logger?: Logger;
}

export class TitleResolver {
  private readonly pending = new Map<string, Promise<TitleFetchResult>>();
  private readonly scope: FeatureScope;
  private readonly kernel: KernelClient;
  private readonly cache: TitleCache;
  private readonly frontend: () => string;
  private readonly getUserAgent: () => string;
  private readonly fetchImpl?: typeof fetch;
  private readonly logger?: Logger;

  constructor(options: TitleResolverOptions) {
    this.scope = options.scope;
    this.kernel = options.kernel;
    this.cache = options.cache;
    this.frontend = options.frontend;
    this.getUserAgent = options.getUserAgent;
    this.fetchImpl = options.fetchImpl;
    this.logger = options.logger;
  }

  async resolve(
    url: string,
    mode: TitleResolveMode,
    config: TitledLinkConfig,
    signal?: AbortSignal,
  ): Promise<TitleFetchResult> {
    const staticName = extractStaticFileName(url);
    if (staticName) {
      const title = finalizeTitle(staticName, DEFAULT_MAX_TITLE_LENGTH);
      if (!title) return { status: "failure", url, reason: "missing-title" };
      this.logger?.debug?.("命中静态文件链接，跳过网页抓取", { url, title, mode });
      return { status: "success", url, title, source: "static-file", fallback: false };
    }

    const key = cacheKey(url);
    if (mode === "auto") {
      const cached = this.cache.get(key);
      if (cached) {
        this.logger?.debug?.("命中链接标题缓存", { url, title: cached, mode });
        return { status: "success", url, title: cached, source: "title", fallback: false };
      }
    }
    if (mode !== "manual") {
      const inFlight = this.pending.get(key);
      if (inFlight) {
        this.logger?.debug?.("复用进行中的同链接抓取请求", { url, mode });
        return inFlight;
      }
    }

    const generation = this.cache.captureGeneration(key);
    const request = this.fetchAndNormalize(url, config, signal).then(result => {
      if (mode === "auto" && result.status === "success" && !result.fallback && this.scope.active) {
        this.cache.set(key, result.title, generation);
      }
      return result;
    });
    if (mode !== "manual") this.pending.set(key, request);
    try {
      return await request;
    } finally {
      if (this.pending.get(key) === request) this.pending.delete(key);
    }
  }

  refreshCache(url: string, title: string): void {
    this.cache.refresh(cacheKey(url), title);
  }

  clear(): void {
    this.cache.clear();
    this.pending.clear();
  }

  private async fetchAndNormalize(
    url: string,
    config: TitledLinkConfig,
    signal?: AbortSignal,
  ): Promise<TitleFetchResult> {
    const effective = signal ?? this.scope.signal;
    const normalizeOptions = {
      fallbackToHostname: config.fallbackToHostname,
      maxTitleLength: DEFAULT_MAX_TITLE_LENGTH,
    };
    try {
      const resource = await fetchTitleResource({
        url,
        frontend: this.frontend(),
        userAgent: this.getUserAgent(),
        kernelClient: this.kernel,
        signal: effective,
        fetchImpl: this.fetchImpl,
        logger: this.logger,
      });
      if (!resource.ok) {
        if (resource.body instanceof ReadableStream) await resource.body.cancel();
        const fallback = resolveNormalizedTitle("", url, normalizeOptions);
        this.logger?.debug?.("网页请求返回非成功状态码", {
          url,
          transport: resource.transport,
          status: resource.status,
          fallbackUsed: fallback.ok,
        });
        if (fallback.ok) {
          return { status: "success", url, title: fallback.title, source: fallback.source, fallback: true };
        }
        return { status: "failure", url, reason: "http", httpStatus: resource.status };
      }

      const decoded = await readAndDecodeTitleResource(resource, { signal: effective, logger: this.logger });
      if (effective.aborted) return { status: "failure", url, reason: "aborted" };
      const extracted = resolveNormalizedTitle(decoded.html, url, normalizeOptions);
      this.logger?.debug?.("网页解码与标题提取完成", {
        url,
        transport: resource.transport,
        charset: decoded.charset,
        bytesRead: decoded.bytesRead,
        truncated: decoded.truncated,
        ok: extracted.ok,
        ...(extracted.ok ? { source: extracted.source } : { reason: extracted.reason }),
      });
      if (extracted.ok) {
        return {
          status: "success",
          url,
          title: extracted.title,
          source: extracted.source,
          fallback: extracted.source === "hostname",
        };
      }
      return { status: "failure", url, reason: extracted.reason };
    } catch (error) {
      if (effective.aborted) return { status: "failure", url, reason: "aborted" };
      const fallback = resolveNormalizedTitle("", url, normalizeOptions);
      const reason: TitleFetchFailureReason = isTimeoutError(error) ? "timeout" : "network";
      this.logger?.debug?.("抓取或解析链接标题异常", {
        url,
        reason,
        fallbackUsed: fallback.ok,
        error,
      });
      if (fallback.ok) {
        return { status: "success", url, title: fallback.title, source: fallback.source, fallback: true };
      }
      return { status: "failure", url, reason, error };
    }
  }
}

function cacheKey(href: string): string {
  try {
    return new URL(href).href;
  } catch {
    return href;
  }
}

function isTimeoutError(error: unknown): boolean {
  let current: unknown = error;
  for (let depth = 0; depth < 4 && current && typeof current === "object"; depth++) {
    const err = current as { name?: unknown; code?: unknown; cause?: unknown };
    if (err.name === "TimeoutError" || err.code === "ETIMEDOUT") return true;
    current = err.cause;
  }
  return false;
}
