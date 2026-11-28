/**
 * Pure-function adapters for standard SiYuan Protyle editor contexts and signals.
 */

export interface ProtyleRunner {
  updateTransactionElement(element: Element, oldHTML: string): void | Promise<void>;
  flushPendingTransactions?: () => Promise<void>;
}

function unwrapDetail(context: unknown): any {
  if (!context || typeof context !== "object") return undefined;
  return (context as { detail?: any }).detail ?? context;
}

function unwrapProtyle(target: any): any {
  return target?.protyle && typeof target.protyle === "object" ? target.protyle : target;
}

function asElement(value: unknown, requiredMethods: readonly string[] = []): HTMLElement | undefined {
  if (!value || typeof value !== "object") return undefined;
  if (typeof HTMLElement !== "undefined") return value instanceof HTMLElement ? value : undefined;
  if (requiredMethods.length === 0) {
    return typeof (value as { tagName?: unknown }).tagName === "string" ? (value as HTMLElement) : undefined;
  }
  return requiredMethods.every(m => typeof (value as Record<string, unknown>)[m] === "function")
    ? (value as HTMLElement)
    : undefined;
}

/**
 * Standard extraction of document root ID from SiYuan editor instances and event details.
 */
export function resolveEditorRootID(context: unknown): string | undefined {
  const target = unwrapDetail(context);
  if (!target) return undefined;
  const inner = unwrapProtyle(target);
  const candidate = inner?.block?.rootID ?? target?.block?.rootID ?? target?.data?.rootID;
  return typeof candidate === "string" && candidate.length > 0 ? candidate : undefined;
}

/**
 * Standard extraction of notebook (box) ID from SiYuan editor instances and event details.
 */
export function resolveNotebookID(context: unknown): string | undefined {
  const target = unwrapDetail(context);
  if (!target) return undefined;
  const inner = unwrapProtyle(target);
  const candidate =
    inner?.notebookId ??
    inner?.block?.box ??
    target?.notebookId ??
    target?.block?.box ??
    target?.data?.box ??
    (typeof target?.items?.[0]?.notebookId === "string" ? target.items[0].notebookId : undefined);
  return typeof candidate === "string" && candidate.length > 0 ? candidate : undefined;
}

/**
 * Standard extraction of Protyle editor element (.protyle) from event details or instances.
 */
export function resolveProtyleElement(context: unknown): HTMLElement | undefined {
  const target = unwrapDetail(context);
  return asElement(unwrapProtyle(target)?.element);
}

/**
 * Standard extraction of Protyle WYSIWYG editable root element from event details or instances.
 */
export function resolveWysiwygElement(context: unknown): HTMLElement | undefined {
  const target = unwrapDetail(context);
  return asElement(unwrapProtyle(target)?.wysiwyg?.element, ["addEventListener", "contains"]);
}

/**
 * Extract a runnable protyle transaction runner from Protyle instances, IProtyle wrappers, or event details.
 */
export function resolveProtyleRunner(context: unknown): ProtyleRunner | null {
  const target = unwrapDetail(context);
  if (!target) return null;
  const inner = target?.protyle && typeof target.protyle === "object" ? target.protyle : undefined;
  const candidates: unknown[] = [
    target,
    typeof target.getInstance === "function" ? target.getInstance() : undefined,
  ];
  if (inner) {
    candidates.push(inner, typeof inner.getInstance === "function" ? inner.getInstance() : undefined);
  }
  for (const c of candidates) {
    if (c && typeof (c as ProtyleRunner).updateTransactionElement === "function") return c as ProtyleRunner;
  }
  return null;
}

/**
 * Safely enumerate open SiYuan editors without failing initialization if the host getter throws.
 */
export function listEditorsSafe(
  getter: (() => unknown[]) | undefined,
  logger?: { warn: (message: string, data?: unknown) => void },
): unknown[] {
  if (typeof getter !== "function") return [];
  try {
    const list = getter();
    return Array.isArray(list) ? list : [];
  } catch (error) {
    logger?.warn("枚举已打开编辑器失败，将依赖后续生命周期事件注册", error);
    return [];
  }
}

/**
 * Checks whether a Protyle editor instance or target block/node is in read-only / locked mode.
 */
export function isProtyleReadOnly(context: unknown, node?: Element | null): boolean {
  const target = unwrapDetail(context);
  const inner = unwrapProtyle(target);
  if (inner?.disabled === true || target?.disabled === true) return true;
  const wysiwyg = inner?.wysiwyg?.element;
  if (
    wysiwyg?.getAttribute?.("data-readonly") === "true" ||
    wysiwyg?.getAttribute?.("contenteditable") === "false"
  ) {
    return true;
  }
  if (node?.closest?.('[custom-sy-readonly="true"]')) return true;
  if (node?.closest?.("[contenteditable]")?.getAttribute?.("contenteditable") === "false") return true;
  return false;
}

/**
 * Flush pending Protyle editor transactions when supported by the host editor instance.
 */
export async function flushProtyleTransactions(context: unknown): Promise<void> {
  const runner = resolveProtyleRunner(context);
  if (typeof runner?.flushPendingTransactions === "function") {
    await runner.flushPendingTransactions();
    return;
  }
  const target = unwrapDetail(context);
  const instance = typeof target?.getInstance === "function" ? target.getInstance() : target;
  if (typeof instance?.flushPendingTransactions === "function") {
    await instance.flushPendingTransactions();
    return;
  }
  const inner = unwrapProtyle(target);
  if (typeof inner?.flushPendingTransactions === "function") {
    await inner.flushPendingTransactions();
  }
}

/**
 * Combine multiple abort signals using modern native AbortSignal.any.
 */
export function combineSignals(...signals: (AbortSignal | undefined)[]): AbortSignal | undefined {
  const valid = signals.filter((s): s is AbortSignal => !!s);
  if (valid.length === 0) return undefined;
  if (valid.length === 1) return valid[0];
  return AbortSignal.any(valid);
}
