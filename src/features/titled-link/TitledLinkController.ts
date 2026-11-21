import type { FeatureContext } from "../../core/framework/FeatureContext.ts";
import type { FeatureScope } from "../../core/framework/FeatureScope.ts";
import type { KernelClient } from "../../core/host/KernelClient.ts";
import { combineSignals, resolveNotebookID } from "../../core/host/ProtyleAdapter.ts";
import { isInsideProtectedContainer } from "../../core/host/dom.ts";
import { extractStaticFileName } from "./services/static-file.ts";
import { fetchTitleResource } from "./services/dual-track-fetcher.ts";
import { readAndDecodeTitleResource } from "./services/stream-parser.ts";
import { finalizeTitle, resolveNormalizedTitle } from "./services/title-normalizer.ts";
import { TitleCache } from "./services/title-cache.ts";
import {
  captureLinkTarget,
  commitLinkTitle,
  commitLinkTitles,
  resolveTitledLinkProtyle,
} from "./services/safe-writer.ts";
import type { GroupedLinkTitleUpdate } from "./services/safe-writer.ts";
import { countBatchResults } from "./policy/batchSummary.ts";
import { isAutomaticLinkCandidate, isHttpUrl } from "./policy/paste-range.ts";
import {
  DEFAULT_MAX_TITLE_LENGTH,
  type LinkActionResult,
  type LinkOccurrenceTarget,
  type TitleFetchFailureReason,
  type TitleFetchResult,
  type TitleFetchSource,
  type TitledLinkConfig,
} from "./policy/types.ts";

export type { LinkActionResult } from "./policy/types.ts";
export { isAutomaticLinkCandidate, isHttpUrl } from "./policy/paste-range.ts";

export interface TitledLinkControllerOptions {
  notify?: (message: string) => void;
  frontend?: () => string;
  fetchImpl?: typeof fetch;
  kernel: KernelClient;
  cache?: TitleCache;
  isComposing?: (protyle?: unknown) => boolean;
  imeTimeoutMs?: number;
  imePollMs?: number;
  translate?: (key: string, values?: Record<string, string | number>) => string;
}

interface BatchCandidate extends GroupedLinkTitleUpdate {
  token: number;
  fallback: boolean;
  source: TitleFetchSource;
}

interface PreparedBatchItem {
  readonly index: number;
  readonly target: LinkOccurrenceTarget;
  readonly token: number;
}

interface BatchOutcome {
  result: LinkActionResult;
  candidate?: BatchCandidate;
  fallback?: boolean;
  source?: TitleFetchSource;
}

/** The worker count is an upper bound even when there are fewer links. */
export async function mapWithConcurrency<T, R>(items: readonly T[], limit: number, run: (item: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const index = next++;
      results[index] = await run(items[index]);
    }
  });
  await Promise.all(workers);
  return results;
}

export class TitledLinkController {
  private readonly tokens = new WeakMap<HTMLElement, number>();
  private readonly pending = new Map<string, Promise<TitleFetchResult>>();
  private readonly inFlight = new Map<HTMLElement, AbortController>();
  private readonly inFlightBatches = new Set<string | HTMLElement>();
  private readonly kernel: KernelClient;
  private readonly cache: TitleCache;
  private readonly notify: (message: string) => void;
  private readonly frontend: () => string;
  private readonly t: (key: string, values?: Record<string, string | number>) => string;

  constructor(
    private readonly context: FeatureContext,
    private readonly scope: FeatureScope,
    private readonly options: TitledLinkControllerOptions,
  ) {
    this.kernel = options.kernel;
    this.cache = options.cache ?? new TitleCache();
    this.notify = options.notify ?? (() => undefined);
    this.frontend = options.frontend ?? (() => "unknown");
    this.t = options.translate ?? ((key) => key);
    scope.own(() => {
      this.cache.clear();
      this.pending.clear();
      this.inFlightBatches.clear();
      for (const controller of this.inFlight.values()) controller.abort("scope disposed");
      this.inFlight.clear();
    });
  }

