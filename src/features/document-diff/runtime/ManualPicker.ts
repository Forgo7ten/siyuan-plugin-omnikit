import type { KernelClient } from "../../../core/host/KernelClient.ts";
import type { HostBridge } from "../host/SiyuanBridge.ts";

export interface PickerSelection {
  id: string;
  title: string;
  notebook: string;
  hPath?: string;
}

interface SearchDocHit {
  path: string;
  box: string;
  title?: string | null;
  name?: string | null;
  hPath?: string | null;
}

export interface ManualPickerOptions {
  kernel: KernelClient;
  bridge: HostBridge;
  signal: AbortSignal;
  excludeDocID?: string;
  initialQuery?: string;
  t: (key: string, values?: Record<string, string | number>) => string;
}

function stripHtmlTags(raw: string): string {
  return raw.replace(/<[^>]*>/g, "");
}

function extractDocIdFromPath(docPath: string): string | undefined {
  const match = /\/(\d{14}-[a-zA-Z0-9]{7})\.sy$/.exec(docPath);
  return match?.[1];
}

/**
 * Opens an explicit user-driven document search picker (permitted to cross folders and notebooks).
 * Never auto-selects the first candidate; resolves to `null` if cancelled or aborted.
 */
export function chooseComparisonDocument(options: ManualPickerOptions): Promise<PickerSelection | null> {
  const { kernel, bridge, signal, excludeDocID, initialQuery = "", t } = options;
  return new Promise(resolve => {
    if (signal.aborted) {
      resolve(null);
      return;
    }

    let completed = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let searchSeq = 0;

    const dialog = bridge.createDialog({
      title: t("diff.picker.title"),
      content: '<div class="b3-dialog__content omnikit-diff-picker"></div>',
      width: "540px",
      height: "460px",
      destroyCallback: () => finish(null, true),
    });

    const host = dialog.element.querySelector<HTMLElement>(".omnikit-diff-picker");
    if (!host) {
      dialog.destroy();
      resolve(null);
      return;
    }
    Object.assign(host.style, {
      display: "flex",
      flexDirection: "column",
      gap: "10px",
      height: "100%",
      boxSizing: "border-box",
    });

    const input = document.createElement("input");
    input.type = "search";
    input.className = "b3-text-field fn__block";
    input.placeholder = t("diff.picker.placeholder");
    input.setAttribute("aria-label", t("diff.picker.placeholder"));
    input.value = initialQuery;

    const statusLine = document.createElement("div");
    statusLine.className = "b3-label__text";

    const list = document.createElement("div");
    list.setAttribute("role", "listbox");
    Object.assign(list.style, {
      flex: "1 1 auto",
      minHeight: "0",
      overflowY: "auto",
      display: "flex",
      flexDirection: "column",
      gap: "4px",
    });

    host.append(input, statusLine, list);

    function finish(selection: PickerSelection | null, fromDestroy = false): void {
      if (completed) return;
      completed = true;
      searchSeq++;
      if (timer !== undefined) clearTimeout(timer);
      input.removeEventListener("input", onInput);
      signal.removeEventListener("abort", onAbort);
      if (!fromDestroy) {
        try {
          dialog.destroy();
        } catch {
          // Ignore host dialog teardown errors.
        }
      }
      resolve(selection);
    }

    const onAbort = () => finish(null);

    const runSearch = async (ticket: number) => {
      const keyword = input.value.trim();
      list.replaceChildren();
      if (keyword.length < 1) {
        statusLine.textContent = t("diff.picker.inputHint");
        return;
      }
      statusLine.textContent = t("diff.picker.searching");
      try {
        const res = await kernel.post<SearchDocHit[]>(
          "/api/filetree/searchDocs",
          { k: keyword },
          { signal },
        );
        if (completed || ticket !== searchSeq) return;
        list.replaceChildren();
        const hits = Array.isArray(res.data) ? res.data.slice(0, 100) : [];
        let renderedCount = 0;

        for (const hit of hits) {
          const id = extractDocIdFromPath(hit.path);
          if (!id || !hit.box || id === excludeDocID) continue;
          renderedCount++;

          const cleanTitle = stripHtmlTags(hit.title || hit.name || id).replace(/\.sy$/i, "") || id;
          const nbName = bridge.getNotebookName(hit.box);
          const readablePath = hit.hPath
            ? (nbName ? `${nbName}${hit.hPath}` : hit.hPath)
            : hit.path;

          const itemBtn = document.createElement("button");
          itemBtn.type = "button";
          itemBtn.className = "b3-list-item b3-button b3-button--outline fn__block";
          Object.assign(itemBtn.style, {
            display: "flex",
            flexDirection: "column",
            alignItems: "flex-start",
            textAlign: "left",
            padding: "6px 10px",
            height: "auto",
          });

          const titleSpan = document.createElement("span");
          titleSpan.style.fontWeight = "500";
          titleSpan.style.color = "var(--b3-theme-on-background)";
          titleSpan.textContent = cleanTitle;

          const pathSpan = document.createElement("span");
          pathSpan.style.fontSize = "12px";
          pathSpan.style.color = "var(--b3-theme-on-surface)";
          pathSpan.textContent = readablePath;

          itemBtn.append(titleSpan, pathSpan);
          itemBtn.addEventListener(
            "click",
            () => finish({ id, title: cleanTitle, notebook: hit.box, hPath: hit.hPath ?? undefined }),
            { once: true },
          );
          list.append(itemBtn);
        }

        statusLine.textContent = renderedCount > 0
          ? t("diff.picker.selectHint", { count: renderedCount })
          : t("diff.picker.empty");
      } catch {
        if (!completed && ticket === searchSeq) {
          statusLine.textContent = t("diff.picker.failed");
        }
      }
    };

    const onInput = () => {
      if (timer !== undefined) clearTimeout(timer);
      const ticket = ++searchSeq;
      timer = setTimeout(() => {
        timer = undefined;
        void runSearch(ticket);
      }, 300);
    };

    input.addEventListener("input", onInput);
    signal.addEventListener("abort", onAbort, { once: true });
    input.focus();

    if (initialQuery.trim().length > 0) {
      void runSearch(++searchSeq);
    } else {
      statusLine.textContent = t("diff.picker.inputHint");
    }
  });
}
