import { isAbortError } from "../../../core/feedback/UiFeedback.ts";
import { isInsideProtectedContainer } from "../../../core/host/dom.ts";
import { combineSignals } from "../../../core/host/ProtyleAdapter.ts";
import type { FeatureScope } from "../../../core/framework/FeatureScope.ts";
import {
  localizeRemoteAsset,
  type ImageProcessingServices,
} from "../services/ImageProcessingServices.ts";
import { recaptureReplacedImageOccurrence } from "../services/ImageOccurrenceResolver.ts";
import { isSmartCompressionEffective } from "../services/smartCompressionProbe.ts";
import { blockDOM } from "../services/SafeBlockWriter.ts";
import type { OccurrenceTarget } from "../policy/contracts.ts";
import { autoAllowed, type ImageConfig } from "../policy/parseImageConfig.ts";
import { parseSingleLeafBlock, scanImageRefs } from "../policy/dom.ts";
import { imageSourceAttribute, resolveSource, trySource, type ImageSource } from "../policy/source.ts";
import { classifyImageCandidate } from "../policy/ImageCandidateClassifier.ts";
import { buildAutoUploadNotice, type AutoUploadNotice } from "./AutoUploadHandler.ts";

export interface DocumentRow {
  id: string;
  box: string;
}

type RemoteProcessOutcome =
  | { kind: "replaced"; originalBytes?: number; compressedBytes?: number }
  | { kind: "skipped" }
  | { kind: "failed" }
  | { kind: "unknown" };

interface Candidate { blockID: string; source: ImageSource; count: number }
export type RemoteWatcherLogger = Pick<Console, "warn"> & {
  debug?: (message: string, data?: unknown) => void;
};
export interface RemoteWatcherHandle {
  dispose(): void;
  pause(): void;
  resume(): void;
  reconcile(): Promise<void>;
}

const MAX_REMOTE_BATCH_SIZE = 20;

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
      smartEnabled: isSmartCompressionEffective(config.compression.smartEnabled),
    });
    return decision.eligible ? [candidate] : [];
  });
}

