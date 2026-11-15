import type { FeatureContext } from "../../core/FeatureContext.ts";
import type { FeatureScope } from "../../core/FeatureScope.ts";
import type { KernelClient } from "../../core/KernelClient.ts";
import { extractStaticFileName } from "./services/static-file.ts";
import { fetchTitleResource } from "./services/dual-track-fetcher.ts";
import { readAndDecodeTitleResource } from "./services/stream-parser.ts";
import { extractNormalizedTitle } from "./services/title-normalizer.ts";
import { TitleCache } from "./services/title-cache.ts";
import {
  captureLinkTarget,
  commitLinkTitle,
  commitLinkTitles,
} from "./services/safe-writer.ts";
import type { GroupedLinkTitleUpdate } from "./services/safe-writer.ts";
import type { LinkOccurrenceTarget, TitleFetchResult, TitledLinkConfig } from "./types.ts";

export type LinkActionResult = "updated" | "unchanged" | "conflict" | "failed" | "aborted" | "superseded";
export interface TitledLinkControllerOptions {
  notify?: (message: string) => void;
  frontend?: () => string;
  fetchImpl?: typeof fetch;
  kernel: KernelClient;
  cache?: TitleCache;
  isComposing?: () => boolean;
  translate?: (key: string, values?: Record<string, string | number>) => string;
}

interface BatchCandidate extends GroupedLinkTitleUpdate {
  token: number;
  fallback: boolean;
}

interface BatchOutcome {
  result: LinkActionResult;
  candidate?: BatchCandidate;
}

export function isAutomaticLinkCandidate(text: string, href: string): boolean {
  return text === "" || text === href;
}