  /** Process candidate links captured from a single paste operation without blocking consecutive pastes. */
  async runAutoPaste(links: readonly HTMLElement[], protyle: any): Promise<void> {
    if (!this.scope.active || !this.config().auto.enabled) return;
    const candidates = [...new Set(links)].filter(link => {
      const href = link?.getAttribute?.("data-href") ?? "";
      return isHttpUrl(href) && !isInsideProtectedContainer(link) && isAutomaticLinkCandidate(link?.textContent ?? "", href);
    });
    if (candidates.length === 0) return;
    await this.runBatchCandidates(candidates, protyle, "auto-paste");
  }

  /** Menu close/removeCB settles before the snapshot is taken. */
  async runManual(link: HTMLElement, protyle: any): Promise<LinkActionResult> {
    this.context.logger?.debug?.("手动触发提取链接标题", {
      href: link?.getAttribute?.("data-href"),
      text: link?.textContent,
      isConnected: link?.isConnected,
    });
    await new Promise<void>(resolve => setTimeout(resolve, 0));
    if (!this.scope.active) return "aborted";
    return this.runLink(link, protyle, "manual");
  }

  async runBatch(blocks: readonly HTMLElement[], protyle: any): Promise<void> {
    if (!this.scope.active) return;
    this.context.logger?.debug?.("开始批量提取链接标题", { blockCount: blocks.length });
    const claimedKeys: Array<string | HTMLElement> = [];
    const eligibleBlocks: HTMLElement[] = [];
    for (const block of blocks) {
      const key = batchBlockKey(block, protyle);
      if (this.inFlightBatches.has(key) || claimedKeys.includes(key)) continue;
      claimedKeys.push(key);
      eligibleBlocks.push(block);
    }
    if (eligibleBlocks.length === 0) {
      this.context.logger?.debug?.("批量提取链接标题：目标块已在处理中，跳过重复触发");
      return;
    }
    for (const key of claimedKeys) this.inFlightBatches.add(key);

    try {
      const links = [...new Set(eligibleBlocks.flatMap(block => [...block.querySelectorAll<HTMLElement>('span[data-type~="a"]')]))]
        .filter(link => isHttpUrl(link.getAttribute("data-href") ?? "") && !isInsideProtectedContainer(link));
      if (links.length === 0) {
        this.context.logger?.debug?.("批量提取链接标题：未找到有效 HTTP(S) 链接");
        return;
      }
      await this.runBatchCandidates(links, protyle, "manual-batch");
    } finally {
      for (const key of claimedKeys) this.inFlightBatches.delete(key);
    }
  }

  clear(): void { this.cache.clear(); this.pending.clear(); }

