import { resolveNotebookID } from "../../core/host/ProtyleAdapter.ts";
import { createRuntimeId } from "../../core/host/id.ts";
import { describeError } from "../../core/host/describeError.ts";
import type { FeatureContext } from "../../core/framework/FeatureContext.ts";
import type { FeatureScope } from "../../core/framework/FeatureScope.ts";
import { translate } from "../../i18n/translate.ts";
import type { ImageProcessingServices } from "./services/ImageProcessingServices.ts";
import {
  compressSelectedImageQuick,
  compressSelectedImageCustom,
  type SingleImageEditorContext,
  type ImageActionOutcome,
} from "./actions/SingleImageAction.ts";
import { compressDocumentImages, type BatchActionOptions } from "./actions/DocumentBatchAction.ts";
import { NODE_ID } from "./policy/parseImageConfig.ts";
import { buildCompressionNoticeValues, formatBytes } from "./policy/formatStats.ts";
import type { TaskRegistry } from "./policy/TaskRegistry.ts";
import type { ImageTaskState } from "./ui/ImageTaskUI.ts";
import type { AutoUploadNotice } from "./actions/AutoUploadHandler.ts";

/**
 * ImageController: Unified facade for all image compression actions.
 * Decouples menu/UI event triggers from execution and task life-cycles.
 */
export class ImageController {
  private readonly activeDocuments = new Set<string>();

  constructor(
    private readonly context: FeatureContext,
    private readonly scope: FeatureScope,
    private readonly services: ImageProcessingServices,
    private readonly tasks: TaskRegistry,
  ) {}

  private t(key: string, values: Record<string, string | number> = {}): string {
    return translate(this.context.plugin.i18n as Record<string, unknown>, key, values);
  }

  private notifyFeedback(msg: string, type: "info" | "error" = "info", timeout?: number): void {
    this.context.feedback.notify(msg, type, timeout === undefined ? undefined : { timeout });
  }

  present(outcome: ImageActionOutcome | void): void {
    if (!outcome || outcome.kind === "silent") return;
    if (outcome.kind === "copyable-path") {
      this.services.ui.copyablePath(outcome.path, outcome.key);
      return;
    }
    this.notifyFeedback(this.t(outcome.key, outcome.values));
  }

  reportAutoUploadNotice(notice: AutoUploadNotice): void {
    if (!this.scope.active) return;
    const notify = (msg: string, type: "info" | "error" = "info", timeout = 4000) => {
      this.notifyFeedback(msg, type, timeout);
    };

    if (notice.total === 1 && notice.singleReason) {
      const keyMap = {
        success: ["image.autoUpload.singleSuccess", "info", 3000],
        unknown: ["image.autoUpload.singleUnknown", "info", 4000],
        failed: ["image.autoUpload.singleFailed", "error", 5000],
      } as const;
      const [key, type, timeout] = keyMap[notice.singleReason];
      const values = notice.singleReason === "success"
        ? buildCompressionNoticeValues(notice.originalBytes, notice.compressedBytes)
        : {};
      notify(this.t(key, values), type, timeout);
      return;
    }

    const unknownCount = notice.unknown ?? 0;
    if (notice.successful === notice.total) {
      notify(this.t("image.autoUpload.allSuccess", { count: notice.successful }), "info", 4000);
    } else {
      const sep = this.t("image.batch.part.sep");
      const parts: string[] = [this.t("image.autoUpload.part.total", { count: notice.total })];
      if (notice.successful > 0) parts.push(this.t("image.autoUpload.part.successful", { count: notice.successful }));
      if (notice.skipped > 0) parts.push(this.t("image.autoUpload.part.skipped", { count: notice.skipped }));
      if (notice.failed > 0) parts.push(this.t("image.autoUpload.part.failed", { count: notice.failed }));
      if (unknownCount > 0) parts.push(this.t("image.batch.unknownCount", { count: unknownCount }));
      notify(this.t("image.autoUpload.summary", { details: parts.join(sep) }), notice.failed > 0 ? "error" : "info", 5000);
    }
  }

  /**
   * Compresses the selected single image inside an active editor.
   */
  async compressSingleQuick(
    menuDetail: unknown,
    editor: SingleImageEditorContext,
  ): Promise<void> {
    if (!this.scope.active) return;
    if (editor.disabled) {
      this.notifyFeedback(this.t("image.single.invalidTarget"), "error", 5000);
      return;
    }
    const outcome = await compressSelectedImageQuick(
      menuDetail,
      this.context,
      this.scope,
      editor,
      this.services,
    );
    this.present(outcome);
  }

  /** Opens the manual, save-gated preview dialog for one selected occurrence. */
  async compressSingleCustom(
    menuDetail: unknown,
    editor: SingleImageEditorContext,
  ): Promise<void> {
    if (!this.scope.active) return;
    if (editor.disabled) {
      this.notifyFeedback(this.t("image.single.invalidTarget"), "error", 5000);
      return;
    }
    const outcome = await compressSelectedImageCustom(
      menuDetail,
      this.context,
      this.scope,
      editor,
      this.services,
    );
    this.present(outcome);
  }

