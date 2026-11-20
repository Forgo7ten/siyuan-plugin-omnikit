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
    if (this.context.feedback) {
      this.context.feedback.notify(msg, type, timeout === undefined ? undefined : { timeout });
    } else {
      this.services.ui.notify(msg);
    }
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
      if (notice.singleReason === "success") {
        notify(this.t("image.autoUpload.singleSuccess"), "info", 3000);
      } else if (notice.singleReason === "unknown") {
        notify(this.t("image.autoUpload.singleUnknown"), "info", 4000);
      } else if (notice.singleReason === "noBenefit") {
        notify(this.t("image.autoUpload.singleNoBenefit"), "info", 4000);
      } else if (notice.singleReason === "other") {
        notify(this.t("image.autoUpload.singleSkipped"), "info", 4000);
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

    const unknownCount = notice.unknown ?? 0;
    if (notice.successful === notice.total) {
      notify(this.t("image.autoUpload.allSuccess", { count: notice.successful }), "info", 4000);
    } else if (notice.skipped === notice.total && unknownCount === 0) {
      // Silent when all skipped
    } else {
      const base = this.t("image.autoUpload.summary", {
        successful: notice.successful,
        skipped: notice.skipped,
        failed: notice.failed,
      });
      const msg = unknownCount > 0
        ? `${base} (${this.t("image.batch.unknownCount", { count: unknownCount })})`
        : base;
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
    const protyle = (menuDetail as any)?.protyle ?? (menuDetail as any)?.editor?.protyle;
    if (!rootID || !NODE_ID.test(rootID) || (protyle && ((protyle.block?.rootID && protyle.block.rootID !== rootID) || protyle.disabled))) {
      this.notifyFeedback(this.t("image.batch.invalidDocument"), "error", 5000);
      return;
    }
    const editorNotebook = resolveNotebookID(menuDetail)
      ?? resolveNotebookID(protyle)
      ?? (typeof (menuDetail as any)?.items?.[0]?.notebookId === "string"
        ? (menuDetail as any).items[0].notebookId
        : undefined);

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
        messages: [],
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
            this.context.statusBar.update(taskId, `图片压缩 ${stepText}${fileSuffix}`);
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

        const formatBytes = (size: number) => size < 1024 ? `${size} B` : `${(size / 1024).toFixed(1)} KB`;
        const summaryMsg = this.t("image.batch.complete", {
          succeeded: result.succeeded,
          skipped: result.skipped,
          failed: result.failed,
          conflicts: result.conflicts,
          logical: formatBytes(result.logicalReductionBytes),
          reclaimed: formatBytes(result.diskReclaimedBytes),
        });
        const finalMsg = result.unknown > 0
          ? `${summaryMsg} (${this.t("image.batch.unknownCount", { count: result.unknown })})`
          : summaryMsg;
        this.notifyFeedback(finalMsg, "info", 7000);
      }
    } catch (error) {
      this.context.logger.error("批量压缩文档图片失败", error);
      if (this.scope.active && state) {
        const msg = describeError(error);
        state = { ...state, phase: "failed", messages: [msg] };
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
