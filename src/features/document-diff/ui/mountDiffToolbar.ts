import { mount, unmount } from "svelte";
import type {
  ToolbarActions,
  ToolbarFactory,
  ToolbarHandle,
  ToolbarViewState,
} from "../runtime/DocumentDiffSession.ts";
import DiffToolbar from "./DiffToolbar.svelte";
import ToolbarStateHolder from "./ToolbarStateBridge.svelte";

export const mountDiffToolbar: ToolbarFactory = (
  initialState: ToolbarViewState,
  actions: ToolbarActions,
  t: (key: string, values?: Record<string, string | number>) => string,
): ToolbarHandle => {
  const container = document.createElement("div");
  container.className = "omnikit-diff-toolbar-root";
  document.body.append(container);

  let updateState: ((next: ToolbarViewState) => void) | undefined;
  const instance = mount(ToolbarStateHolder, {
    target: container,
    props: {
      initialState,
      actions,
      t,
      ToolbarComponent: DiffToolbar,
      bindUpdater: (fn: (next: ToolbarViewState) => void) => {
        updateState = fn;
      },
    },
  });

  let disposed = false;
  return {
    update(next: ToolbarViewState) {
      if (!disposed) {
        updateState?.(next);
      }
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      void unmount(instance);
      container.remove();
    },
  };
};
