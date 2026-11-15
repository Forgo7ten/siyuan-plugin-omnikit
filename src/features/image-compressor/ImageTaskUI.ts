import { Dialog, showMessage } from "siyuan";
import { mount, unmount, type Component } from "svelte";
import ImageTaskPanel from "./ImageTaskPanel.svelte";
import ImageCompressionDialog from "./ImageCompressionDialog.svelte";
import type { ManualCompressionPreview } from "./SingleImageAction.ts";

export interface ImageTaskState {
  id: string;
  phase: "preparing" | "preview" | "applying" | "done" | "partial" | "cancelled" | "failed" | "unknown";
  total: number;
  completed: number;
  uploaded: number;
  skipped: number;
  failed: number;
  messages: string[];
  referenceResult?: {
    backend: string;
    referencesChanged: number | null;
    storageRecordsChanged: number | null;
  };
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

/** UI adapter contract consumed by ImageController. */
export interface ImageUI {
  confirm(title: string, message: string, signal: AbortSignal): Promise<boolean>;
  manualCompression(options: {
    sourceName: string;
    defaults: { quality: number; manualMaxEdge: number };
    previewEncode(quality: number, manualMaxEdge: number): Promise<ManualCompressionPreview>;
    save(preview: ManualCompressionPreview, replace: boolean): Promise<void>;
    onClose(): void;
  }): void;
  progress(state: ImageTaskStateStore): { close(): void };
  notify(message: string): void;
  copyablePath(path: string, messageKey?: string): void;
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
  let release: () => void = () => undefined;
  const dialog = new Dialog({
    title,
    content: '<div class="omnikit-image-dialog-host"></div>',
    width: "min(900px, 94vw)",
    destroyCallback: () => {
      if (closed) return;
      closed = true;
      onClose();
      if (instance) void unmount(instance);
      release();
    },
  });

  const target = dialog.element.querySelector<HTMLElement>(".omnikit-image-dialog-host");
  if (!target) {
    dialog.destroy();
    throw new Error("Image task dialog mount element missing");
  }
  instance = mount(View, { target, props });
  release = scope.own(() => { if (!closed) dialog.destroy(); });
  return { close: release };
}

export function createImageUI(scope: ImageTaskScope, t: (key: string) => string): ImageUI {
  return {
    notify(message) {
      if (scope.active) showMessage(message, 5000);
    },

    copyablePath(path, messageKey = "image.recordSaveFailed") {
      if (!scope.active) return;
      const dialog = new Dialog({
        title: "OmniKit WebP",
        content: '<div class="b3-dialog__content"><p class="omnikit-copy-reason"></p><input class="b3-text-field omnikit-copy-path" readonly /><button type="button" class="b3-button omnikit-copy-button"></button></div>',
        width: "min(640px, 94vw)",
      });
      scope.own(() => dialog.destroy());
      const reason = dialog.element.querySelector<HTMLElement>(".omnikit-copy-reason");
      const input = dialog.element.querySelector<HTMLInputElement>(".omnikit-copy-path");
      const copy = dialog.element.querySelector<HTMLButtonElement>(".omnikit-copy-button");
      if (reason) reason.textContent = t(messageKey);
      if (input) {
        input.value = path;
        input.onclick = () => input.select();
        input.focus();
        input.select();
      }
      if (copy && input) {
        copy.textContent = t("image.copyablePath");
        copy.onclick = () => {
          void navigator.clipboard?.writeText(path).catch(() => input.select());
        };
      }
    },

    progress(state) {
      return mountDialog(scope, t("image.task.title"), ImageTaskPanel, { job: state, t }, () => undefined);
    },

    confirm(title, message, signal) {
      return new Promise<boolean>(resolve => {
        if (signal.aborted || !scope.active) { resolve(false); return; }

        let settled = false;
        let release: () => void = () => undefined;
        let dialog: Dialog;
        const finish = (value: boolean) => {
          if (settled) return;
          settled = true;
          signal.removeEventListener("abort", abort);
          resolve(value);
          dialog.destroy();
          release();
        };
        const abort = () => finish(false);
        dialog = new Dialog({
          title,
          content: '<div class="b3-dialog__content"><p class="omnikit-image-confirm-text"></p><div class="omnikit-image-confirm-actions"></div></div>',
          width: "min(640px, 94vw)",
          destroyCallback: abort,
        });
        const paragraph = dialog.element.querySelector<HTMLElement>(".omnikit-image-confirm-text");
        const actions = dialog.element.querySelector<HTMLElement>(".omnikit-image-confirm-actions");
        if (!paragraph || !actions) { finish(false); return; }
        paragraph.textContent = message;
        paragraph.style.whiteSpace = "pre-wrap";
        for (const [label, answer] of [[t("common.cancel"), false], [t("common.confirm"), true]] as const) {
          const button = document.createElement("button");
          button.type = "button";
          button.className = "b3-button b3-button--outline";
          button.style.marginInlineEnd = "12px";
          button.textContent = label;
          button.onclick = () => finish(answer);
          actions.append(button);
        }
        signal.addEventListener("abort", abort, { once: true });
        release = scope.own(abort);
      });
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
