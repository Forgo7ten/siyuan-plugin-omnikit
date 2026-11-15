import type { FeatureScope } from "../../core/FeatureScope.ts";
import { waitForPersistedImageOccurrence, type ImageOccurrenceEvidence } from "./ImageOccurrenceResolver.ts";
import type { ImageProcessingServices } from "./ImageProcessingServices.ts";
import { autoAllowed, type ImageConfig } from "./parseImageConfig.ts";
import { blockDOM, type DocumentRow } from "./references.ts";
import { scanDOM } from "./dom.ts";
import { resolveSource, type ImageSource } from "./source.ts";
import { classifyImageCandidate } from "./ImageCandidateClassifier.ts";

interface Candidate { blockID: string; source: ImageSource; count: number }
export type RemoteWatcherLogger = Pick<Console, "warn">;
export interface RemoteWatcherHandle { dispose(): void; pause(): void; resume(): void }

/** Only a newly persisted, authorized HTTP(S) image may be localized. */
export function addedRemoteCandidates(
  previous: ReadonlyMap<string, Candidate>, current: ReadonlyMap<string, Candidate>,
  config: ImageConfig, rootID: string,
): Candidate[] {
  if (!autoAllowed(config, rootID)) return [];
  return [...current].flatMap(([key, candidate]) => {
    if (candidate.source.kind !== "remote" || candidate.count <= (previous.get(key)?.count ?? 0)) return [];
    const decision = classifyImageCandidate({
      path: candidate.source.raw,
      mode: "auto",
      excludedExtensions: config.compression.excludedExtensions,
    });
    if (!decision.eligible) return [];
    try {
      const url = new URL(candidate.source.url);
      return ["https:", "http:"].includes(url.protocol) ? [candidate] : [];
    } catch { return []; }
  });
}

