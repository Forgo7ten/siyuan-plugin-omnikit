import type { ILocalFiles, Plugin } from "siyuan";
import type { FeatureScope } from "../../core/FeatureScope.ts";
import type { CompressionDiagnostic, ImageCompressorService } from "./ImageCompressorService.ts";
import type { ImageSettings } from "./settings.ts";
import { isMobileFrontend } from "../../core/Platform.ts";

/** Minimal logging surface: debug decisions plus warnings that must always surface. */
export interface DebugLogger {
  /** Optional so a partial logger can never break the upload path. */
  debug?: (message: string, data?: unknown) => void;
  warn: (message: string, data?: unknown) => void;
}

/**
 * @compat before-upload-assets is available from SiYuan 3.8.4. Supports its file-array
 * response and the decision protocol without changing file ordering.
 * @invariant respondWith is invoked synchronously and exactly once per accepted event.
 * @safety Compression errors, cancellation, and Feature shutdown all return original files.
 */
export function registerAutoUpload(
  plugin: Plugin,
  scope: FeatureScope,
  isSupported: () => boolean,
  shouldCompress: (rootId: string) => Promise<boolean>,
  compress: ImageCompressorService,
  settings: () => ImageSettings,
  logger: DebugLogger,
  onCompressed?: (count: number) => void,
): void {
  if (!isSupported()) {
    logger.debug?.("思源版本不支持上传前事件，自动压缩未启用");
    return;
  }
  const listener = (event: CustomEvent<any>) => {
    const detail = event.detail;
    const input = detail?.input;
    const source = detail?.source;
    const target = detail?.target;
    logger.debug?.("收到上传事件", {
      功能启用: scope.active,
      requestId: detail?.requestId,
      source,
      target,
      inputKind: input?.kind ?? (Array.isArray(detail?.files) ? "legacy-files" : undefined),
      fileCount: Array.isArray(input?.files) ? input.files.length :
        Array.isArray(detail?.files) ? detail.files.length : undefined,
      hasRespondWith: typeof detail?.respondWith === "function",
      rootID: detail?.protyle?.block?.rootID,
    });
    if (!scope.active) {
      logger.debug?.("忽略上传事件", { 原因: "功能已停用", requestId: detail?.requestId });
      return;
    }
    if (!detail || typeof detail.respondWith !== "function") {
      logger.debug?.("忽略上传事件", { 原因: "缺少上传决策接口" });
      return;
    }
    // @compat Strictly follow the 3.8.4+ contract: only editor uploads carrying the
    // file-decision envelope are compressed. A missing target never authorizes work.
    if (detail.target !== "editor") {
      logger.debug?.("忽略上传事件", { 原因: "上传目标不是编辑器", target: detail.target });
      return;
    }
    let files: File[];
    if (input) {
      if (input.kind === "local-files") {
        logger.debug?.("忽略本地路径上传", {
          原因: "思源只提供本地路径，没有图片字节数据，插件无法在上传前压缩",
          requestId: detail.requestId,
          fileCount: Array.isArray(input.files) ? input.files.length : undefined,
          files: Array.isArray(input.files) ? (input.files as ILocalFiles[]).map(file => ({
            extension: getExtension(file.path), size: file.size, isDir: file.isDir === true,
          })) : undefined,
        });
        return;
      }
      if (input.kind !== "files" || !Array.isArray(input.files)) {
        logger.debug?.("忽略上传事件", {
          原因: "不支持的输入类型",
          inputKind: String(input.kind),
          requestId: detail.requestId,
          hasFilesArray: Array.isArray(input.files),
        });
        return;
      }
      files = input.files;
    } else {
      // @compat Early 3.8.4 builds exposed `files` without the decision envelope.
      if (!Array.isArray(detail.files)) {
        logger.debug?.("忽略上传事件", { 原因: "旧版事件缺少文件列表" });
        return;
      }
      files = detail.files;
    }
    const decisionProtocol = Boolean(input);
    if (files.length === 0) {
      logger.debug?.("忽略上传事件", { 原因: "文件列表为空", requestId: detail.requestId });
      return;
    }
    const rootId = detail.protyle?.block?.rootID;
    if (!rootId) {
      logger.debug?.("忽略上传事件", { 原因: "缺少文档根ID", requestId: detail.requestId });
      return;
    }
    logger.debug?.("开始处理上传文件", {
      rootID: rootId,
      requestId: detail.requestId,
      source,
      files: files.map(file => describeFile(file)),
      usesDecisionProtocol: decisionProtocol,
    });

    // @invariant Promise passed to respondWith is constructed and registered before returning.
    const response = compressFiles(files, rootId, detail.signal, scope, shouldCompress, compress, settings, logger)
      .then(output => {
        const replaced = output.filter((file, index) => file !== files[index]).length;
        if (replaced > 0) {
          logger.debug?.("压缩完成，上传时将使用 WebP 文件替换原文件", { rootID: rootId, requestId: detail.requestId, replacedCount: replaced });
          try {
            onCompressed?.(replaced);
          } catch (error) {
            logger.warn("无法显示自动压缩提示", error);
          }
        }
        return decisionProtocol ? { action: "replace" as const, input: { kind: "files" as const, files: output } } : output;
      });
    try {
      detail.respondWith(response);
    } catch (error) {
      logger.warn("无法注册自动压缩处理，将上传原文件", {
        requestId: detail.requestId,
        rootID: rootId,
        error,
      });
    }
  };
  plugin.eventBus.on("before-upload-assets", listener);
  scope.own(() => plugin.eventBus.off("before-upload-assets", listener));
}

