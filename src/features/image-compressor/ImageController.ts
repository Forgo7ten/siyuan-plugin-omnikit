import { showMessage } from "siyuan";
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
import type { TaskRegistry } from "./policy/TaskRegistry.ts";
import type { ImageTaskState } from "./ui/ImageTaskUI.ts";
import type { AutoUploadNotice } from "./actions/AutoUploadHandler.ts";

/**
 * ImageController: Unified facade for all image compression actions.
 * Decouples menu/UI event triggers from execution and task life-cycles.
 */
export class ImageController {
  constructor(
    private readonly context: FeatureContext,
    private readonly scope: FeatureScope,
    private readonly services: ImageProcessingServices,
    private readonly tasks: TaskRegistry,
  ) {}

  private t(key: string, values: Record<string, string | number> = {}): string {
    return translate(this.context.plugin.i18n as Record<string, unknown>, key, values);
  }

  present(outcome: ImageActionOutcome | void): void {
    if (!outcome || outcome.kind === "silent") return;
    if (outcome.kind === "copyable-path") {
      this.services.ui.copyablePath(outcome.path, outcome.key);
      return;
    }
    const msg = this.t(outcome.key, outcome.values);
    if (this.context.feedback) {
      this.context.feedback.notify(msg);
    } else {
      this.services.ui.notify(msg);
    }
  }

  reportAutoUploadNotice(notice: AutoUploadNotice): void {
    if (!this.scope.active) return;
    const feedback = this.context.feedback;
    const notify = (msg: string, type: "info" | "error" = "info", timeout = 4000) => {
      if (feedback) feedback.notify(msg, type, { timeout });
      else this.services.ui.notify(msg);
    };

    if (notice.total === 1 && notice.singleReason) {
      if (notice.singleReason === "success") {
        notify(this.t("image.autoUpload.singleSuccess"), "info", 3000);
      } else if (notice.singleReason === "noBenefit" || notice.singleReason === "other") {
        notify(this.t("image.autoUpload.singleNoBenefit"), "info", 4000);
      } else if (notice.singleReason === "notAuthorized") {
        notify(this.t("image.autoUpload.singleNotAuthorized"), "info", 4000);
      } else if (notice.singleReason === "conflict") {
        notify(this.t("image.autoUpload.singleConflict"), "info", 4000);
      } else if (notice.singleReason === "notMatched") {
        notify(this.t("image.autoUpload.singleNotMatched"), "info", 4000);
      } else if (notice.singleReason === "failed") {
        notify(this.t("image.autoUpload.singleFailed"), "error", 5000);
      }
      return;
    }

    if (notice.successful === notice.total) {
      notify(this.t("image.autoUpload.allSuccess", { count: notice.successful }), "info", 4000);
    } else if (notice.skipped === notice.total) {
      // Silent when all skipped
    } else {
      const msg = this.t("image.autoUpload.summary", {
        successful: notice.successful,
        skipped: notice.skipped,
        failed: notice.failed,
      });
      notify(msg, notice.failed > 0 ? "error" : "info", 5000);
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
      showMessage(this.t("image.single.invalidTarget"), 5000, "error");
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
      showMessage(this.t("image.single.invalidTarget"), 5000, "error");
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
   */
  async compressDocument(
    menuDetail: unknown,
    rootID: string,
  ): Promise<void> {
    if (!this.scope.active) return;
    const protyle = (menuDetail as any)?.protyle ?? (menuDetail as any)?.editor?.protyle;
    if (!rootID || protyle?.block?.rootID !== rootID) {
      showMessage(this.t("image.batch.invalidDocument"), 5000, "error");
      return;
    }

    const controller = this.tasks.create(this.scope.signal);
    let state: ImageTaskState = {
      id: crypto.randomUUID(),
      phase: "preparing",
      total: 0,
      completed: 0,
      uploaded: 0,
      skipped: 0,
      failed: 0,
      messages: [],
    };

    const listeners = new Set<(value: ImageTaskState) => void>();
    const publish = (next: Partial<ImageTaskState>) => {
      state = { ...state, ...next };
      for (const listener of listeners) listener(state);
    };

    const view = this.services.ui.progress(
      {
        snapshot: () => state,
        subscribe: listener => {
          listeners.add(listener);
          listener(state);
          return () => listeners.delete(listener);
        },
      },
    );

    try {
      const options: BatchActionOptions = {
        signal: controller.signal,
        onProgress: update => {
          if (!this.scope.active) return;
          publish({
            total: update.total,
            completed: update.completed,
            uploaded: update.uploaded ?? 0,
            skipped: update.skipped,
            failed: update.failed,
            referenceResult: update.referenceResult,
            currentFile: update.currentFile,
          });
          if (update.total > 0 && this.context.statusBar) {
            const fileSuffix = update.currentFile ? ` · ${update.currentFile}` : "";
            this.context.statusBar.update(state.id, `图片压缩 ${update.completed}/${update.total}${fileSuffix}`);
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
        if (result.total === 0) {
          view.close();
          return;
        }
        publish({
          phase: result.cancelled
            ? "cancelled"
            : result.referenceResult?.state === "unknown"
              ? "unknown"
              : !result.scanComplete
                ? "failed"
                : result.failed || result.conflicts || result.referenceResult?.state === "partial"
                  ? "partial"
                  : "done",
          total: result.total,
          completed: result.completed,
          uploaded: result.uploaded ?? 0,
          skipped: result.skipped,
          failed: result.failed,
          referenceResult: result.referenceResult,
        });

        if (result.total > 0 && !result.cancelled && result.scanComplete) {
          const formatBytes = (size: number) => size < 1024 ? `${size} B` : `${(size / 1024).toFixed(1)} KB`;
          const summaryMsg = this.t("image.batch.complete", {
            succeeded: result.succeeded,
            skipped: result.skipped,
            failed: result.failed,
            conflicts: result.conflicts,
            logical: formatBytes(result.logicalReductionBytes),
            reclaimed: formatBytes(result.diskReclaimedBytes),
          });
          if (this.context.feedback) {
            this.context.feedback.notify(summaryMsg, "info", { timeout: 7000 });
          } else {
            this.services.ui.notify(summaryMsg);
          }
        }
      }
    } catch (error) {
      this.context.logger.error("批量压缩文档图片失败", error);
      if (this.scope.active) publish({ phase: "failed", messages: [String(error)] });
    } finally {
      this.context.statusBar?.clear(state.id);
      this.tasks.release(controller);
      if (!this.scope.active) view.close();
    }
  }
}