/** Observe persisted document DOM and localize newly inserted remote images first. */
export async function watchRemoteImages(
  editor: HTMLElement, doc: DocumentRow, scope: FeatureScope,
  services: ImageProcessingServices, logger: RemoteWatcherLogger = console,
): Promise<RemoteWatcherHandle> {
  if (!autoAllowed(services.config(), doc.id)) {
    return { dispose() {}, pause() {}, resume() {} };
  }
  const owned = new AbortController();
  const abortFromScope = () => owned.abort(scope.signal.reason);
  if (scope.signal.aborted) abortFromScope();
  else scope.signal.addEventListener("abort", abortFromScope, { once: true });
  const signal = owned.signal;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let disposed = false, paused = false, rebasing = false, reading = false, rerun = false;
  let previous: Map<string, Candidate>;
  const inFlight = new Set<string>();
  const tasks = new Set<AbortController>();
  const hasPersistedTarget = new Map<AbortController, boolean>();
  const keyOf = (blockID: string, key: string) => `${blockID}\n${key}`;

  const snapshot = async (): Promise<Map<string, Candidate>> => {
    const dom = await blockDOM(services.kernel, doc.id, doc.box, signal);
    const result = new Map<string, Candidate>();
    for (const ref of scanDOM(dom, services.origin)) {
      if (ref.kind !== "image") continue;
      const identity = keyOf(ref.blockID, ref.key), found = result.get(identity);
      if (found) found.count++;
      else result.set(identity, { blockID: ref.blockID, source: resolveSource(ref.raw, services.origin), count: 1 });
    }
    return result;
  };

  previous = await snapshot();
  if (!scope.active || signal.aborted) {
    scope.signal.removeEventListener("abort", abortFromScope);
    return { dispose() {}, pause() {}, resume() {} };
  }

  const stopWatching = () => {
    observer.disconnect();
    if (timer !== undefined) clearTimeout(timer);
    timer = undefined;
  };
  const dispose = () => {
    if (disposed) return;
    disposed = true;
    stopWatching();
    signal.removeEventListener("abort", stopWatching);
    for (const task of tasks) {
      if (!hasPersistedTarget.get(task)) task.abort("Editor closed before image position was persisted");
    }
    if (!tasks.size) scope.signal.removeEventListener("abort", abortFromScope);
    editor.removeEventListener("beforeinput", onUndo, true);
  };
  const release = scope.own(dispose);
  signal.addEventListener("abort", stopWatching, { once: true });

  async function process(candidate: Candidate, oldCount: number): Promise<void> {
    // Duplicate identical remote references cannot be mapped to one physical image safely.
    if (disposed || paused || !scope.active || signal.aborted || oldCount !== 0 || candidate.count !== 1) return;
    const config = services.config();
    if (!autoAllowed(config, doc.id)) return;
    const decision = classifyImageCandidate({
      path: candidate.source.raw,
      mode: "auto",
      excludedExtensions: config.compression.excludedExtensions,
    });
    if (!decision.eligible) return;
    const taskKey = keyOf(candidate.blockID, candidate.source.key);
    if (inFlight.has(taskKey)) return;
    inFlight.add(taskKey);
    const task = new AbortController();
    const abortTask = () => task.abort(signal.reason);
    signal.addEventListener("abort", abortTask, { once: true });
    tasks.add(task);
    hasPersistedTarget.set(task, false);
    try {
      const persistedDOM = await blockDOM(services.kernel, candidate.blockID, doc.box, task.signal);
      const template = document.createElement("template");
      template.innerHTML = persistedDOM;
      const roots = [...template.content.querySelectorAll("[data-node-id]")]
        .filter(node => node.getAttribute("data-node-id") === candidate.blockID);
      if (roots.length !== 1 || roots[0].querySelector("[data-node-id]")) return;
      const images = [...roots[0].querySelectorAll("img")];
      const matching = images.filter(image => {
        const raw = image.hasAttribute("data-src") ? image.getAttribute("data-src") : image.getAttribute("src");
        try { return raw && resolveSource(raw, services.origin).key === candidate.source.key; }
        catch { return false; }
      });
      if (matching.length !== 1) return;
      const imageOrdinal = images.indexOf(matching[0]);
      const evidence: ImageOccurrenceEvidence = {
        rootID: doc.id, notebook: doc.box, blockID: candidate.blockID,
        imageOrdinal, oldPath: candidate.source.raw,
      };
      const target = await waitForPersistedImageOccurrence(services.kernel, evidence, 1, task.signal);
      if (!target || !scope.active || task.signal.aborted) return;
      hasPersistedTarget.set(task, true);

      const downloaded = await services.reader.read(candidate.source, {
        maxBytes: Math.min(config.compression.maxInputBytes, 32 * 1024 * 1024), timeoutMs: 30_000, signal: task.signal,
        userAgent: services.userAgent(),
      });
      await assertImagePayload(downloaded.blob);
      if (!scope.active || task.signal.aborted) return;
      const localOriginal = await services.assets.upload(
        new File([downloaded.blob], safeFileName(downloaded.name || candidate.source.name), { type: downloaded.blob.type }),
        doc.id, task.signal,
      );
      const localSource = resolveSource(localOriginal, services.origin);
      if (localSource.kind !== "asset") return;

      // Localization is a standalone commit. Even unsupported/too-small images remain
      // safely referenced by their local original if later compression is skipped.
      const localized = await services.references.commitOccurrence(target, localOriginal, task.signal);
      if (localized !== "replaced" || !scope.active || task.signal.aborted) return;

      const updatedDOM = await blockDOM(services.kernel, target.blockID, target.notebook, task.signal);
      const updatedTemplate = document.createElement("template");
      updatedTemplate.innerHTML = updatedDOM;
      const updatedOwner = [...updatedTemplate.content.querySelectorAll("[data-node-id]")]
        .find(node => node.getAttribute("data-node-id") === target.blockID);
      const updatedImages = [...(updatedOwner?.querySelectorAll("img") ?? [])];
      const localizedMatches = updatedImages.filter(image => {
        const raw = image.hasAttribute("data-src") ? image.getAttribute("data-src") : image.getAttribute("src");
        try { return raw && resolveSource(raw, services.origin).key === localSource.key; }
        catch { return false; }
      });
      const selected = updatedImages[target.imageOrdinal];
      const selectedRaw = selected && (selected.hasAttribute("data-src") ? selected.getAttribute("data-src") : selected.getAttribute("src"));
      if (!selected || localizedMatches.length !== 1 || !selectedRaw || resolveSource(selectedRaw, services.origin).key !== localSource.key) return;
      const nextTarget = { ...target, oldPath: localOriginal, baselineBlockDOM: updatedDOM };

      // prepareImage persists the Dock mapping before a compressed path is eligible for
      // replacement. A skipped format/threshold leaves the localized original in place.
      const currentConfig = services.config();
      if (!autoAllowed(currentConfig, doc.id) || !scope.active || task.signal.aborted) return;
      const compressed = await services.compressOccurrence(nextTarget, currentConfig, task.signal,
        { mode: "auto", replace: true });
      if (compressed.status === "saved" && compressed.reference !== "replaced") {
        logger.warn("自动处理外链图片的压缩引用更新未能确认", compressed.reference);
      }
    } catch (error) {
      if (!task.signal.aborted && scope.active) logger.warn("自动处理外链图片失败", error);
    } finally {
      tasks.delete(task);
      hasPersistedTarget.delete(task);
      inFlight.delete(taskKey);
      signal.removeEventListener("abort", abortTask);
      if (disposed && !tasks.size) scope.signal.removeEventListener("abort", abortFromScope);
    }
  }

  async function sweep(): Promise<void> {
    if (disposed || paused || !scope.active || signal.aborted) return;
    if (!autoAllowed(services.config(), doc.id)) return;
    if (reading) { rerun = true; return; }
    reading = true;
    try {
      const current = await snapshot();
      const old = previous;
      previous = current;
      if (rebasing) { rebasing = false; return; }
      const added = addedRemoteCandidates(old, current, services.config(), doc.id);
      if (added.length > 20) { logger.warn("检测到大量新增外链图片，请使用文档批量操作"); return; }
      for (const candidate of added) {
        const identity = keyOf(candidate.blockID, candidate.source.key);
        const oldCount = old.get(identity)?.count ?? 0;
        await process(candidate, oldCount);
      }
    } catch (error) {
      if (!signal.aborted && scope.active) logger.warn("读取持久化图片状态失败", error);
    } finally {
      reading = false;
      if (rerun && !paused && !disposed) { rerun = false; schedule(350); }
    }
  }
  function schedule(delay = 450): void {
    if (paused || disposed) return;
    if (timer !== undefined) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = undefined;
      void sweep();
      timer = setTimeout(() => { timer = undefined; void sweep(); }, 900);
    }, delay);
  }
  const hasImage = (node: Node): boolean => node instanceof Element && (node.matches("img") || !!node.querySelector("img"));
  const observer = new MutationObserver(records => {
    if (records.some(record => record.type === "attributes" && record.target instanceof HTMLImageElement
      || [...record.addedNodes, ...record.removedNodes].some(hasImage))) schedule();
  });
  const observe = () => observer.observe(editor, { childList: true, subtree: true, attributes: true, attributeFilter: ["src", "data-src"] });
  const onUndo = (event: Event) => {
    const type = (event as InputEvent).inputType;
    if (type === "historyUndo" || type === "historyRedo") { rebasing = true; schedule(200); }
  };
  const onSyncStart = () => {
    paused = true; stopWatching();
    for (const task of tasks) task.abort("Sync started");
    tasks.clear();
  };
  const onSyncEnd = () => {
    void snapshot().then(value => {
      if (!disposed && scope.active) { previous = value; paused = false; observe(); }
    }).catch(error => { if (!signal.aborted) logger.warn("同步后重建图片基线失败", error); });
  };
  editor.addEventListener("beforeinput", onUndo, true);
  observe();
  return { dispose: release, pause: onSyncStart, resume: onSyncEnd };
}

