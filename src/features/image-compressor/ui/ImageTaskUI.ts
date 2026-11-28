import { Dialog } from "siyuan";
import { mount, unmount, type Component } from "svelte";
import type { UiFeedback } from "../../../core/feedback/UiFeedback.ts";
import ImageTaskPanel from "./ImageTaskPanel.svelte";
import ImageCompressionDialog from "./ImageCompressionDialog.svelte";
import type { ManualCompressionPreview } from "../actions/SingleImageAction.ts";

export type ImageTaskPhase = "preparing" | "applying" | "done" | "partial" | "unknown";

export interface ImageTaskState {
  id: string;
  phase: ImageTaskPhase;
  total: number;
  completed: number;
  uploaded: number;
  skipped: number;
  failed: number;
  unknown: number;
  prepared?: number;
  preparedTotal?: number;
  currentFile?: string;
}

export interface ImageTaskStateStore {
  snapshot(): ImageTaskState;
  subscribe(listener: (state: ImageTaskState) => void): () => void;
}

/** The small host surface required by the image feature's existing lifecycle scope. */
export interface ImageTaskScope {
  readonly active: boolean;
  own(dispose: () => void): () => void;
}

export interface ManualCompressionDefaults {
  quality: number;
  manualMaxEdge: number;
  smartEnabled?: boolean;
  targetSimilarity?: number;
  smartSupported?: boolean;
}

export interface ManualCompressionSmartOptions {
  smartEnabled: boolean;
  targetSimilarity: number;
}

export interface CopyablePathDialogOptions {
  title: string;
  reasonText: string;
  path: string;
  copyButtonText?: string;
  width?: string;
}

/** UI adapter contract consumed by ImageController. */
export interface ImageUI {
  manualCompression(options: {
    sourceName: string;
    defaults: ManualCompressionDefaults;
    previewEncode(
      quality: number,
      manualMaxEdge: number,
      smartOptions?: ManualCompressionSmartOptions,
    ): Promise<ManualCompressionPreview>;
    save(preview: ManualCompressionPreview, replace: boolean): Promise<void>;
    onClose(): void;
  }): void;
  progress(state: ImageTaskStateStore, onClose?: () => void): { close(): void };
  notify(message: string, type?: "info" | "error"): void;
  copyablePath(path: string, messageKey?: string): void;
}

export function openCopyablePathDialog(
  scope: ImageTaskScope,
  options: CopyablePathDialogOptions,
): { close(): void } | undefined {
  if (!scope.active) return undefined;
  let closed = false;
  let release: () => void = () => undefined;
  const hasCopyButton = Boolean(options.copyButtonText);
  const dialog = new Dialog({
    title: options.title,
    content: `<div class="b3-dialog__content"><p class="omnikit-copy-reason"></p><input class="b3-text-field omnikit-copy-path" readonly />${hasCopyButton ? '<button type="button" class="b3-button omnikit-copy-button"></button>' : ""}</div>`,
    width: options.width ?? "min(640px, 94vw)",
    destroyCallback: () => {
      if (closed) return;
      closed = true;
      release();
    },
  });
  release = scope.own(() => {
    if (!closed) {
      closed = true;
      dialog.destroy?.();
    }
  });
  const reason = dialog.element?.querySelector?.<HTMLElement>(".omnikit-copy-reason");
  const input = dialog.element?.querySelector?.<HTMLInputElement>(".omnikit-copy-path");
  const copy = dialog.element?.querySelector?.<HTMLButtonElement>(".omnikit-copy-button");
  if (reason) reason.textContent = options.reasonText;
  if (input) {
    input.value = options.path;
    input.onclick = () => input.select();
    input.focus();
    input.select();
  }
  if (copy && input && options.copyButtonText) {
    copy.textContent = options.copyButtonText;
    copy.onclick = () => {
      void navigator.clipboard?.writeText(options.path).catch(() => input.select());
    };
  }
  return {
    close: () => {
      if (!closed) {
        closed = true;
        dialog.destroy?.();
        release();
      }
    },
  };
}

export function mountDialog<P extends Record<string, unknown>>(
  scope: ImageTaskScope,
  title: string,
  View: Component<P>,
  props: P,
  onClose: () => void,
): { close(): void } {
  let instance: ReturnType<typeof mount> | undefined;
  let closed = false;
  let closingByController = false;
  let releaseScope: () => void = () => undefined;
  const dialog = new Dialog({
    title,
    content: '<div class="omnikit-image-dialog-host"></div>',
    width: "min(900px, 94vw)",
    destroyCallback: () => {
      if (closed) return;
      closed = true;
      if (!closingByController) {
        onClose();
      }
      if (instance) void unmount(instance);
      releaseScope();
    },
  });

  const target = dialog.element.querySelector<HTMLElement>(".omnikit-image-dialog-host");
  if (!target) {
    closingByController = true;
    dialog.destroy();
    throw new Error("Image task dialog mount element missing");
  }
  instance = mount(View, { target, props });
  releaseScope = scope.own(() => {
    if (!closed) {
      closingByController = true;
      dialog.destroy();
    }
  });
  return {
    close: () => {
      if (closed) return;
      closingByController = true;
      dialog.destroy();
    },
  };
}

export function createImageUI(
  scope: ImageTaskScope,
  t: (key: string, values?: Record<string, string | number>) => string,
  feedback: UiFeedback,
): ImageUI {
  return {
    notify(message, type = "info") {
      feedback.notify(message, type, { timeout: 5000 });
    },

    copyablePath(path, messageKey = "image.recordSaveFailed") {
      openCopyablePathDialog(scope, {
        title: "OmniKit WebP",
        reasonText: t(messageKey),
        path,
        copyButtonText: t("image.copyablePath"),
        width: "min(640px, 94vw)",
      });
    },

    progress(state, onClose) {
      return mountDialog(scope, t("image.task.title"), ImageTaskPanel, { job: state, t }, () => onClose?.());
    },

    manualCompression(options) {
      if (!scope.active) return;
      let instance: ReturnType<typeof mount> | undefined;
      let closed = false;
      let release: () => void = () => undefined;
      const dialog = new Dialog({
        title: t("image.dialog.title"),
        content: '<div class="omnikit-image-manual-host"></div>',
        width: "min(760px, 94vw)",
        destroyCallback: () => {
          if (closed) return;
          closed = true;
          options.onClose();
          if (instance) void unmount(instance);
          release();
        },
      });
      const target = dialog.element.querySelector<HTMLElement>(".omnikit-image-manual-host");
      if (!target) { dialog.destroy(); return; }
      instance = mount(ImageCompressionDialog, {
        target,
        props: {
          sourceName: options.sourceName,
          defaults: options.defaults,
          t,
          previewEncode: options.previewEncode,
          onClose: () => dialog.destroy(),
          save: async (preview: ManualCompressionPreview, replace: boolean) => {
            await options.save(preview, replace);
            dialog.destroy();
          },
        },
      });
      release = scope.own(() => { if (!closed) dialog.destroy(); });
    },
  };
}