async function compressFiles(
  files: File[],
  rootId: string,
  hostSignal: AbortSignal | undefined,
  scope: FeatureScope,
  shouldCompress: (rootId: string) => Promise<boolean>,
  compressor: ImageCompressorService,
  getSettings: () => ImageSettings,
  logger: DebugLogger,
): Promise<File[]> {
  const originals = [...files];
  try {
    if (!scope.active || hostSignal?.aborted) {
      logger.debug?.("跳过自动压缩", {
        文档根ID: rootId,
        原因: !scope.active ? "功能已停用" : "上传已取消",
      });
      return originals;
    }
    const allowed = await shouldCompress(rootId);
    if (!allowed || !scope.active || hostSignal?.aborted) {
      logger.debug?.("跳过自动压缩", {
        文档根ID: rootId,
        原因: !allowed ? "全局开关和文档白名单均未授权" : !scope.active ? "功能已停用" : "上传已取消",
      });
      return originals;
    }
  } catch (error) {
    logger.warn("自动压缩策略检查失败，将上传原文件", error);
    return originals;
  }

  const config = getSettings();
  const concurrency = getConcurrency(config);
  const output = [...files];
  let nextIndex = 0;
  const worker = async () => {
    while (nextIndex < files.length) {
      if (!scope.active || hostSignal?.aborted) return;
      const index = nextIndex++;
      const file = files[index];
      const controller = new AbortController();
      const abortFromScope = () => controller.abort(scope.signal.reason ?? "Feature disabled");
      const abortFromHost = () => controller.abort(hostSignal?.reason ?? "Upload cancelled");
      if (scope.signal.aborted) abortFromScope();
      else scope.signal.addEventListener("abort", abortFromScope, { once: true });
      if (hostSignal?.aborted) abortFromHost();
      else hostSignal?.addEventListener("abort", abortFromHost, { once: true });
      try {
        const compressed = await compressor.compress(file, file.name, config, controller.signal, diagnostic => {
          logger.debug?.("图片压缩检查", {
            index: index + 1,
            extension: getExtension(file.name),
            size: file.size,
            type: file.type,
            ...describeCompressionDiagnostic(diagnostic),
          });
        });
        if (!scope.active || hostSignal?.aborted || controller.signal.aborted) continue;
        if (!compressed) {
          logger.debug?.("图片保持原样上传", {
            index: index + 1,
            extension: getExtension(file.name),
            size: file.size,
            type: file.type,
            原因: "格式或大小不符合条件，或压缩收益不足",
          });
          continue;
        }
        output[index] = new File([compressed.blob], replaceExtension(file.name, ".webp"), {
          type: "image/webp",
          lastModified: file.lastModified,
        });
        logger.debug?.("图片已压缩，将替换上传文件", {
          index: index + 1,
          originalExtension: getExtension(file.name),
          originalBytes: compressed.originalBytes,
          compressedBytes: compressed.compressedBytes,
          savingRatio: Number((1 - compressed.compressedBytes / compressed.originalBytes).toFixed(4)),
        });
      } catch (error) {
        if (!controller.signal.aborted) logger.warn("图片自动压缩失败，将上传原文件", {
          index: index + 1,
          extension: getExtension(file.name),
          size: file.size,
          type: file.type,
          error,
        });
      } finally {
        scope.signal.removeEventListener("abort", abortFromScope);
        hostSignal?.removeEventListener("abort", abortFromHost);
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, files.length) }, () => worker()));
  const replaced = output.filter((file, index) => file !== files[index]).length;
  logger.debug?.("自动压缩处理完成", { 文档根ID: rootId, 文件数: files.length, 替换数: replaced, 并发数: concurrency });
  return !scope.active || hostSignal?.aborted ? originals : output;
}

