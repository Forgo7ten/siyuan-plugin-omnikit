import type { FeatureScope } from "../../core/FeatureScope.ts";
import { prepareImage, type ImageProcessingServices } from "./ImageProcessingServices.ts";
import { autoAllowed, type ImageConfig } from "./parseImageConfig.ts";
import { blockDOM, type DocumentRow } from "./references.ts";
import { scanDOM } from "./dom.ts";
import { resolveSource, type ImageSource } from "./source.ts";

interface Candidate { blockID: string; source: ImageSource; count: number }
export type RemoteWatcherLogger = Pick<Console, "warn">;
export interface RemoteWatcherHandle { dispose(): void; pause(): void; resume(): void }

/** Pure policy seam: only a persisted increase in a remote HTTP(S) image is eligible. */
export function addedRemoteCandidates(
  previous: ReadonlyMap<string, Candidate>, current: ReadonlyMap<string, Candidate>,
  config: ImageConfig, rootID: string,
): Candidate[] {
  if (!config.auto.remoteImages || !autoAllowed(config, rootID)) return [];
  return [...current].flatMap(([key, candidate]) => {
    if (candidate.source.kind !== "remote" || candidate.count <= (previous.get(key)?.count ?? 0)) return [];
    const url = new URL(candidate.source.url);
    return ["https:", "http:"].includes(url.protocol) ? [candidate] : [];
  });
}

/** Observe one editor while using the kernel's complete persisted DOM as the source of truth. */
export async function watchRemoteImages(
  editor: HTMLElement, doc: DocumentRow, scope: FeatureScope,
  services: ImageProcessingServices, logger: RemoteWatcherLogger = console,
): Promise<RemoteWatcherHandle> {
  const owned = new AbortController();
  const abortFromScope = () => owned.abort(scope.signal.reason);
  if (scope.signal.aborted) abortFromScope();
  else scope.signal.addEventListener("abort", abortFromScope, { once: true });
  const signal = owned.signal;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let disposed = false, paused = false, rebasing = false, reading = false, rerun = false;
  let previous: Map<string, Candidate>;
  const tasks = new Set<AbortController>();
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

  // This complete persisted snapshot prevents folded/offscreen images from looking new.
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
    for (const task of tasks) task.abort("Remote image watcher disposed");
    tasks.clear();
    signal.removeEventListener("abort", stopWatching);
    scope.signal.removeEventListener("abort", abortFromScope);
    editor.removeEventListener("beforeinput", onUndo, true);
  };
  const release = scope.own(dispose);
  signal.addEventListener("abort", stopWatching, { once: true });

  async function process(candidate: Candidate, oldCount: number): Promise<void> {
    if (disposed || paused || !scope.active || signal.aborted) return;
    const config = services.config();
    if (!addedRemoteCandidates(new Map(), new Map([["candidate", candidate]]), config, doc.id).length) return;

    const task = new AbortController();
    const abortTask = () => task.abort(signal.reason);
    signal.addEventListener("abort", abortTask, { once: true });
    tasks.add(task);
    try {
      const persisted = scanDOM(await blockDOM(services.kernel, candidate.blockID, doc.box, task.signal), services.origin)
        .filter(ref => ref.kind === "image" && ref.key === candidate.source.key);
      // If the block changed again, leave it for a fresh persisted observation.
      if (persisted.length !== candidate.count || candidate.count <= oldCount) return;
      const prepared = await prepareImage(services, candidate.source, doc.id,
        { kind: "remote-auto", rootID: doc.id, blockID: candidate.blockID }, config, task.signal);
      if (!prepared || !scope.active || task.signal.aborted) return;
      const mapping = { key: candidate.source.key, oldPath: candidate.source.raw, newPath: prepared.path,
        selection: { blockID: candidate.blockID, expectedCount: candidate.count,
          imageIndices: Array.from({ length: candidate.count }, (_, i) => i) } };
      const plan = await services.references.plan([mapping], doc, config.references.maxDocuments,
        true, candidate.blockID, task.signal);
      if (plan.backend !== "sql" || plan.patches.some(patch => patch.id !== candidate.blockID)) return;
      const result = await services.references.commit(plan, task.signal);
      if (result.state !== "verified") logger.warn("自动处理外链图片的引用更新未能确认", result.reason ?? result.state);
    } catch (error) {
      if (!task.signal.aborted && scope.active) logger.warn("自动处理外链图片失败", error);
    } finally {
      tasks.delete(task);
      signal.removeEventListener("abort", abortTask);
    }
  }

  async function sweep(): Promise<void> {
    if (disposed || paused || !scope.active || signal.aborted) return;
    if (reading) { rerun = true; return; }
    reading = true;
    try {
      const current = await snapshot();
      const old = previous;
      previous = current;
      if (rebasing) { rebasing = false; return; }
      const config = services.config();
      const added = addedRemoteCandidates(old, current, config, doc.id);
      if (added.length > 20) { logger.warn("检测到大量新增外链图片，请使用文档批量操作"); return; }
      for (const candidate of added) {
        const identity = keyOf(candidate.blockID, candidate.source.key);
        const oldCount = old.get(identity)?.count ?? 0;
        // Sequential processing prevents two plans from racing on the same editor block.
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
      // A bounded second read catches persistence that trails the editor mutation.
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
    if (type === "historyUndo" || type === "historyRedo") {
      rebasing = true;
      schedule(200);
    }
  };
  const onSyncStart = () => {
    paused = true; stopWatching();
    for (const task of tasks) task.abort("Sync started");
    tasks.clear();
  };
  const onSyncEnd = () => {
    void snapshot().then(value => { if (!disposed && scope.active) { previous = value; paused = false; observe(); } })
      .catch(error => { if (!signal.aborted) logger.warn("同步后重建图片基线失败", error); });
  };
  editor.addEventListener("beforeinput", onUndo, true);
  observe();
  return { dispose: release, pause: onSyncStart, resume: onSyncEnd };
}