  private async runBatchCandidates(
    links: readonly HTMLElement[],
    protyle: any,
    mode: "auto-paste" | "manual-batch",
  ): Promise<void> {
    this.context.logger?.debug?.("开始处理链接候选集", { count: links.length, mode });
    const outcomes: BatchOutcome[] = new Array(links.length);
    const prepared: PreparedBatchItem[] = [];
    const blockHTMLCache = new Map<HTMLElement, string>();
    links.forEach((link, index) => {
      const href = link?.getAttribute?.("data-href");
      const text = link?.textContent;
      this.context.logger?.debug?.("批量准备链接", { href, text, mode });
      const target = captureLinkTarget(link, protyle, blockHTMLCache);
      if (!target) {
        const runner = resolveTitledLinkProtyle(protyle);
        const block = link?.closest<HTMLElement>("[data-node-id]");
        this.context.logger?.warn?.("批量准备链接失败：无法捕获链接目标", {
          href,
          text,
          hasBlock: Boolean(block),
          blockID: block?.getAttribute?.("data-node-id") ?? undefined,
          hasUpdateTransaction: typeof runner?.updateTransactionElement === "function",
        });
        outcomes[index] = { result: "failed" };
        return;
      }
      const token = (this.tokens.get(link) ?? 0) + 1;
      this.tokens.set(link, token);
      prepared.push({ index, target, token });
    });

    const fetchMode = mode === "auto-paste" ? "auto" : "batch";
    const fetchedOutcomes = await mapWithConcurrency(prepared, 3, item => this.prepareBatch(item, fetchMode));
    fetchedOutcomes.forEach((outcome, fetchedIndex) => {
      outcomes[prepared[fetchedIndex].index] = outcome;
    });
    if (!this.scope.active) return;

    const groups = new Map<string, Array<{ index: number; candidate: BatchCandidate }>>();
    outcomes.forEach((outcome, index) => {
      const candidate = outcome.candidate;
      if (!candidate) return;
      if (!this.current(candidate.target, candidate.token)) {
        outcomes[index].result = this.scope.active ? "superseded" : "aborted";
        return;
      }
      const key = `${candidate.target.notebook}/${candidate.target.blockID}`;
      const group = groups.get(key) ?? [];
      group.push({ index, candidate });
      groups.set(key, group);
    });

    for (const group of groups.values()) {
      if (!this.scope.active) return;
      const updates = group.map(({ candidate }) => ({
        target: candidate.target,
        title: candidate.title,
        isCurrent: () => this.current(candidate.target, candidate.token),
      }));
      this.context.logger?.debug?.("开始批量提交块内链接标题写入", {
        blockID: group[0]?.candidate?.target?.blockID,
        count: updates.length,
      });
      let writes: LinkActionResult[];
      try {
        writes = await commitLinkTitles(updates, {
          replaceTitle: this.config().replaceTitle,
          signal: this.scope.signal,
          kernel: this.kernel,
          isComposing: this.options.isComposing,
          imeTimeoutMs: this.options.imeTimeoutMs,
          imePollMs: this.options.imePollMs,
        });
        this.context.logger?.debug?.("批量提交块内链接标题写入完成", {
          blockID: group[0]?.candidate?.target?.blockID,
          writes,
        });
      } catch (error) {
        this.context.logger?.warn?.("链接标题批量写入失败", error);
        for (const { index } of group) {
          outcomes[index].result = this.scope.active ? "failed" : "aborted";
        }
        continue;
      }
      group.forEach(({ index, candidate }, writeIndex) => {
        if (!this.current(candidate.target, candidate.token)) {
          outcomes[index].result = this.scope.active ? "superseded" : "aborted";
          return;
        }
        outcomes[index].result = writes[writeIndex] ?? "conflict";
      });
    }

    const results = outcomes.map(outcome => outcome.result);
    const summary = countBatchResults(results);
    this.context.logger?.debug?.("批量提取链接标题结束", summary);

    if (!this.scope.active) return;
    if (mode === "auto-paste") {
      if (!this.config().auto.enabled) return;
      if (summary.skipped === summary.total) return;
      if (summary.total === 1) {
        const outcome = outcomes[0];
        this.notify(this.t(singleResultNoticeKey(outcome.result, outcome.fallback === true)));
        return;
      }
    }
    this.notify(this.t("titledLink.batchSummary", { ...summary }));
  }

  private config(): TitledLinkConfig {
    return this.context.settings.getFeature<TitledLinkConfig>("titled-link");
  }