/** Avoid logging file names or paths while retaining enough metadata to diagnose routing. */
function describeFile(file: File): Record<string, unknown> {
  return { extension: getExtension(file.name), size: file.size, type: file.type };
}

function describeCompressionDiagnostic(diagnostic: CompressionDiagnostic): Record<string, unknown> {
  if (diagnostic.stage === "eligibility") {
    return {
      stage: diagnostic.stage,
      accepted: diagnostic.accepted,
      reason: translateCompressionReason(diagnostic.reason),
      format: diagnostic.format,
    };
  }
  return {
    stage: diagnostic.stage,
    replaced: diagnostic.replaced,
    reason: translateCompressionReason(diagnostic.reason),
    originalBytes: diagnostic.originalBytes,
    outputBytes: diagnostic.outputBytes,
    minSavingRatio: diagnostic.minSavingRatio,
  };
}

function translateCompressionReason(reason?: string): string | undefined {
  switch (reason) {
    case "Unsupported or protected image": return "不支持或受保护的图片格式";
    case "Too small": return "文件小于最小压缩大小";
    case "MIME and PNG signature disagree": return "MIME 类型与 PNG 文件签名不一致";
    case "Extension and PNG signature disagree": return "文件扩展名与 PNG 文件签名不一致";
    case "MIME and JPEG signature disagree": return "MIME 类型与 JPEG 文件签名不一致";
    case "Extension and JPEG signature disagree": return "文件扩展名与 JPEG 文件签名不一致";
    case "MIME and WebP signature disagree": return "MIME 类型与 WebP 文件签名不一致";
    case "Extension and WebP signature disagree": return "文件扩展名与 WebP 文件签名不一致";
    case "Unrecognized image signature": return "无法识别图片文件签名";
    case "output-not-webp": return "压缩结果不是 WebP 格式";
    case "below-minimum-savings": return "压缩收益低于设置阈值";
    default: return reason;
  }
}

function getExtension(name: string): string {
  const match = /\.([^.\\/]+)$/.exec(name);
  return match ? `.${match[1].toLowerCase()}` : "(none)";
}


function getConcurrency(settings: ImageSettings): number {
  const mobile = isMobileFrontend();
  const requested = mobile ? settings.concurrencyMobile : settings.concurrencyDesktop;
  const maximum = mobile ? 3 : 8;
  return Math.max(1, Math.min(maximum, Math.floor(requested || 1)));
}

function replaceExtension(name: string, extension: string): string {
  return /\.[^./\\]+$/.test(name) ? name.replace(/\.[^./\\]+$/, extension) : `${name}${extension}`;
}
