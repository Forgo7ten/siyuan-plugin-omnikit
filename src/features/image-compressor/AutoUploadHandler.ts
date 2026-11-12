import type { ILocalFiles, Plugin } from "siyuan";
import type { FeatureScope } from "../../core/FeatureScope.ts";
import type { ImageProcessingServices } from "./ImageProcessingServices.ts";
import { retainOriginal, type ImageConfig } from "./parseImageConfig.ts";
import { resolveSource } from "./source.ts";

/** Minimal logging surface: debug decisions plus warnings that must always surface. */
export interface DebugLogger {
  debug?: (message: string, data?: unknown) => void;
  warn: (message: string, data?: unknown) => void;
}

export type AutoUploadNotice = {
  status: "prepared" | "success" | "partial" | "failed" | "canceled";
  count: number;
};

type UploadInput =
  | { kind: "files"; files: File[] }
  | { kind: "local-files"; files: ILocalFiles[] };
type UploadResult = {
  requestId: unknown;
  status: "success" | "partial" | "failed" | "canceled";
  input?: UploadInput;
  acceptedInput?: UploadInput;
  succFiles?: Array<{ index: number; name?: string; path?: string }>;
};

/**
 * @invariant respondWith and onComplete registration happen in the event dispatch stack.
 * @safety Conversion of local-files is all-or-nothing; failures and cancellation preserve input.
 */
export function registerAutoUpload(
  plugin: Plugin,
  scope: FeatureScope,
  isSupported: () => boolean,
  shouldCompress: (rootId: string) => Promise<boolean>,
  services: ImageProcessingServices,
  logger: DebugLogger,
  onNotice?: (notice: AutoUploadNotice) => void,
): void {
  if (!isSupported()) {
    logger.debug?.("思源版本不支持上传前事件，自动压缩未启用");
    return;
  }

  const listener = (event: CustomEvent<any>) => {
    const detail = event.detail;
    const input = detail?.input as UploadInput | undefined;
    const requestId = detail?.requestId;
    const rootID = detail?.protyle?.block?.rootID;
    logger.debug?.("收到上传事件", {
      requestId, target: detail?.target, inputKind: input?.kind,
      fileCount: Array.isArray(input?.files) ? input.files.length : undefined,
      rootID, hasRespondWith: typeof detail?.respondWith === "function",
    });
    if (!scope.active || detail?.target !== "editor" || typeof detail?.respondWith !== "function" ||
      !input || (input.kind !== "files" && input.kind !== "local-files") || !Array.isArray(input.files)) return;
    if (!rootID || input.files.length === 0 || input.files.length > 16 ||
      detail.requiredFileCount !== undefined && detail.requiredFileCount !== input.files.length) return;
    const config = services.config();
    if (input.kind === "local-files" && (!config.sources.desktopLocalFiles ||
      input.files.some(file => file.isDir === true) ||
      Array.isArray(detail.allowedInputKinds) && !detail.allowedInputKinds.includes("files"))) return;

    let replacements: File[] = [];
    let prepared = false;
    let registrationAccepted = false;
    let completionRegistered = false;
    let completion: UploadResult | undefined;
    let notified = false;
    const notifyWhenReady = () => {
      if (!scope.active || !prepared || notified || replacements.length === 0) return;
      if (!completionRegistered) {
        if (!registrationAccepted) return;
        notified = true;
        try { onNotice?.({ status: "prepared", count: replacements.length }); }
        catch (error) { logger.warn("无法显示自动压缩提示", error); }
        return;
      }
      if (!completion || completion.requestId !== requestId) return;
      const accepted = completion.acceptedInput ?? completion.input;
      if (accepted?.kind !== "files" || !Array.isArray(accepted.files) || !Array.isArray(completion.succFiles)) return;
      const confirmed = completion.succFiles.reduce((count, row) => {
        const replacement = replacements.find(file => accepted.files[row.index] === file);
        return count + (replacement ? 1 : 0);
      }, 0);
      notified = true;
      if (!confirmed) return;
      try { onNotice?.({ status: completion.status, count: confirmed }); }
      catch (error) { logger.warn("无法显示自动压缩提示", error); }
    };

    if (typeof detail.onComplete === "function") {
      try {
        detail.onComplete((result: UploadResult) => {
          if (typeof requestId !== "string" || !requestId || result?.requestId !== requestId ||
            !["success", "partial", "failed", "canceled"].includes(result?.status)) return;
          completion = result;
          notifyWhenReady();
        });
        completionRegistered = true;
      } catch (error) {
        logger.warn("无法注册上传完成回调", { requestId, error });
      }
    }

    const registrationAbort = new AbortController();
    const response = processUpload(input, rootID, detail.signal, registrationAbort.signal, scope,
      shouldCompress, services, config, logger)
      .then(result => {
        replacements = result.replacements;
        prepared = true;
        notifyWhenReady();
        return { action: "replace" as const, input: result.input };
      });
    try {
      // The Promise is passed during dispatch, before this listener returns.
      detail.respondWith(response);
      registrationAccepted = true;
      notifyWhenReady();
    } catch (error) {
      registrationAbort.abort("Host rejected upload decision");
      void response.catch(() => undefined);
      logger.warn("无法注册自动压缩处理，将上传原文件", { requestId, rootID, error });
    }
  };

  plugin.eventBus.on("before-upload-assets", listener);
  scope.own(() => plugin.eventBus.off("before-upload-assets", listener));
}

