import type { Plugin } from "siyuan";
import type { FeatureScope } from "../../../core/framework/FeatureScope.ts";
import type { ImageProcessingServices } from "../services/ImageProcessingServices.ts";
import { waitForPersistedImageOccurrence, type ImageOccurrenceEvidence } from "../services/ImageOccurrenceResolver.ts";
import { resolveSource } from "../policy/source.ts";
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
  singleReason?: "success" | "noBenefit" | "notAuthorized" | "conflict" | "notMatched" | "failed" | "other";
}

interface UploadSuccess {
  requestId: string;
  status: string;
  succFiles?: Array<{ index: number; name?: string; path?: string }>;
  succMap?: Record<string, string>;
}
interface InsertedImage extends ImageOccurrenceEvidence { key: string }

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

export function hasCompressibleInput(input: UploadInput | undefined, config: ImageConfig): boolean {
  if (!input) return true;
  const paths = input.kind === "files"
    ? (Array.isArray(input.files) ? input.files.map(file => file.name) : [])
    : (Array.isArray(input.files) ? input.files.filter(f => !f.isDir).map(f => f.path) : []);
  if (paths.length === 0) return true;
  const excluded = config?.compression?.excludedExtensions ?? ["gif", "svg", "webp"];
  return paths.some(path => classifyImageCandidate({
    path,
    mode: "auto",
    excludedExtensions: excluded,
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

/**
 * Observe native upload completion without taking ownership of the upload request.
 * The host callback is registered synchronously, while all resolution and compression
 * work runs after SiYuan has accepted the original upload.
 */
export function registerAutoUpload(
  plugin: Plugin,
  scope: FeatureScope,
  shouldCompress: (rootID: string) => boolean | Promise<boolean>,
  services: ImageProcessingServices,
  logger: DebugLogger,
  onNotice?: (notice: AutoUploadNotice) => void,
): void {
  const listener = (event: CustomEvent<UploadDetail>) => {
    const detail = event.detail;
    const rootID = detail?.protyle?.block?.rootID;
    const notebook = detail?.protyle?.notebookId ?? detail?.protyle?.block?.box;
    if (!scope.active || detail?.target !== "editor" || !rootID || !notebook ||
        !detail.requestId || typeof detail.onComplete !== "function") return;

    // Synchronous authorization pre-check
    const auth = shouldCompress(rootID);
    if (auth === false) return;

    // Candidate image pre-screening
    const config = services.config();
    if (!hasCompressibleInput(detail.input, config)) return;

    logger.debug?.("收到 before-upload-assets 事件", {
      requestId: detail.requestId, target: detail.target, rootID, notebook,
    });

    const editor = detail.protyle?.element;
    const observed: InsertedImage[] = [];
    const observer = editor && typeof MutationObserver !== "undefined"
      ? new MutationObserver(records => collectNewImages(records, rootID, notebook, services.origin, observed))
      : undefined;
    observer?.observe(editor!, {
      subtree: true, childList: true, attributes: true, attributeFilter: ["src", "data-src"],
    });
    const releaseObserver = scope.own(() => observer?.disconnect());

    let completed = false;
    try {
      detail.onComplete(result => {
        if (completed || result?.requestId !== detail.requestId) return;
        completed = true;
        logger.debug?.("原生上传完成回调触发", {
          requestId: result?.requestId, status: result?.status,
        });
        if (!scope.active || !["success", "partial"].includes(result.status)) {
          releaseObserver();
          return;
        }
        // onComplete may run before editor DOM mutation and kernel persistence. Keep the
        // observer briefly and retry only the exact successful paths from this request.
        queueMicrotask(() => {
          void processCompletedUpload(result, rootID, notebook, observed, scope, shouldCompress,
            services, logger, editor, onNotice).finally(releaseObserver);
        });
      });
    } catch (error) {
      releaseObserver();
      logger.warn("无法注册原生图片上传完成回调", { requestId: detail.requestId, error });
    }
  };

  plugin.eventBus.on("before-upload-assets", listener);
  scope.own(() => plugin.eventBus.off("before-upload-assets", listener));
}

function collectNewImages(
  records: MutationRecord[], rootID: string, notebook: string, origin: string, observed: InsertedImage[],
): void {
  const images = new Set<HTMLImageElement>();
  const inspectNode = (node: Node) => {
    if (!(node instanceof Element)) return;
    if (node instanceof HTMLImageElement) images.add(node);
    node.querySelectorAll("img").forEach(image => images.add(image as HTMLImageElement));
  };
  for (const record of records) {
    if (record.type === "attributes") inspectNode(record.target);
    for (const node of record.addedNodes) inspectNode(node);
  }
  for (const image of images) {
    const raw = image.hasAttribute("data-src") ? image.getAttribute("data-src") : image.getAttribute("src");
    const owner = image.closest<HTMLElement>("[data-node-id]");
    const blockID = owner?.dataset.nodeId;
    if (!raw || !blockID) continue;
    let key: string;
    try { key = resolveSource(raw.replaceAll("\\", "/"), origin).key; } catch { continue; }
    if (!key.startsWith("asset:")) continue;
    const ordinal = [...owner.querySelectorAll("img")].indexOf(image);
    if (ordinal < 0 || observed.some(item => item.blockID === blockID && item.imageOrdinal === ordinal && item.key === key)) continue;
    observed.push({ rootID, notebook, blockID, imageOrdinal: ordinal, oldPath: raw.replaceAll("\\", "/"), key });
  }
}

function scanEditorForImage(
  editor: HTMLElement, rootID: string, notebook: string, origin: string, key: string,
): InsertedImage[] {
  const found: InsertedImage[] = [];
  const images = [...editor.querySelectorAll("img")];
  for (const image of images) {
    const raw = image.hasAttribute("data-src") ? image.getAttribute("data-src") : image.getAttribute("src");
    const owner = image.closest<HTMLElement>("[data-node-id]");
    const blockID = owner?.dataset.nodeId;
    if (!raw || !blockID) continue;
    let imgKey: string;
    try { imgKey = resolveSource(raw.replaceAll("\\", "/"), origin).key; } catch { continue; }
    if (imgKey !== key) continue;
    const ordinal = [...owner.querySelectorAll("img")].indexOf(image);
    if (ordinal < 0) continue;
    found.push({ rootID, notebook, blockID, imageOrdinal: ordinal, oldPath: raw.replaceAll("\\", "/"), key: imgKey });
  }
  return found;
}

async function processCompletedUpload(
  result: UploadSuccess,
  rootID: string,
  notebook: string,
  observed: InsertedImage[],
  scope: FeatureScope,
  shouldCompress: (rootID: string) => boolean | Promise<boolean>,
  services: ImageProcessingServices,
  logger: DebugLogger,
  editor?: HTMLElement,
  onNotice?: (notice: AutoUploadNotice) => void,
): Promise<void> {
  const paths = completedUploadPaths(result);
  logger.debug?.("开始处理已上传的图片", { requestId: result.requestId, count: paths.length, paths });

  if (paths.length === 0) {
    logger.debug?.("无成功上传的资源路径，结束自动处理", { requestId: result.requestId });
    return;
  }

  let successful = 0, skipped = 0, failed = 0;
  let lastSkipReason: "noBenefit" | "notAuthorized" | "conflict" | "notMatched" | "other" = "other";

  const postAuth = shouldCompress(rootID);
  const authorized = typeof postAuth === "boolean" ? postAuth : await postAuth;
  logger.debug?.("检查自动压缩授权", { rootID, authorized });
  if (!authorized) {
    logger.debug?.("当前文档未在自动压缩授权列表中，跳过处理", { rootID, paths });
    return;
  }

  for (const rawPath of paths) {
    if (!scope.active || scope.signal.aborted) break;
    const path = rawPath.replaceAll("\\", "/");
    const excluded = services.config()?.compression?.excludedExtensions ?? ["gif", "svg", "webp"];
    const decision = classifyImageCandidate({
      path,
      mode: "auto",
      excludedExtensions: excluded,
    });
    if (!decision.eligible) {
      logger.debug?.("分类器跳过不合格文件", { path, reason: decision.reason });
      skipped++;
      lastSkipReason = "noBenefit";
      continue;
    }
    try {
      const source = resolveSource(path, services.origin);
      if (source.kind !== "asset") {
        logger.debug?.("跳过非 asset 类型的上传文件", { path, kind: source.kind });
        skipped++;
        lastSkipReason = "other";
        continue;
      }
      let candidates = await waitForObservedImages(observed, source.key, scope.signal);
      if (candidates.length === 0 && editor) {
        candidates = scanEditorForImage(editor, rootID, notebook, services.origin, source.key);
      }
      logger.debug?.("检索图片插入位置候选", { path, key: source.key, candidateCount: candidates.length });

      if (candidates.length !== 1) {
        logger.debug?.("未找到唯一的图片插入位置，跳过", { path, count: candidates.length });
        skipped++;
        lastSkipReason = "notMatched";
        continue;
      }
      const evidence = candidates[0];
      const target = await waitForPersistedImageOccurrence(services.kernel, evidence, 2, scope.signal);
      if (!target || !scope.active || scope.signal.aborted) {
        logger.debug?.("未能在思源内核中核验到块持久化位置，跳过", { path });
        skipped++;
        lastSkipReason = "notMatched";
        continue;
      }

      const outcome = await services.compressOccurrence(target, services.config(), scope.signal,
        { mode: "auto", replace: true });
      logger.debug?.("图片自动压缩执行完成", { path, outcome });

      if (outcome.status === "skipped") {
        skipped++;
        lastSkipReason = "noBenefit";
      } else if (outcome.reference === "replaced") {
        successful++;
      } else {
        skipped++;
        lastSkipReason = "conflict";
      }
    } catch (error) {
      if (scope.signal.aborted) break;
      failed++;
      logger.warn("原生上传后的图片自动压缩失败，已保留原图", { path, error });
    }
  }

  const total = successful + skipped + failed;
  if (total > 0 && scope.active) {
    if (successful === 0 && failed === 0) {
      logger.debug?.("所有图片均已跳过，静默结束", { total, skipped });
      return;
    }
    try {
      const notice: AutoUploadNotice = {
        total,
        successful,
        skipped,
        failed,
        singleReason: total === 1 ? (successful === 1 ? "success" : failed === 1 ? "failed" : lastSkipReason) : undefined,
      };
      onNotice?.(notice);
    } catch (error) {
      logger.warn("无法显示自动压缩提示", error);
    }
  }
}

export async function waitForObservedImages(
  observed: InsertedImage[], key: string, signal: AbortSignal,
): Promise<InsertedImage[]> {
  for (let attempt = 0; attempt < 3; attempt++) {
    if (signal.aborted) return [];
    const matches = observed.filter(item => item.key === key);
    if (matches.length) return matches;
    if (attempt < 2) await new Promise(resolve => setTimeout(resolve, 30));
  }
  return [];
}
