import type { Plugin } from "siyuan";
import type { FeatureScope } from "../../../core/framework/FeatureScope.ts";
import { isInsideProtectedContainer } from "../../../core/host/dom.ts";
import { resolveEditorRootID, resolveNotebookID } from "../../../core/host/ProtyleAdapter.ts";
import { logSkippedImage, type ImageProcessingServices } from "../services/ImageProcessingServices.ts";
import { isSmartCompressionEffective } from "../services/smartCompressionProbe.ts";
import { waitForPersistedImageOccurrence, type ImageOccurrenceEvidence } from "../services/ImageOccurrenceResolver.ts";
import { resolveSource, trySource } from "../policy/source.ts";
import { classifyImageCandidate } from "../policy/ImageCandidateClassifier.ts";
import type { ImageConfig } from "../policy/parseImageConfig.ts";

export interface DebugLogger {
  debug?: (message: string, data?: unknown) => void;
  warn: (message: string, data?: unknown) => void;
}

export interface AutoUploadNotice {
  total: number;
  successful: number;
  skipped: number;
  failed: number;
  unknown?: number;
  singleReason?: "success" | "failed" | "unknown";
  originalBytes?: number;
  compressedBytes?: number;
}

interface UploadSuccess {
  requestId: string;
  status: string;
  succFiles?: Array<{ index: number; name?: string; path?: string }>;
  succMap?: Record<string, string>;
}

export interface InsertedImage extends ImageOccurrenceEvidence {
  key: string;
  element?: Element;
}

export type UploadInput =
  | { kind: "files"; files: File[] }
  | { kind: "local-files"; files: Array<{ path: string; size: number | null; isDir?: boolean }> };

export interface UploadDetail {
  requestId?: string;
  target?: string;
  input?: UploadInput;
  protyle?: { element?: HTMLElement; block?: { rootID?: string; box?: string }; notebookId?: string };
  onComplete?: (callback: (result: UploadSuccess) => void) => void;
}

const DEFAULT_OBSERVED_IMAGE_DELAYS_MS: readonly number[] = [20, 40, 80, 140, 220];

