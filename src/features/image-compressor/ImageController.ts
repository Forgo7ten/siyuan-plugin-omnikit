import { showMessage } from "siyuan";
import type { FeatureContext } from "../../core/FeatureContext.ts";
import type { FeatureScope } from "../../core/FeatureScope.ts";
import { translate } from "../../i18n/translate.ts";
import type { ImageProcessingServices } from "./ImageProcessingServices.ts";
import {
  compressSelectedImage,
  compressSelectedImageFromFile,
  type SingleImageEditorContext,
} from "./SingleImageAction.ts";
import { compressDocumentImages, type BatchActionOptions } from "./DocumentBatchAction.ts";
import type { TaskRegistry } from "./TaskRegistry.ts";
import type { ImageTaskState } from "./ImageTaskUI.ts";

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

  /**
   * Compresses the selected single image inside an active editor.
   */
  async compressSingle(
    menuDetail: unknown,
    editor: SingleImageEditorContext,
    providedFile?: File,
  ): Promise<void> {
    if (!this.scope.active || editor.disabled) {
      showMessage(this.t("image.single.invalidTarget"), 5000, "error");
      return;
    }
    await compressSelectedImage(
      menuDetail,
      this.context,
      this.scope,
      editor,
      this.services,
      providedFile,
    );
  }

  /**
   * Compresses the selected single image using a user-picked original file.
   */
  async compressSingleFromFile(
    menuDetail: unknown,
    editor: SingleImageEditorContext,
    file: File,
  ): Promise<void> {
    if (!this.scope.active || editor.disabled) {
      showMessage(this.t("image.single.invalidTarget"), 5000, "error");
      return;
    }
    await compressSelectedImageFromFile(
      menuDetail,
      file,
      this.context,
      this.scope,
      editor,
      this.services,
    );
  }

  /**
   * Batches all compressible images in the current document with live progress tracking.
   */
  async compressDocument(
    menuDetail: unknown,
    rootID: string,
  ): Promise<void> {
    const protyle = (menuDetail as any)?.protyle ?? (menuDetail as any)?.editor?.protyle;
    if (!this.scope.active || !rootID || protyle?.block?.rootID !== rootID) {
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
      () => controller.abort("User cancelled"),
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
          });
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
      }
    } catch (error) {
      this.context.logger.error("批量压缩文档图片失败", error);
      if (this.scope.active) publish({ phase: "failed", messages: [String(error)] });
    } finally {
      this.tasks.release(controller);
      if (!this.scope.active) view.close();
    }
  }
}