  private async runLink(link: HTMLElement, protyle: any, mode: "auto" | "manual"): Promise<LinkActionResult> {
    if (!this.scope.active) return "aborted";
    const href = link?.getAttribute?.("data-href");
    const text = link?.textContent;
    this.context.logger?.debug?.("开始处理链接标题", { href, text, mode });
    const target = captureLinkTarget(link, protyle);
    if (!target) {
      const block = link?.closest<HTMLElement>("[data-node-id]");
      const runner = resolveTitledLinkProtyle(protyle);
      this.context.logger?.warn?.("无法捕获链接目标信息（target 为空）", {
        href,
        text,
        isConnected: link?.isConnected,
        hasBlock: Boolean(block),
        blockID: block?.getAttribute?.("data-node-id") ?? undefined,
        rootID: protyle?.block?.rootID ?? protyle?.protyle?.block?.rootID,
        notebook: protyle?.notebookId ?? protyle?.block?.box ?? protyle?.protyle?.notebookId ?? protyle?.protyle?.block?.box,
        hasUpdateTransaction: typeof runner?.updateTransactionElement === "function",
        protyleType: typeof protyle,
        hasGetInstance: typeof protyle?.getInstance === "function",
      });
      if (mode === "manual") this.notify(this.t("titledLink.failed"));
      return "failed";
    }
    if (!isHttpUrl(target.originalHref)) {
      this.context.logger?.debug?.("跳除非 HTTP(S) 链接", {
        href: target.originalHref,
        text: target.originalText,
        mode,
      });
      if (mode === "manual") this.notify(this.t("titledLink.failed"));
      return "failed";
    }
    if (mode === "auto" && !isAutomaticLinkCandidate(target.originalText, target.originalHref)) {
      this.context.logger?.debug?.("自动模式跳过已有标题的链接", {
        href: target.originalHref,
        text: target.originalText,
      });
      return "failed";
    }
    const token = (this.tokens.get(link) ?? 0) + 1;
    this.tokens.set(link, token);
    let request: AbortController | undefined;
    if (mode === "manual") {
      this.inFlight.get(link)?.abort("superseded by a newer run");
      request = new AbortController();
      this.inFlight.set(link, request);
    }
    const signal = request
      ? (combineSignals(this.scope.signal, request.signal) ?? this.scope.signal)
      : this.scope.signal;
    let loadingTimer: ReturnType<typeof setTimeout> | undefined;
    if (mode === "manual") loadingTimer = setTimeout(() => {
      if (this.current(target, token)) this.notify(this.t("titledLink.loading"));
    }, 1_000);
    try {
      this.context.logger?.debug?.("开始抓取链接标题", {
        href: target.originalHref,
        mode,
        token,
      });
      const fetched = await this.titleFor(target, mode, signal);
      this.context.logger?.debug?.("链接标题抓取完成", {
        href: target.originalHref,
        status: fetched.status,
        title: fetched.status === "success" ? fetched.title : undefined,
        reason: fetched.status === "failure" ? fetched.reason : undefined,
      });
      if (!this.current(target, token)) return this.scope.active ? "superseded" : "aborted";
      if (fetched.status === "failure") {
        if (mode === "manual") this.notify(this.t("titledLink.failed"));
        return fetched.reason === "aborted" ? "aborted" : "failed";
      }
      this.context.logger?.debug?.("开始提交链接标题写入", {
        href: target.originalHref,
        title: fetched.title,
        blockID: target.blockID,
      });
      const result = await commitLinkTitle(target, fetched.title, {
        replaceTitle: this.config().replaceTitle,
        signal,
        kernel: this.kernel,
        isComposing: this.options.isComposing,
        imeTimeoutMs: this.options.imeTimeoutMs,
        imePollMs: this.options.imePollMs,
        isCurrent: () => this.current(target, token),
      });
      this.context.logger?.debug?.("链接标题写入完成", {
        href: target.originalHref,
        result,
        title: fetched.title,
      });
      if (!this.current(target, token)) return this.scope.active ? "superseded" : "aborted";
      if (mode === "manual" &&
          fetched.source !== "static-file" &&
          !fetched.fallback &&
          (result === "updated" || result === "unchanged")) {
        this.cache.refresh(cacheKey(target.originalHref), fetched.title);
      }
      if (mode === "manual") {
        this.notify(this.t(singleResultNoticeKey(result, fetched.fallback)));
      }
      return result;
    } catch (error) {
      if (!this.current(target, token)) return this.scope.active ? "superseded" : "aborted";
      this.context.logger?.warn?.("链接标题提取失败", error);
      if (mode === "manual") this.notify(this.t("titledLink.failed"));
      return "failed";
    } finally {
      if (loadingTimer) clearTimeout(loadingTimer);
      if (request && this.inFlight.get(link) === request) this.inFlight.delete(link);
    }
  }

  private async prepareBatch(item: PreparedBatchItem, mode: "auto" | "batch"): Promise<BatchOutcome> {
    const { target, token } = item;
    if (!this.current(target, token)) {
      return { result: this.scope.active ? "superseded" : "aborted" };
    }
    try {
      this.context.logger?.debug?.("批量抓取链接标题", { href: target.originalHref, token, mode });
      const fetched = await this.titleFor(target, mode, this.scope.signal);
      this.context.logger?.debug?.("批量抓取链接标题完成", {
        href: target.originalHref,
        status: fetched.status,
        mode,
      });
      if (!this.current(target, token)) {
        return { result: this.scope.active ? "superseded" : "aborted" };
      }
      if (fetched.status === "failure") {
        return { result: fetched.reason === "aborted" ? "aborted" : "failed" };
      }
      return {
        result: "failed",
        fallback: fetched.fallback,
        source: fetched.source,
        candidate: {
          target,
          title: fetched.title,
          token,
          fallback: fetched.fallback,
          source: fetched.source,
        },
      };
    } catch (error) {
      if (!this.current(target, token)) return { result: this.scope.active ? "superseded" : "aborted" };
      this.context.logger?.warn?.("链接标题提取失败", error);
      return { result: "failed" };
    }
  }