export function safeFileName(name: string): string {
  const base = name.replace(/\\/g, "/").split("/").pop() || "remote-image";
  const safe = base.replace(/[\u0000-\u001f<>:"/\\|?*]/g, "_").slice(0, 180);
  return safe || "remote-image";
}

export async function assertImagePayload(blob: Blob): Promise<void> {
  const bytes = new Uint8Array(await blob.slice(0, 4096).arrayBuffer());
  const ascii = (start: number, length: number) => String.fromCharCode(...bytes.slice(start, start + length));
  const png = bytes.length >= 8 && [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]
    .every((byte, index) => bytes[index] === byte);
  const jpeg = bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
  const gif = bytes.length >= 6 && ["GIF87a", "GIF89a"].includes(ascii(0, 6));
  const webp = bytes.length >= 12 && ascii(0, 4) === "RIFF" && ascii(8, 4) === "WEBP";
  const prefix = new TextDecoder().decode(bytes).replace(/^\uFEFF/, "").trimStart();
  const svg = /^(?:<\?xml[^>]*>\s*)?<svg(?:\s|>)/i.test(prefix);
  if (svg) {
    const fullText = await blob.text();
    if (/<!DOCTYPE|<!ENTITY|<script\b|<foreignObject\b|<image\b|<use\b|<iframe\b|<object\b|<embed\b|<style\b|\son[a-z]+\s*=|\b(?:href|src)\s*=|url\s*\(|@import|(?:javascript|data|file):/i.test(fullText)) {
      throw new Error("Unsafe SVG image content");
    }
  }
  if (!png && !jpeg && !gif && !webp && !svg) throw new Error("Remote response is not a supported image payload");
}
