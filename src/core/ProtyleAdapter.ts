/**
 * Lightweight pure-function adapters for SiYuan Protyle editor contexts and signals.
 */

export interface ProtyleRunner {
  updateTransactionElement(element: Element, oldHTML: string): void | Promise<void>;
}

/**
 * Robustly extract document root ID across Protyle instances, event details, and nested editor wrappers.
 */
export function resolveEditorRootID(context: unknown): string | undefined {
  if (!context || typeof context !== "object") return undefined;
  const target = (context as { detail?: any }).detail ?? context;
  const candidate =
    target?.data?.rootID ??
    target?.data?.id ??
    target?.block?.rootID ??
    target?.protyle?.block?.rootID ??
    target?.protyle?.protyle?.block?.rootID ??
    target?.editor?.protyle?.block?.rootID ??
    (typeof target?.getInstance === "function"
      ? target.getInstance()?.block?.rootID ?? target.getInstance()?.protyle?.block?.rootID
      : undefined);
  return typeof candidate === "string" && candidate.length > 0 ? candidate : undefined;
}

/**
 * Robustly extract notebook (box) ID across Protyle instances, event details, and nested editor wrappers.
 */
export function resolveNotebookID(context: unknown): string | undefined {
  if (!context || typeof context !== "object") return undefined;
  const target = (context as { detail?: any }).detail ?? context;
  const candidate =
    target?.notebookId ??
    target?.notebook ??
    target?.data?.box ??
    target?.data?.notebookId ??
    target?.block?.box ??
    target?.protyle?.notebookId ??
    target?.protyle?.block?.box ??
    target?.protyle?.protyle?.notebookId ??
    target?.protyle?.protyle?.block?.box ??
    target?.editor?.protyle?.notebookId ??
    target?.editor?.protyle?.block?.box ??
    (typeof target?.getInstance === "function"
      ? target.getInstance()?.notebookId ?? target.getInstance()?.block?.box
      : undefined);
  return typeof candidate === "string" && candidate.length > 0 ? candidate : undefined;
}

/**
 * Extract a runnable protyle transaction runner from direct Protyle instances, IProtyle wrappers, or nested properties.
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
 * Avoids persistent closure listener leaks on long-lived FeatureScope signals.
 */
export function combineSignals(...signals: (AbortSignal | undefined)[]): AbortSignal | undefined {
  const valid = signals.filter((s): s is AbortSignal => !!s);
  if (valid.length === 0) return undefined;
  if (valid.length === 1) return valid[0];
  return AbortSignal.any(valid);
}
