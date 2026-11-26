import { Dialog, getAllModels, openTab, type App, type TProtyleAction } from "siyuan";

export interface HostDialogHandle {
  readonly element: HTMLElement;
  destroy(): void;
}

export interface HostDialogOptions {
  title: string;
  content: string;
  width?: string;
  height?: string;
  destroyCallback?: () => void;
}

export interface HostOpenDocOptions {
  app: App;
  id: string;
  position?: "right" | "bottom";
  action?: TProtyleAction[];
  keepCursor?: boolean;
  removeCurrentTab?: boolean;
}

export interface HostBridge {
  getEditorModels(): any[];
  openDocTab(options: HostOpenDocOptions): Promise<any>;
  createDialog(options: HostDialogOptions): HostDialogHandle;
  getNotebookName(notebookId: string): string | undefined;
}

export const defaultHostBridge: HostBridge = {
  getEditorModels(): any[] {
    try {
      const models = getAllModels();
      return Array.isArray(models?.editor) ? (models.editor as any[]) : [];
    } catch {
      return [];
    }
  },
  openDocTab(options: HostOpenDocOptions): Promise<any> {
    return Promise.resolve(
      openTab({
        app: options.app,
        doc: {
          id: options.id,
          mode: "wysiwyg",
          ...(options.action ? { action: options.action } : {}),
        },
        ...(options.position ? { position: options.position } : {}),
        ...(options.keepCursor !== undefined ? { keepCursor: options.keepCursor } : {}),
        removeCurrentTab: options.removeCurrentTab ?? false,
      }),
    );
  },
  createDialog(options: HostDialogOptions): HostDialogHandle {
    return new Dialog({
      title: options.title,
      content: options.content,
      width: options.width,
      height: options.height,
      destroyCallback: options.destroyCallback,
    });
  },
  getNotebookName(notebookId: string): string | undefined {
    const notebooks = (globalThis as { siyuan?: { notebooks?: Array<{ id?: string; name?: string }> } }).siyuan?.notebooks;
    if (!Array.isArray(notebooks)) return undefined;
    return notebooks.find(item => item?.id === notebookId)?.name;
  },
};
