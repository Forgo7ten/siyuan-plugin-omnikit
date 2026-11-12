import { Dialog, showMessage } from "siyuan";
import { mount, unmount, type Component } from "svelte";
import ImageTaskPanel from "./ImageTaskPanel.svelte";

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
  pickImage(name: string, signal: AbortSignal): Promise<File | undefined>;
  progress(state: ImageTaskStateStore, cancel: () => void): { close(): void };
  notify(message: string): void;
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

    progress(state, cancel) {
      return mountDialog(scope, t("image.task.title"), ImageTaskPanel, { job: state, cancel, t }, cancel);
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

    pickImage(name, signal) {
      return new Promise<File | undefined>(resolve => {
        if (signal.aborted || !scope.active) { resolve(undefined); return; }

        let settled = false;
        let release: () => void = () => undefined;
        let dialog: Dialog;
        const finish = (file?: File) => {
          if (settled) return;
          settled = true;
          signal.removeEventListener("abort", abort);
          resolve(file);
          dialog.destroy();
          release();
        };
        const abort = () => finish();
        dialog = new Dialog({
          title: t("sources.pickOriginal"),
          content: '<div class="b3-dialog__content"></div>',
          width: "min(560px, 94vw)",
          destroyCallback: abort,
        });
        const host = dialog.element.querySelector<HTMLElement>(".b3-dialog__content");
        if (!host) { finish(); return; }
        const label = document.createElement("label");
        label.textContent = `${t("sources.chooseMatchingFile")} ${name}`;
        const input = document.createElement("input");
        input.type = "file";
        input.accept = "image/png,image/jpeg,image/webp";
        input.className = "b3-text-field";
        input.style.display = "block";
        input.style.marginTop = "16px";
        input.onchange = () => finish(input.files?.[0]);
        label.append(input);
        host.append(label);
        // Keep the native file input visible so browsers retain user activation.
        signal.addEventListener("abort", abort, { once: true });
        release = scope.own(abort);
      });
    },
  };
}