  /**
   * Batches all compressible images in the current document with live progress tracking.
   * Editor navigation/closure does not cancel an already-started document task; only
   * feature/plugin shutdown or explicit dismissal of the progress dialog aborts pending work.
   */
  async compressDocument(
    menuDetail: unknown,
    rootID: string,
  ): Promise<void> {
    if (!this.scope.active) return;
    const protyle = (menuDetail as any)?.protyle;
    if (!rootID || !NODE_ID.test(rootID) || (protyle && ((protyle.block?.rootID && protyle.block.rootID !== rootID) || protyle.disabled))) {
      this.notifyFeedback(this.t("image.batch.invalidDocument"), "error", 5000);
      return;
    }
    const editorNotebook = resolveNotebookID(menuDetail);

    if (this.activeDocuments.has(rootID)) {
      this.notifyFeedback(this.t("image.batch.alreadyRunning"), "info", 4000);
      return;
    }
    this.activeDocuments.add(rootID);

    let controller: AbortController | undefined;
    let view: { close(): void } | undefined;
    let taskId = "";
    let state: ImageTaskState | undefined;

    try {
      controller = this.tasks.create(this.scope.signal);
      taskId = createRuntimeId("img-task");
      state = {
        id: taskId,
        phase: "preparing",
        total: 0,
        completed: 0,
        uploaded: 0,
        skipped: 0,
        failed: 0,
        unknown: 0,
      };

      const listeners = new Set<(value: ImageTaskState) => void>();
      const publish = (next: Partial<ImageTaskState>) => {
        if (!state) return;
        state = { ...state, ...next };
        for (const listener of listeners) listener(state);
      };

      view = this.services.ui.progress(
        {
          snapshot: () => state!,
          subscribe: listener => {
            listeners.add(listener);
            listener(state!);
            return () => listeners.delete(listener);
          },
        },
        () => {
          controller?.abort(new DOMException("Task modal dismissed", "AbortError"));
        },
      );

      const options: BatchActionOptions = {
        rootID,
        notebook: editorNotebook,
        signal: controller.signal,
        onProgress: update => {
          if (!this.scope.active) return;
          const next: Partial<ImageTaskState> = {
            total: update.total,
            completed: update.completed,
            uploaded: update.uploaded ?? 0,
            skipped: update.skipped,
            failed: update.failed,
            unknown: update.unknown,
            currentFile: update.currentFile,
          };
          if (update.phase) next.phase = update.phase;
          if (update.prepared !== undefined) next.prepared = update.prepared;
          if (update.preparedTotal !== undefined) next.preparedTotal = update.preparedTotal;
          publish(next);
          if (update.total > 0 && this.context.statusBar) {
            const fileSuffix = update.currentFile ? ` · ${update.currentFile}` : "";
            const stepText = update.phase === "preparing" && update.preparedTotal
              ? `${update.prepared ?? 0}/${update.preparedTotal}`
              : `${update.completed}/${update.total}`;
            this.context.statusBar.update(taskId, `${this.t("feature.imageCompressor.title")} ${stepText}${fileSuffix}`);
          }
        },
      };

      const result = await compressDocumentImages(
        menuDetail,
        this.context,
        this.scope,
        this.services,
        options,
      );

      if (this.scope.active) {
        if (result.cancelled) {
          view.close();
          return;
        }
        if (result.total === 0 && result.scanComplete) {
          view.close();
          this.notifyFeedback(this.t("image.batch.noImages"), "info", 4000);
          return;
        }
        if (!result.scanComplete) {
          view.close();
          this.notifyFeedback(this.t("image.batch.scanFailed"), "error", 5000);
          return;
        }
        publish({
          phase: result.unknown > 0
            ? "unknown"
            : result.failed || result.conflicts
              ? "partial"
              : "done",
          total: result.total,
          completed: result.completed,
          uploaded: result.uploaded ?? 0,
          skipped: result.skipped,
          failed: result.failed,
          unknown: result.unknown,
        });

        if (result.total === 1 && result.succeeded === 1) {
          this.notifyFeedback(
            this.t(
              "image.single.quickSuccess",
              buildCompressionNoticeValues(result.originalReferencedBytes, result.newReferencedBytes),
            ),
            "info",
            4000,
          );
          return;
        }

        const sep = this.t("image.batch.part.sep");
        const parts: string[] = [this.t("image.batch.part.total", { count: result.total })];
        if (result.succeeded > 0) parts.push(this.t("image.batch.part.succeeded", { count: result.succeeded }));
        if (result.skipped > 0) parts.push(this.t("image.batch.part.skipped", { count: result.skipped }));
        if (result.failed > 0) parts.push(this.t("image.batch.part.failed", { count: result.failed }));
        if (result.conflicts > 0) parts.push(this.t("image.batch.part.conflicts", { count: result.conflicts }));
        if (result.unknown > 0) parts.push(this.t("image.batch.unknownCount", { count: result.unknown }));
        const finalMsg = this.t("image.batch.complete", {
          details: parts.join(sep),
          logical: formatBytes(result.logicalReductionBytes),
        });
        this.notifyFeedback(finalMsg, "info", 7000);
      }
    } catch (error) {
      this.context.logger.error("批量压缩文档图片失败", error);
      if (this.scope.active) {
        const msg = describeError(error);
        view?.close();
        this.notifyFeedback(msg, "error", 5000);
      }
    } finally {
      this.activeDocuments.delete(rootID);
      if (taskId) this.context.statusBar?.clear(taskId);
      if (controller) this.tasks.release(controller);
      if (!this.scope.active) view?.close();
    }
  }
}