function waitWithAbort(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted || ms <= 0) return Promise.resolve();
  return new Promise(resolve => {
    const onAbort = () => {
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

export function buildAutoUploadNotice(counts: {
  successful: number;
  skipped: number;
  failed: number;
  unknownCount: number;
  singleOriginalBytes?: number;
  singleCompressedBytes?: number;
}): AutoUploadNotice | undefined {
  const { successful, skipped, failed, unknownCount, singleOriginalBytes, singleCompressedBytes } = counts;
  const total = successful + skipped + failed + unknownCount;
  if (total <= 0 || (successful === 0 && failed === 0 && unknownCount === 0)) {
    return undefined;
  }
  return {
    total,
    successful,
    skipped,
    failed,
    ...(unknownCount > 0 ? { unknown: unknownCount } : {}),
    singleReason: total === 1
      ? (successful === 1 ? "success" : failed === 1 ? "failed" : "unknown")
      : undefined,
    ...(total === 1 && successful === 1 && singleOriginalBytes !== undefined && singleCompressedBytes !== undefined
      ? { originalBytes: singleOriginalBytes, compressedBytes: singleCompressedBytes }
      : {}),
  };
}

export function hasCompressibleInput(input: UploadInput | undefined, config: ImageConfig): boolean {
  if (!input) return true;
  const paths = input.kind === "files"
    ? (Array.isArray(input.files) ? input.files.map(file => file.name) : [])
    : (Array.isArray(input.files) ? input.files.filter(f => !f.isDir).map(f => f.path) : []);
  if (paths.length === 0) return false;
  return paths.some(path => classifyImageCandidate({
    path,
    mode: "auto",
    excludedExtensions: config.compression.excludedExtensions,
    smartEnabled: isSmartCompressionEffective(config.compression.smartEnabled),
  }).eligible);
}

/** Successful entries from partial native batches remain independently processable. */
export function completedUploadPaths(result: UploadSuccess): string[] {
  if (!["success", "partial"].includes(result.status)) return [];
  if (Array.isArray(result.succFiles)) {
    return [...new Set(result.succFiles
      .filter(row => Number.isSafeInteger(row.index) && row.index >= 0)
      .map(row => row.path)
      .filter((path): path is string => typeof path === "string" && path.length > 0)
      .map(path => path.replaceAll("\\", "/")))];
  }
  if (result.succMap && typeof result.succMap === "object") {
    return [...new Set(Object.values(result.succMap)
      .filter((path): path is string => typeof path === "string" && path.length > 0)
      .map(path => path.replaceAll("\\", "/")))];
  }
  return [];
}

function capturePreExistingAssets(editor: HTMLElement | undefined, origin: string): WeakSet<Element> {
  const existing = new WeakSet<Element>();
  if (!editor || typeof editor.querySelectorAll !== "function") return existing;
  for (const image of editor.querySelectorAll("img")) {
    const raw = image.hasAttribute("data-src") ? image.getAttribute("data-src") : image.getAttribute("src");
    if (!raw) continue;
    const source = trySource(raw.replaceAll("\\", "/"), origin);
    if (source?.kind === "asset") existing.add(image);
  }
  return existing;
}

/**
 * Observe native upload completion without taking ownership of the upload request.
 * The host callback is registered synchronously, while all resolution and compression
 * work runs after SiYuan has accepted the original upload.
 */
export function registerAutoUpload(
  plugin: Plugin,
  scope: FeatureScope,
  shouldCompress: (rootID: string) => boolean,
  services: ImageProcessingServices,
  logger: DebugLogger,
  onNotice?: (notice: AutoUploadNotice) => void,
): void {
  const listener = (event: CustomEvent<UploadDetail>) => {
    let observer: MutationObserver | undefined;
    let releaseObserver: (() => void) | undefined;
    try {
      const detail = event?.detail;
      const rootID = resolveEditorRootID(detail?.protyle);
      const notebook = resolveNotebookID(detail?.protyle);
      if (!scope.active || detail?.target !== "editor" || !rootID || !notebook ||
          !detail.requestId || typeof detail.onComplete !== "function") return;

      // Synchronous authorization pre-check
      if (!shouldCompress(rootID)) {
        logger.debug?.("自动上传压缩跳过：当前文档未授权", { requestId: detail.requestId, rootID });
        return;
      }

      // Candidate image pre-screening
      const config = services.config();
      if (!hasCompressibleInput(detail.input, config)) {
        logger.debug?.("上传输入预筛无可压缩图片，跳过监听", { requestId: detail.requestId, rootID });
        return;
      }

      logger.debug?.("收到 before-upload-assets 事件", {
        requestId: detail.requestId, target: detail.target, rootID, notebook,
      });

      const editor = detail.protyle?.element;
      const preExistingAssets = capturePreExistingAssets(editor, services.origin);
      const observed: InsertedImage[] = [];
      observer = editor && typeof MutationObserver !== "undefined"
        ? new MutationObserver(records => collectNewImages(records, rootID, notebook, services.origin, observed, preExistingAssets))
        : undefined;
      observer?.observe(editor!, {
        subtree: true,
        childList: true,
        attributes: true,
        attributeOldValue: true,
        attributeFilter: ["src", "data-src"],
      });
      releaseObserver = scope.own(() => observer?.disconnect());

      let completed = false;
      detail.onComplete(result => {
        if (completed || result?.requestId !== detail.requestId) return;
        completed = true;
        logger.debug?.("原生上传完成回调触发", {
          requestId: result?.requestId, status: result?.status,
        });
        if (!scope.active || !["success", "partial"].includes(result.status)) {
          releaseObserver?.();
          return;
        }
        // onComplete may run before editor DOM mutation and kernel persistence. Keep the
        // observer briefly and retry only the exact successful paths from this request.
        queueMicrotask(() => {
          void processCompletedUpload(result, rootID, observed, editor, scope, shouldCompress,
            services, logger, onNotice).finally(() => releaseObserver?.());
        });
      });
    } catch (error) {
      try {
        if (releaseObserver) releaseObserver();
        else observer?.disconnect();
      } catch {
        // Ignore cleanup failure so native upload is never interrupted
      }
      logger.warn("处理原生图片上传前置监听失败", { error });
      return;
    }
  };

  plugin.eventBus.on("before-upload-assets", listener);
  scope.own(() => plugin.eventBus.off("before-upload-assets", listener));
}

function collectNewImages(
  records: MutationRecord[],
  rootID: string,
  notebook: string,
  origin: string,
  observed: InsertedImage[],
  preExistingAssets: WeakSet<Element>,
): void {
  const images = new Set<HTMLImageElement>();
  const inspectAddedNode = (node: Node) => {
    if (!(node instanceof Element)) return;
    if (isInsideProtectedContainer(node)) return;
    if (node instanceof HTMLImageElement) images.add(node);
    if (typeof node.querySelectorAll === "function") {
      node.querySelectorAll("img").forEach(image => {
        if (!isInsideProtectedContainer(image)) images.add(image as HTMLImageElement);
      });
    }
  };

  for (const record of records) {
    if (record.type === "attributes") {
      const target = record.target;
      if (!(target instanceof HTMLImageElement) || isInsideProtectedContainer(target)) continue;
      // Ignore attribute edits on pre-existing asset images or transitions from an existing asset path.
      if (preExistingAssets.has(target)) continue;
      if (typeof record.oldValue === "string" && trySource(record.oldValue.replaceAll("\\", "/"), origin)?.kind === "asset") {
        continue;
      }
      images.add(target);
      continue;
    }
    for (const node of record.addedNodes) inspectAddedNode(node);
  }

  for (const image of images) {
    if (isInsideProtectedContainer(image)) continue;
    const raw = image.hasAttribute("data-src") ? image.getAttribute("data-src") : image.getAttribute("src");
    const owner = image.closest<HTMLElement>("[data-node-id]");
    if (!raw || !owner || isInsideProtectedContainer(owner)) continue;
    const blockID = owner.dataset?.nodeId ?? owner.getAttribute?.("data-node-id") ?? undefined;
    if (!blockID) continue;
    let key: string;
    try { key = resolveSource(raw.replaceAll("\\", "/"), origin).key; } catch { continue; }
    if (!key.startsWith("asset:")) continue;
    const ordinal = [...owner.querySelectorAll("img")].indexOf(image);
    if (ordinal < 0 || observed.some(item => item.element === image && item.key === key)) continue;
    observed.push({
      rootID,
      notebook,
      blockID,
      imageOrdinal: ordinal,
      oldPath: raw.replaceAll("\\", "/"),
      key,
      element: image,
    });
  }
}

async function processCompletedUpload(
  result: UploadSuccess,
  rootID: string,
  observed: InsertedImage[],
  editor: HTMLElement | undefined,
  scope: FeatureScope,
  shouldCompress: (rootID: string) => boolean,
  services: ImageProcessingServices,
  logger: DebugLogger,
  onNotice?: (notice: AutoUploadNotice) => void,
): Promise<void> {
  const paths = completedUploadPaths(result);
  logger.debug?.("开始处理已上传的图片", { requestId: result.requestId, count: paths.length, paths });

  if (paths.length === 0) {
    logger.debug?.("无成功上传的资源路径，结束自动处理", { requestId: result.requestId });
    return;
  }

  let successful = 0, skipped = 0, failed = 0, unknownCount = 0;
  let singleOriginalBytes: number | undefined;
  let singleCompressedBytes: number | undefined;

  const authorized = shouldCompress(rootID);
  logger.debug?.("检查自动压缩授权", { rootID, authorized });
  if (!authorized) {
    logger.debug?.("当前文档未在自动压缩授权列表中，跳过处理", { rootID, paths });
    return;
  }

  for (const rawPath of paths) {
    if (!scope.active || scope.signal.aborted) break;
    const path = rawPath.replaceAll("\\", "/");
    const currentConfig = services.config();
    const decision = classifyImageCandidate({
      path,
      mode: "auto",
      excludedExtensions: currentConfig.compression.excludedExtensions,
      smartEnabled: isSmartCompressionEffective(currentConfig.compression.smartEnabled),
    });
    if (!decision.eligible) {
      if (decision.reason === "animated-format" || decision.reason === "vector-format" || decision.reason === "excluded-extension") {
        logSkippedImage(services, path, "auto", decision.reason);
      } else {
        logger.debug?.("分类器跳过不合格文件", { path, reason: decision.reason });
      }
      skipped++;
      continue;
    }
    try {
      const source = resolveSource(path, services.origin);
      if (source.kind !== "asset") {
        logger.debug?.("跳过非 asset 类型的上传文件", { path, kind: source.kind });
        skipped++;
        continue;
      }
      const candidates = await waitForObservedImages(observed, source.key, scope.signal, editor);
      if (!scope.active || scope.signal.aborted) break;
      logger.debug?.("检索图片插入位置候选", { path, key: source.key, candidateCount: candidates.length });

      if (candidates.length !== 1) {
        logger.debug?.("未找到唯一的图片插入位置，跳过", { path, count: candidates.length });
        skipped++;
        continue;
      }
      const evidence = candidates[0];
      const target = await waitForPersistedImageOccurrence(services.kernel, evidence, undefined, scope.signal);
      if (!scope.active || scope.signal.aborted) break;
      if (!target) {
        logger.debug?.("未能在思源内核中核验到块持久化位置，跳过", { path });
        skipped++;
        continue;
      }

      const outcome = await services.compressOccurrence(target, services.config(), scope.signal,
        { mode: "auto", replace: true });
      logger.debug?.("图片自动压缩执行完成", { path, outcome });

      if (outcome.status === "skipped") {
        skipped++;
      } else if (outcome.reference === "replaced") {
        successful++;
        singleOriginalBytes = outcome.originalBytes;
        singleCompressedBytes = outcome.compressedBytes;
      } else if (outcome.reference === "unknown") {
        unknownCount++;
      } else if (outcome.reference === "aborted") {
        logger.debug?.("自动上传压缩写回已中止，停止后续处理", { path });
        break;
      } else if (outcome.reference === "failed") {
        failed++;
      } else {
        logger.debug?.("自动压缩引用更新冲突或未请求写回", { path, reference: outcome.reference });
        skipped++;
      }
    } catch (error) {
      if (scope.signal.aborted) break;
      failed++;
      logger.warn("原生上传后的图片自动压缩失败，已保留原图", { path, error });
    }
  }

  const total = successful + skipped + failed + unknownCount;
  if (total > 0 && scope.active) {
    const notice = buildAutoUploadNotice({
      successful,
      skipped,
      failed,
      unknownCount,
      singleOriginalBytes,
      singleCompressedBytes,
    });
    if (!notice) {
      logger.debug?.("所有图片均已跳过，静默结束", { total, skipped });
      return;
    }
    try {
      onNotice?.(notice);
    } catch (error) {
      logger.warn("无法显示自动压缩提示", error);
    }
  }
}

function resolveConnectedItem(item: InsertedImage, editor?: HTMLElement): InsertedImage | undefined {
  const connected = !item.element || typeof editor?.contains !== "function" || editor.contains(item.element);
  if (!connected) return undefined;
  if (!item.element || typeof item.element.closest !== "function") return item;
  const owner = item.element.closest<HTMLElement>("[data-node-id]");
  const blockID = owner?.dataset?.nodeId ?? owner?.getAttribute?.("data-node-id") ?? undefined;
  if (!owner || !blockID || isInsideProtectedContainer(owner)) return undefined;
  if (typeof owner.querySelectorAll === "function") {
    const ordinal = [...owner.querySelectorAll("img")].indexOf(item.element as HTMLImageElement);
    if (ordinal < 0) return undefined;
    return { ...item, blockID, imageOrdinal: ordinal };
  }
  return { ...item, blockID };
}

export async function waitForObservedImages(
  observed: InsertedImage[],
  key: string,
  signal: AbortSignal,
  editor?: HTMLElement,
  delays: readonly number[] = DEFAULT_OBSERVED_IMAGE_DELAYS_MS,
): Promise<InsertedImage[]> {
  for (let attempt = 0; attempt <= delays.length; attempt++) {
    if (signal.aborted) return [];
    const seen = new Set<string>();
    const matches: InsertedImage[] = [];
    for (const item of observed) {
      if (item.key !== key) continue;
      const live = resolveConnectedItem(item, editor);
      if (!live) continue;
      const dedupKey = `${live.blockID}\n${live.imageOrdinal}\n${live.key}`;
      if (seen.has(dedupKey)) continue;
      seen.add(dedupKey);
      matches.push(live);
    }
    if (matches.length > 0) return matches;
    if (attempt < delays.length) {
      await waitWithAbort(delays[attempt], signal);
    }
  }
  return [];
}