async function processUpload(
  input: UploadInput,
  rootID: string,
  hostSignal: AbortSignal | undefined,
  registrationSignal: AbortSignal,
  scope: FeatureScope,
  shouldCompress: (rootId: string) => Promise<boolean>,
  services: ImageProcessingServices,
  config: ImageConfig,
  logger: DebugLogger,
): Promise<{ input: UploadInput; replacements: File[] }> {
  const original = input;
  const signal = linkedSignal(scope.signal, hostSignal, registrationSignal);
  const unchanged = () => ({ input: original, replacements: [] as File[] });
  const canceled = () => !scope.active || signal.aborted;
  try {
    if (canceled() || !config.auto.uploads || !await shouldCompress(rootID) || canceled()) return unchanged();

    let files: File[];
    if (input.kind === "files") {
      if (input.files.some(file => !(file instanceof File))) return unchanged();
      files = [...input.files];
    } else {
      // Materialize the entire local batch before compression so any failed read keeps
      // the host's original local-files input intact and in its original order.
      files = [];
      let totalBytes = 0;
      for (const local of input.files) {
        if (canceled() || local.isDir) return unchanged();
        const source = resolveLocalFile(local.path, services.origin);
        const read = await services.reader.read(source, {
          maxBytes: config.compression.maxInputBytes,
          timeoutMs: 30_000,
          signal,
        });
        totalBytes += read.blob.size;
        if (totalBytes > 64 * 1024 * 1024) throw new Error("Local upload materialisation exceeds batch limit");
        files.push(new File([read.blob], read.name, { type: read.blob.type }));
      }
    }

    const output = [...files];
    const intent = { kind: "upload" as const, rootID, originalInputCount: input.files.length };
    for (let index = 0; index < files.length; index++) {
      if (canceled()) return unchanged();
      const file = files[index];
      if (!isImageCandidate(file)) continue;
      try {
        const result = await services.encoder.encode(file, file.name, config, signal);
        if (result.kind === "skipped") continue;
        if (retainOriginal(intent, config)) {
          // Archive the exact original before making its replacement available to the host.
          try { await services.assets.archive(file, rootID, signal); }
          catch (error) {
            if (signal.aborted) throw error;
            logger.warn("原图归档失败，将上传原文件", { index: index + 1, error });
            continue;
          }
        }
        if (canceled()) return unchanged();
        output[index] = result.value.file;
      } catch (error) {
        if (signal.aborted) return unchanged();
        logger.warn("图片自动压缩失败，将上传原文件", { index: index + 1, error });
      }
    }
    if (canceled()) return unchanged();
    const replaced = output.some((file, index) => file !== files[index]);
    if (!replaced) return unchanged();
    return { input: { kind: "files", files: output }, replacements: output.filter((file, index) => file !== files[index]) };
  } catch (error) {
    logger.warn("自动上传处理失败，将上传原始输入", error);
    return unchanged();
  } finally {
    signal.dispose();
  }
}

function resolveLocalFile(path: string, origin: string) {
  const source = resolveSource(path, origin);
  if (source.kind !== "file") throw new Error("Invalid desktop upload path");
  return source;
}

function linkedSignal(...signals: Array<AbortSignal | undefined>): AbortSignal & { dispose(): void } {
  const controller = new AbortController();
  const relays = signals.filter((signal): signal is AbortSignal => Boolean(signal)).map(signal => {
    const relay = () => controller.abort(signal.reason);
    if (signal.aborted) relay();
    else signal.addEventListener("abort", relay, { once: true });
    return { signal, relay };
  });
  const result = controller.signal as AbortSignal & { dispose(): void };
  result.dispose = () => relays.forEach(({ signal, relay }) => signal.removeEventListener("abort", relay));
  return result;
}

function isImageCandidate(file: File): boolean {
  return /\.(?:png|jpe?g|webp)$/i.test(file.name) || /^image\/(?:png|jpeg|webp)$/i.test(file.type);
}