export function isHttpUrl(value: string): boolean {
  try { return /^(https?:)$/.test(new URL(value).protocol); }
  catch { return false; }
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
    scope.own(() => { this.cache.clear(); this.pending.clear(); });
  }

  /** Called synchronously from SiYuan's pre-insertion paste event; never intercepts paste. */
  scheduleAutoPaste(detail: any): void {
    if (!this.scope.active || !this.config().auto.enabled || !nativePasteLinkEnabled()) return;
    const pasted = detail?.textPlain;
    if (typeof pasted !== "string") return;
    const url = pasted.trim();
    if (!url || /[\s\r\n]/.test(url) || !isHttpUrl(url)) return;
    const protyle = detail?.protyle;
    const selection = globalThis.getSelection?.();
    if (!selection?.isCollapsed) return;
    const parent = selection.anchorNode instanceof Element ? selection.anchorNode : selection.anchorNode?.parentElement;
    const block = parent?.closest<HTMLElement>("[data-node-id]");
    const blockID = block?.getAttribute("data-node-id");
    if (!block || !blockID || !protyle?.wysiwyg?.element?.contains(block)) return;
    const previous = new Set(matchingLinks(block, url));
    const timer = setTimeout(() => {
      release();
      if (!this.scope.active || !this.config().auto.enabled) return;
      const editorElement = protyle.wysiwyg.element as HTMLElement;
      const current = editorElement.querySelector<HTMLElement>(`[data-node-id="${blockID}"]`);
      if (!current) return;
      const matches = matchingLinks(current, url);
      const added = matches.filter(link => !previous.has(link));
      // A re-render of a block with an existing identical URL is ambiguous.
      const candidate = added.length === 1 && (current === block || previous.size === 0) ? added[0] : undefined;
      if (!candidate || !isAutomaticLinkCandidate(candidate.textContent ?? "", url)) return;
      void this.runLink(candidate, protyle, "auto");
    }, 200);
    const release = this.scope.own(() => clearTimeout(timer));
  }

  /** Menu close/removeCB settles before the snapshot is taken. */
  async runManual(link: HTMLElement, protyle: any): Promise<LinkActionResult> {
    await new Promise<void>(resolve => setTimeout(resolve, 0));
    if (!this.scope.active) return "aborted";
    return this.runLink(link, protyle, "manual");
  }

  async runBatch(blocks: readonly HTMLElement[], protyle: any): Promise<void> {
    if (!this.scope.active) return;
    const links = [...new Set(blocks.flatMap(block => [...block.querySelectorAll<HTMLElement>('span[data-type~="a"]')]))]
      .filter(link => isHttpUrl(link.getAttribute("data-href") ?? ""));
    if (links.length === 0) return;
    const outcomes = await mapWithConcurrency(links, 3, link => this.prepareBatch(link, protyle));
    if (!this.scope.active) return;
    const results = outcomes.map(outcome => outcome.result);
    const groups = new Map<string, Array<{ index: number; candidate: BatchCandidate }>>();
    outcomes.forEach((outcome, index) => {
      const candidate = outcome.candidate;
      if (!candidate) return;
      if (!this.current(candidate.target, candidate.token)) {
        results[index] = this.scope.active ? "superseded" : "aborted";
        return;
      }
      const key = `${candidate.target.notebook}/${candidate.target.blockID}`;
      const group = groups.get(key) ?? [];
      group.push({ index, candidate });
      groups.set(key, group);
    });

    for (const group of groups.values()) {
      if (!this.scope.active) return;
      const updates = group.map(({ candidate }) => ({ target: candidate.target, title: candidate.title }));
      let writes;
      try {
        writes = await commitLinkTitles(updates, {
          replaceTitle: this.config().replaceTitle,
          signal: this.scope.signal,
          kernel: this.kernel,
          isComposing: this.options.isComposing,
        });
      } catch (error) {
        this.context.logger.warn("链接标题批量写入失败", error);
        for (const { index } of group) results[index] = this.scope.active ? "failed" : "aborted";
        continue;
      }
      group.forEach(({ index, candidate }, writeIndex) => {
        if (!this.current(candidate.target, candidate.token)) {
          results[index] = this.scope.active ? "superseded" : "aborted";
          return;
        }
        results[index] = writes[writeIndex] ?? "conflict";
      });
    }

    const updated = results.filter(result => result === "updated").length;
    this.notify(this.t("titledLink.batchSummary", { total: links.length, updated, skipped: links.length - updated }));
  }

  clear(): void { this.cache.clear(); this.pending.clear(); }

  private config(): TitledLinkConfig {
    return this.context.settings.getFeature<TitledLinkConfig>("titled-link");
  }

  private async runLink(link: HTMLElement, protyle: any, mode: "auto" | "manual" | "batch"): Promise<LinkActionResult> {
    if (!this.scope.active) return "aborted";
    const target = captureLinkTarget(link, protyle);
    if (!target || !isHttpUrl(target.originalHref)) return "failed";
    if (mode === "auto" && !isAutomaticLinkCandidate(target.originalText, target.originalHref)) return "failed";
    const token = (this.tokens.get(link) ?? 0) + 1;
    this.tokens.set(link, token);
    let loadingTimer: ReturnType<typeof setTimeout> | undefined;
    if (mode === "manual") loadingTimer = setTimeout(() => {
      if (this.current(target, token)) this.notify(this.t("titledLink.loading"));
    }, 1_000);
    try {
      const fetched = await this.titleFor(target, mode);
      if (!this.current(target, token)) return this.scope.active ? "superseded" : "aborted";
      if (fetched.status === "failure") {
        if (mode === "manual") this.notify(this.t("titledLink.failed"));
        return "failed";
      }
      const result = await commitLinkTitle(target, fetched.title, {
        replaceTitle: this.config().replaceTitle,
        signal: this.scope.signal,
        kernel: this.kernel,
        isComposing: this.options.isComposing,
      });
      if (!this.current(target, token)) return this.scope.active ? "superseded" : "aborted";
      if (mode === "manual" && (result === "updated" || result === "unchanged")) {
        this.cache.refresh(target.originalHref, fetched.title);
      }
      if (mode === "manual") this.notify(this.t(result === "updated"
        ? fetched.fallback ? "titledLink.fallbackUsed" : "titledLink.updated"
        : result === "unchanged" ? "titledLink.unchanged"
          : result === "conflict" ? "titledLink.conflict" : "titledLink.failed"));
      return result;
    } catch (error) {
      if (!this.current(target, token)) return this.scope.active ? "superseded" : "aborted";
      this.context.logger.warn("链接标题提取失败", error);
      if (mode === "manual") this.notify(this.t("titledLink.failed"));
      return "failed";
    } finally {
      if (loadingTimer) clearTimeout(loadingTimer);
    }
  }

  private async prepareBatch(link: HTMLElement, protyle: any): Promise<BatchOutcome> {
    if (!this.scope.active) return { result: "aborted" };
    const target = captureLinkTarget(link, protyle);
    if (!target || !isHttpUrl(target.originalHref)) return { result: "failed" };
    const token = (this.tokens.get(link) ?? 0) + 1;
    this.tokens.set(link, token);
    try {
      const fetched = await this.titleFor(target, "batch");
      if (!this.current(target, token)) {
        return { result: this.scope.active ? "superseded" : "aborted" };
      }
      if (fetched.status === "failure") return { result: "failed" };
      return {
        result: "failed",
        candidate: { target, title: fetched.title, fallback: fetched.fallback, token },
      };
    } catch (error) {
      if (!this.current(target, token)) return { result: this.scope.active ? "superseded" : "aborted" };
      this.context.logger.warn("链接标题提取失败", error);
      return { result: "failed" };
    }
  }

  private current(target: LinkOccurrenceTarget, token: number): boolean {
    return this.scope.active && this.tokens.get(target.linkElement) === token;
  }

  private async titleFor(target: LinkOccurrenceTarget, mode: "auto" | "manual" | "batch"): Promise<TitleFetchResult> {
    const url = target.originalHref;
    const config = this.config();
    const staticName = extractStaticFileName(url);
    if (staticName) return { status: "success", url, title: staticName, source: "static-file", fallback: false };
    if (mode === "auto") {
      const cached = this.cache.get(url);
      if (cached) return { status: "success", url, title: cached, source: "title", fallback: false };
    }
    if (mode !== "manual") {
      const inFlight = this.pending.get(url);
      if (inFlight) return inFlight;
    }
    const generation = this.cache.captureGeneration(url);
    const request = this.fetchAndNormalize(url, config).then(result => {
      if (mode === "auto" && result.status === "success" && this.scope.active) {
        this.cache.set(url, result.title, generation);
      }
      return result;
    });
    if (mode !== "manual") this.pending.set(url, request);
    try { return await request; }
    finally { if (this.pending.get(url) === request) this.pending.delete(url); }
  }

  private async fetchAndNormalize(url: string, config: TitledLinkConfig): Promise<TitleFetchResult> {
    try {
      const resource = await fetchTitleResource({
        url, frontend: this.frontend(), userAgent: this.context.settings.getUserAgent(),
        kernelClient: this.kernel, signal: this.scope.signal, fetchImpl: this.options.fetchImpl,
      });
      if (!resource.ok) {
        if (resource.body instanceof ReadableStream) await resource.body.cancel();
        throw new Error(`HTTP ${resource.status}`);
      }
      const decoded = await readAndDecodeTitleResource(resource, { signal: this.scope.signal });
      if (this.scope.signal.aborted) return { status: "failure", url, reason: "aborted" };
      const found = extractNormalizedTitle(decoded.html, url, config);
      if (found) return { status: "success", url, ...found, fallback: found.source === "hostname" };
      return { status: "failure", url, reason: "missing-title" };
    } catch (error) {
      if (this.scope.signal.aborted) return { status: "failure", url, reason: "aborted" };
      const fallback = extractNormalizedTitle("", url, config);
      if (fallback) return { status: "success", url, ...fallback, fallback: true };
      return { status: "failure", url, reason: "network", error };
    }
  }
}

function matchingLinks(block: HTMLElement, href: string): HTMLElement[] {
  return [...block.querySelectorAll<HTMLElement>('span[data-type~="a"]')]
    .filter(link => link.getAttribute("data-href") === href);
}

function nativePasteLinkEnabled(): boolean {
  const host = globalThis as typeof globalThis & {
    siyuan?: { config?: { editor?: { pasteURLAutoConvert?: boolean } } };
  };
  return host.siyuan?.config?.editor?.pasteURLAutoConvert === true;
}
