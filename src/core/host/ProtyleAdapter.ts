/**
 * Pure-function adapters for standard SiYuan Protyle editor contexts and signals.
 */

export interface ProtyleRunner {
  updateTransactionElement(element: Element, oldHTML: string): void | Promise<void>;
}

/**
 * Standard extraction of document root ID from SiYuan editor instances and event details.
 */
export function resolveEditorRootID(context: unknown): string | undefined {
  if (!context || typeof context !== "object") return undefined;
  const target = (context as { detail?: any }).detail ?? context;
  const candidate =
    target?.protyle?.block?.rootID ??
    target?.block?.rootID ??
    target?.data?.rootID ??
    (typeof target?.getInstance === "function" ? target.getInstance()?.block?.rootID : undefined);
  return typeof candidate === "string" && candidate.length > 0 ? candidate : undefined;
}

/**
 * Standard extraction of notebook (box) ID from SiYuan editor instances and event details.
 */
export function resolveNotebookID(context: unknown): string | undefined {
  if (!context || typeof context !== "object") return undefined;
  const target = (context as { detail?: any }).detail ?? context;
  const candidate =
    target?.protyle?.notebookId ??
    target?.protyle?.block?.box ??
    target?.notebookId ??
    target?.block?.box ??
    target?.data?.box ??
    (typeof target?.getInstance === "function" ? target.getInstance()?.notebookId : undefined);
  return typeof candidate === "string" && candidate.length > 0 ? candidate : undefined;
}

/**
 * Standard extraction of Protyle editor element (.protyle) from event details or instances.
 */
export function resolveProtyleElement(context: unknown): HTMLElement | undefined {
  if (!context || typeof context !== "object") return undefined;
  const target = (context as { detail?: any }).detail ?? context;
  const element =
    target?.protyle?.element ??
    target?.element ??
    (typeof target?.getInstance === "function" ? target.getInstance()?.element : undefined);
  if (!element || typeof element !== "object") return undefined;
  if (typeof HTMLElement !== "undefined" && element instanceof HTMLElement) return element;
  if (typeof (element as any).tagName === "string") return element as HTMLElement;
  return undefined;
}

/**
 * Extract a runnable protyle transaction runner from Protyle instances or IProtyle wrappers.
 */
export function resolveProtyleRunner(context: unknown): ProtyleRunner | null {
  if (!context || typeof context !== "object") return null;
  const target = (context as { detail?: any }).detail ?? context;
  if (typeof (target as any).updateTransactionElement === "function") {
    return target as ProtyleRunner;
  }
  if (typeof (target as any).getInstance === "function") {
    const instance = (target as any).getInstance();
    if (typeof instance?.updateTransactionElement === "function") {
      return instance as ProtyleRunner;
    }
  }
  if (typeof (target as any).protyle?.updateTransactionElement === "function") {
    return (target as any).protyle as ProtyleRunner;
  }
  return null;
}

/**
 * Combine multiple abort signals using modern native AbortSignal.any.
 */
export function combineSignals(...signals: (AbortSignal | undefined)[]): AbortSignal | undefined {
  const valid = signals.filter((s): s is AbortSignal => !!s);
  if (valid.length === 0) return undefined;
  if (valid.length === 1) return valid[0];
  if (typeof AbortSignal.any === "function") return AbortSignal.any(valid);
  const controller = new AbortController();
  for (const s of valid) {
    if (s.aborted) {
      controller.abort(s.reason);
      return controller.signal;
    }
    s.addEventListener("abort", () => controller.abort(s.reason), { once: true });
  }
  return controller.signal;
}