/** Observe persisted document DOM and localize newly inserted remote images first. */
export async function watchRemoteImages(
  editor: HTMLElement, doc: DocumentRow, scope: FeatureScope,
  services: ImageProcessingServices, logger: RemoteWatcherLogger = console,
  initSignal?: AbortSignal,
  onNotice?: (notice: AutoUploadNotice) => void,
): Promise<RemoteWatcherHandle> {
  const owned = new AbortController();
  const abortFromScope = () => owned.abort(scope.signal.reason);
  if (scope.signal.aborted) abortFromScope();
  else scope.signal.addEventListener("abort", abortFromScope, { once: true });
  const signal = owned.signal;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let watchAbort: AbortController | undefined;
  let baselineInFlight = false;
  let disposed = false, paused = false, rebasing = false, reading = false, rerun = false;
  let pendingInsertConfirm = false;
  let observing = false;
  let previous: Map<string, Candidate> = new Map();
  const inFlight = new Set<string>();
  const tasks = new Set<AbortController>();
  const hasPersistedTarget = new Map<AbortController, boolean>();
  const keyOf = (blockID: string, key: string) => `${blockID}\n${key}`;

  const cancelWatchReads = () => {
    baselineInFlight = false;
    watchAbort?.abort();
    watchAbort = undefined;
  };

  const readSnapshot = async (readSignal: AbortSignal): Promise<Map<string, Candidate>> => {
    const dom = await blockDOM(services.kernel, doc.id, doc.box, readSignal);
    const result = new Map<string, Candidate>();
    for (const { blockID, source } of scanImageRefs(dom, services.origin)) {
      if (source.kind !== "remote") continue;
      const identity = keyOf(blockID, source.key), found = result.get(identity);
      if (found) found.count++;
      else result.set(identity, { blockID, source, count: 1 });
    }
    return result;
  };

  const isRemoteSourceRaw = (raw: string | null | undefined): boolean => {
    if (!raw) return false;
    return trySource(raw, services.origin)?.kind === "remote";
  };

  const isUnprotectedRemoteImage = (img: Element): boolean => {
    if (isInsideProtectedContainer(img)) return false;
    return isRemoteSourceRaw(imageSourceAttribute(img));
  };

  const hasUnprotectedRemoteImage = (node: Node): boolean => {
    if (!(node instanceof Element) || isInsideProtectedContainer(node)) return false;
    if (typeof node.matches === "function" && node.matches("img")) {
      return isUnprotectedRemoteImage(node);
    }
    if (typeof node.querySelectorAll !== "function") return false;
    return [...node.querySelectorAll("img")].some(isUnprotectedRemoteImage);
  };

  const observer = new MutationObserver(records => {
    let hasInsert = false;
    let hasRemoval = false;
    for (const record of records) {
      if (record.type === "attributes") {
        const target = record.target;
        if (
          target instanceof Element &&
          (target.tagName === "IMG" || (typeof target.matches === "function" && target.matches("img"))) &&
          !isInsideProtectedContainer(target)
        ) {
          if (isUnprotectedRemoteImage(target)) {
            hasInsert = true;
          } else if (previous.size > 0 && isRemoteSourceRaw(record.oldValue)) {
            hasRemoval = true;
          }
        }
        continue;
      }
      if (record.target instanceof Element && isInsideProtectedContainer(record.target)) continue;
      if ([...record.addedNodes].some(hasUnprotectedRemoteImage)) hasInsert = true;
      else if (previous.size > 0 && [...record.removedNodes].some(hasUnprotectedRemoteImage)) hasRemoval = true;
    }
    if (hasInsert) schedule(450, true);
    else if (hasRemoval) schedule(450, false);
  });
  const observe = () => {
    if (observing || disposed || paused || !scope.active || signal.aborted) return;
    observing = true;
    observer.observe(editor, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeOldValue: true,
      attributeFilter: ["src", "data-src"],
    });
  };

  const stopWatching = () => {
    observing = false;
    cancelWatchReads();
    observer.disconnect();
    if (timer !== undefined) clearTimeout(timer);
    timer = undefined;
    rerun = false;
    pendingInsertConfirm = false;
    rebasing = false;
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

  async function rebuildBaseline(extraSignal?: AbortSignal): Promise<void> {
    if (disposed || paused || !scope.active || signal.aborted || extraSignal?.aborted) return;
    if (!autoAllowed(services.config(), doc.id)) {
      stopWatching();
      return;
    }
    stopWatching();
    const ctrl = new AbortController();
    watchAbort = ctrl;
    baselineInFlight = true;
    const readSignal = combineSignals(signal, ctrl.signal, extraSignal) ?? ctrl.signal;
    try {
      const value = await readSnapshot(readSignal);
      if (readSignal.aborted || disposed || paused || !autoAllowed(services.config(), doc.id)) return;
      previous = value;
      observe();
    } catch (error) {
      if (!readSignal.aborted && !isAbortError(error) && scope.active) logger.warn("重建图片基线失败", error);
    } finally {
      if (watchAbort === ctrl) {
        watchAbort = undefined;
        baselineInFlight = false;
      }
    }
  }

  async function process(candidate: Candidate, oldCount: number): Promise<RemoteProcessOutcome | undefined> {
    // Duplicate identical remote references cannot be mapped to one physical image safely.
    if (disposed || paused || !scope.active || signal.aborted || oldCount !== 0 || candidate.count !== 1) {
      logger.debug?.("跳过外链图片处理：重复引用或观察未激活", {
        blockID: candidate.blockID,
        oldCount,
        count: candidate.count,
      });
      return;
    }
    const config = services.config();
    if (!autoAllowed(config, doc.id)) {
      logger.debug?.("跳过外链图片处理：当前文档未启用自动压缩", { rootID: doc.id, blockID: candidate.blockID });
      return;
    }
    const taskKey = keyOf(candidate.blockID, candidate.source.key);
    if (inFlight.has(taskKey)) {
      logger.debug?.("跳过外链图片处理：相同任务正在进行", { blockID: candidate.blockID });
      return;
    }
    inFlight.add(taskKey);
    const task = new AbortController();
    const abortTask = () => task.abort(signal.reason);
    signal.addEventListener("abort", abortTask, { once: true });
    tasks.add(task);
    hasPersistedTarget.set(task, false);
    try {
      const persistedDOM = await blockDOM(services.kernel, candidate.blockID, doc.box, task.signal);
      const block = parseSingleLeafBlock(persistedDOM, candidate.blockID);
      if (!block) {
        logger.debug?.("外链图片持久化块为空或存在嵌套，跳过", { blockID: candidate.blockID });
        return;
      }
      const images = [...block.querySelectorAll("img")];
      let matchedOrdinal = -1;
      let matchedRaw = "";
      for (let i = 0; i < images.length; i++) {
        const raw = imageSourceAttribute(images[i]);
        if (!raw) continue;
        try {
          if (resolveSource(raw, services.origin).key === candidate.source.key) {
            if (matchedOrdinal >= 0) {
              logger.debug?.("同块存在多张相同外链图片，跳过处理", { blockID: candidate.blockID });
              return;
            }
            matchedOrdinal = i;
            matchedRaw = raw;
          }
        } catch {
          // Ignore malformed image src
        }
      }
      if (matchedOrdinal < 0 || matchedRaw !== candidate.source.raw || !scope.active || task.signal.aborted) {
        logger.debug?.("外链图片在持久化块中未匹配或已变更，跳过", {
          blockID: candidate.blockID,
          matchedOrdinal,
          pathChanged: matchedRaw !== candidate.source.raw,
        });
        return;
      }
      const target: OccurrenceTarget = {
        rootID: doc.id,
        notebook: doc.box,
        blockID: candidate.blockID,
        imageOrdinal: matchedOrdinal,
        oldPath: matchedRaw,
      };
      hasPersistedTarget.set(task, true);

      if (candidate.source.kind !== "remote") return;
      const { localPath: localOriginal, file: providedFile } = await localizeRemoteAsset(
        services,
        candidate.source,
        doc.id,
        task.signal,
      );
      if (!scope.active || task.signal.aborted) return;
      const localSource = resolveSource(localOriginal, services.origin);
      if (localSource.kind !== "asset") return;

      // Localization is a standalone commit. Even unsupported/too-small images remain
      // safely referenced by their local original if later compression is skipped.
      const localized = await services.references.commitOccurrence(target, localOriginal, task.signal);
      if (localized !== "aborted") {
        await services.records.markOperation(
          candidate.source.url,
          localOriginal,
          localized === "replaced" ? "replaced" : "incomplete",
        ).catch(() => undefined);
      }
      if (localized === "failed") {
        logger.warn("自动本地化外链图片被内核拒绝", { blockID: target.blockID, path: localOriginal });
        return { kind: "failed" };
      }
      if (localized === "unknown") {
        logger.warn("自动本地化外链图片结果未确认", { blockID: target.blockID, path: localOriginal });
        return { kind: "unknown" };
      }
      if (localized !== "replaced" || !scope.active || task.signal.aborted) {
        logger.debug?.("外链图片本地化未完成替换，跳过后续压缩", { blockID: target.blockID, localized });
        return localized === "aborted" ? undefined : { kind: "skipped" };
      }

      const nextTarget = await recaptureReplacedImageOccurrence(
        services.kernel,
        target,
        localOriginal,
        services.origin,
        task.signal,
      );
      if (!nextTarget) {
        logger.debug?.("本地化后块内图片路径已变化或块结构异常，跳过压缩", {
          blockID: target.blockID,
          imageOrdinal: target.imageOrdinal,
        });
        return { kind: "skipped" };
      }
      if (!scope.active || task.signal.aborted) return;

      // prepareImage persists the Dock mapping before a compressed path is eligible for
      // replacement. A skipped format/threshold leaves the localized original in place.
      const currentConfig = services.config();
      if (!autoAllowed(currentConfig, doc.id) || !scope.active || task.signal.aborted) return;
      const compressed = await services.compressOccurrence(nextTarget, currentConfig, task.signal,
        { mode: "auto", replace: true, providedFile });
      if (compressed.status === "skipped") {
        logger.debug?.("本地化后的外链图片压缩跳过，保留本地原图", { blockID: nextTarget.blockID, path: nextTarget.oldPath });
        return { kind: "skipped" };
      }
      if (compressed.reference === "replaced") {
        return {
          kind: "replaced",
          originalBytes: compressed.originalBytes,
          compressedBytes: compressed.compressedBytes,
        };
      }
      if (compressed.reference === "aborted") {
        return undefined;
      }
      logger.warn("自动处理外链图片的压缩引用更新未能确认", compressed.reference);
      if (compressed.reference === "unknown") return { kind: "unknown" };
      if (compressed.reference === "failed") return { kind: "failed" };
      return { kind: "skipped" };
    } catch (error) {
      if (!task.signal.aborted && scope.active) {
        logger.warn("自动处理外链图片失败", error);
        return { kind: "failed" };
      }
      return undefined;
    } finally {
      tasks.delete(task);
      hasPersistedTarget.delete(task);
      inFlight.delete(taskKey);
      signal.removeEventListener("abort", abortTask);
      if (disposed && !tasks.size) scope.signal.removeEventListener("abort", abortFromScope);
    }
  }

  async function sweep(confirmIfEmpty = false): Promise<void> {
    if (disposed || paused || !scope.active || signal.aborted || !observing) return;
    if (!autoAllowed(services.config(), doc.id)) return;
    if (reading) {
      if (confirmIfEmpty) pendingInsertConfirm = true;
      rerun = true;
      return;
    }
    reading = true;
    const ctrl = new AbortController();
    watchAbort = ctrl;
    const readSignal = combineSignals(signal, ctrl.signal) ?? ctrl.signal;
    try {
      const current = await readSnapshot(readSignal);
      if (readSignal.aborted || disposed || paused || !observing || !autoAllowed(services.config(), doc.id)) return;
      const old = previous;
      previous = current;
      if (rebasing) { rebasing = false; return; }
      const added = addedRemoteCandidates(old, current, services.config(), doc.id);
      if (!added.length && confirmIfEmpty && !paused && !disposed && observing && !signal.aborted && !rerun) {
        schedule(900, false);
        return;
      }
      let successful = 0, skipped = 0, failed = 0, unknownCount = 0;
      let singleOriginalBytes: number | undefined;
      let singleCompressedBytes: number | undefined;
      const recordOutcome = (outcome: RemoteProcessOutcome | undefined) => {
        if (!outcome) return;
        if (outcome.kind === "replaced") {
          successful++;
          singleOriginalBytes = outcome.originalBytes;
          singleCompressedBytes = outcome.compressedBytes;
        } else if (outcome.kind === "skipped") {
          skipped++;
        } else if (outcome.kind === "failed") {
          failed++;
        } else {
          unknownCount++;
        }
      };

      const blockTails = new Map<string, Promise<void>>();
      for (let start = 0; start < added.length; start += MAX_REMOTE_BATCH_SIZE) {
        if (disposed || paused || !scope.active || signal.aborted) break;
        const batch = added.slice(start, start + MAX_REMOTE_BATCH_SIZE);
        const currentConfig = services.config();
        const concurrency = services.mobile ? 1 : Math.max(1, currentConfig.compression.concurrencyDesktop ?? 3);
        let nextIdx = 0;
        const worker = async () => {
          while (nextIdx < batch.length) {
            if (disposed || paused || !scope.active || signal.aborted) return;
            const candidate = batch[nextIdx++];
            const identity = keyOf(candidate.blockID, candidate.source.key);
            const oldCount = old.get(identity)?.count ?? 0;
            // 同一块内的操作按队列顺序串行执行，避免并发改写相互影响节点顺序。
            const prevTail = blockTails.get(candidate.blockID) ?? Promise.resolve();
            const run = prevTail.catch(() => undefined).then(async () => {
              if (disposed || paused || !scope.active || signal.aborted) return;
              recordOutcome(await process(candidate, oldCount));
            });
            blockTails.set(candidate.blockID, run);
            await run;
          }
        };
        const workers = Array.from({ length: Math.min(concurrency, batch.length) }, () => worker());
        await Promise.all(workers);
      }

      if (scope.active) {
        const notice = buildAutoUploadNotice({
          successful,
          skipped,
          failed,
          unknownCount,
          singleOriginalBytes,
          singleCompressedBytes,
        });
        if (notice) onNotice?.(notice);
      }
    } catch (error) {
      if (!readSignal.aborted && !isAbortError(error) && scope.active) logger.warn("读取持久化图片状态失败", error);
    } finally {
      if (watchAbort === ctrl) watchAbort = undefined;
      reading = false;
      if (rerun && !paused && !disposed && observing) {
        rerun = false;
        const nextConfirm = pendingInsertConfirm;
        pendingInsertConfirm = false;
        schedule(350, nextConfirm);
      }
    }
  }
  function schedule(delay = 450, confirmIfEmpty = false): void {
    if (paused || disposed || !observing) return;
    if (confirmIfEmpty) pendingInsertConfirm = true;
    if (timer !== undefined) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = undefined;
      const shouldConfirm = pendingInsertConfirm;
      pendingInsertConfirm = false;
      void sweep(shouldConfirm);
    }, delay);
  }
  const onUndo = (event: Event) => {
    if (!observing || paused || disposed) return;
    const type = (event as InputEvent).inputType;
    if (type === "historyUndo" || type === "historyRedo") { rebasing = true; schedule(200); }
  };
  const onSyncStart = () => {
    paused = true; stopWatching();
    for (const task of tasks) task.abort("Sync started");
    tasks.clear();
  };
  const onSyncEnd = () => {
    if (disposed || !scope.active || signal.aborted || !paused) return;
    paused = false;
    if (!autoAllowed(services.config(), doc.id)) {
      stopWatching();
      return;
    }
    void rebuildBaseline();
  };
  const reconcile = async (): Promise<void> => {
    if (disposed || !scope.active || signal.aborted) return;
    if (!autoAllowed(services.config(), doc.id)) {
      // 无论是否已进入 observing，撤权时均无条件中止在途读与未落盘任务
      stopWatching();
      for (const task of tasks) {
        if (!hasPersistedTarget.get(task)) task.abort("Document permission revoked");
      }
      return;
    }
    if (!observing && !paused && !baselineInFlight) {
      await rebuildBaseline();
    }
  };
  await rebuildBaseline(initSignal);
  if (disposed || !scope.active || signal.aborted || initSignal?.aborted) {
    release();
    return { dispose() {}, pause() {}, resume() {}, async reconcile() {} };
  }
  editor.addEventListener("beforeinput", onUndo, true);
  return { dispose: release, pause: onSyncStart, resume: onSyncEnd, reconcile };
}
