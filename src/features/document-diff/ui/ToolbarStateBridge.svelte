<script lang="ts">
  import { untrack, type Component } from "svelte";
  import type { ToolbarActions, ToolbarViewState } from "../model/toolbarState.ts";

  interface Props {
    initialState: ToolbarViewState;
    actions: ToolbarActions;
    t: (key: string, values?: Record<string, string | number>) => string;
    ToolbarComponent: Component<{
      getState: () => ToolbarViewState;
      actions: ToolbarActions;
      t: (key: string, values?: Record<string, string | number>) => string;
    }>;
    bindUpdater: (fn: (next: ToolbarViewState) => void) => void;
  }

  let { initialState, actions, t, ToolbarComponent, bindUpdater }: Props = $props();
  let current = $state<ToolbarViewState>(untrack(() => initialState));

  untrack(() => {
    bindUpdater((next: ToolbarViewState) => {
      current = next;
    });
  });
</script>

<ToolbarComponent getState={() => current} {actions} {t} />