  private current(target: LinkOccurrenceTarget, token: number): boolean {
    return this.scope.active && this.tokens.get(target.linkElement) === token;
  }

  private async titleFor(
    target: LinkOccurrenceTarget,
    mode: "auto" | "manual" | "batch",
    signal?: AbortSignal,
  ): Promise<TitleFetchResult> {
    const config = this.config();
    const result = await this.resolveTitle(target, mode, config, signal);
    if (result.status !== "success") return result;
    const title = finalizeTitle(result.title, DEFAULT_MAX_TITLE_LENGTH);
    return title ? { ...result, title } : { status: "failure", url: result.url, reason: "missing-title" };
  }

  private async resolveTitle(
    target: LinkOccurrenceTarget,
    mode: "auto" | "manual" | "batch",
    config: TitledLinkConfig,
    signal?: AbortSignal,
  ): Promise<TitleFetchResult> {
    const url = target.originalHref;
    const key = cacheKey(url);
    const staticName = extractStaticFileName(url);
    if (staticName) return { status: "success", url, title: staticName, source: "static-file", fallback: false };
    if (mode === "auto") {
      const cached = this.cache.get(key);
      if (cached) return { status: "success", url, title: cached, source: "title", fallback: false };
    }
    if (mode !== "manual") {
      const inFlight = this.pending.get(key);
      if (inFlight) return inFlight;
    }
    const generation = this.cache.captureGeneration(key);
    const request = this.fetchAndNormalize(url, config, signal).then(result => {
      if (mode === "auto" && result.status === "success" && !result.fallback && this.scope.active) {
        this.cache.set(key, result.title, generation);
      }
      return result;
    });
    if (mode !== "manual") this.pending.set(key, request);
    try { return await request; }
    finally { if (this.pending.get(key) === request) this.pending.delete(key); }
  }

  private async fetchAndNormalize(url: string, config: TitledLinkConfig, signal?: AbortSignal): Promise<TitleFetchResult> {
    const effective = signal ?? this.scope.signal;
    const normalizeOptions = {
      fallbackToHostname: config.fallbackToHostname,
      maxTitleLength: DEFAULT_MAX_TITLE_LENGTH,
    };
    try {
      const resource = await fetchTitleResource({
        url, frontend: this.frontend(), userAgent: this.context.settings.getUserAgent(),
        kernelClient: this.kernel, signal: effective, fetchImpl: this.options.fetchImpl,
      });
      if (!resource.ok) {
        if (resource.body instanceof ReadableStream) await resource.body.cancel();
        const fallback = resolveNormalizedTitle("", url, normalizeOptions);
        if (fallback.ok) return { status: "success", url, title: fallback.title, source: fallback.source, fallback: true };
        return { status: "failure", url, reason: "http", httpStatus: resource.status };
      }
      const decoded = await readAndDecodeTitleResource(resource, { signal: effective });
      if (effective.aborted) return { status: "failure", url, reason: "aborted" };
      const extracted = resolveNormalizedTitle(decoded.html, url, normalizeOptions);
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
      if (fallback.ok) return { status: "success", url, title: fallback.title, source: fallback.source, fallback: true };
      const reason: TitleFetchFailureReason = isTimeoutError(error) ? "timeout" : "network";
      return { status: "failure", url, reason, error };
    }
  }
}

function singleResultNoticeKey(result: LinkActionResult, fallback: boolean): string {
  switch (result) {
    case "updated":
      return fallback ? "titledLink.fallbackUsed" : "titledLink.updated";
    case "unchanged":
      return "titledLink.unchanged";
    case "conflict":
      return "titledLink.conflict";
    case "unknown":
      return "titledLink.unknown";
    case "ime-timeout":
      return "titledLink.imeTimeout";
    default:
      return "titledLink.failed";
  }
}

function cacheKey(href: string): string {
  try { return new URL(href).href; } catch { return href; }
}

function batchBlockKey(block: HTMLElement, protyle: any): string | HTMLElement {
  const notebook = resolveNotebookID(protyle) ?? "";
  const blockID = block.getAttribute?.("data-node-id") ?? "";
  return notebook && blockID ? `${notebook}/${blockID}` : block;
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
