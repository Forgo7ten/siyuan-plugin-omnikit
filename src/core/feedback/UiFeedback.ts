import type { FeatureScope } from "../framework/FeatureScope.ts";
import { describeError } from "../host/describeError.ts";

export type FeedbackType = "info" | "error";

export interface UiFeedbackOptions {
  timeout?: number;
}

export type ShowMessageFn = (message: string, timeout?: number, type?: FeedbackType) => void;

export function isAbortError(error: unknown): boolean {
  if (!error) return false;
  if (typeof error === "object") {
    const err = error as any;
    if (err.name === "AbortError" || err.code === 20 || err.name === "CanceledError") return true;
    if (err.cause && isAbortError(err.cause)) return true;
  }
  return false;
}

/**
 * Platform-wide UI notification & interaction feedback service.
 * Standardizes notice formatting with [OmniKit] prefix, debounces duplicate messages,
 * checks FeatureScope lifecycle before presentation, and silently swallows AbortError.
 */
export class UiFeedback {
  private readonly debounceWindowMs = 300;
  private readonly recentNotices = new Map<string, number>();

  constructor(
    private readonly scope: FeatureScope | undefined,
    private readonly showMessageFn: ShowMessageFn,
    private readonly clipboardFn?: (text: string) => Promise<void>,
  ) {}

  forScope(scope: FeatureScope): UiFeedback {
    return new UiFeedback(scope, this.showMessageFn, this.clipboardFn);
  }

  notify(message: string, type: FeedbackType = "info", options: UiFeedbackOptions = {}): void {
    if (this.scope && !this.scope.active) return;

    const trimmed = message.trim();
    if (!trimmed) return;

    const now = Date.now();
    const lastTime = this.recentNotices.get(trimmed) ?? 0;
    if (now - lastTime < this.debounceWindowMs) {
      return;
    }
    this.recentNotices.set(trimmed, now);

    if (this.recentNotices.size > 50) {
      for (const [k, v] of this.recentNotices) {
        if (now - v > 5000) this.recentNotices.delete(k);
      }
    }

    const formatted = trimmed.startsWith("[OmniKit] ") ? trimmed : `[OmniKit] ${trimmed}`;
    const timeout = options.timeout ?? (type === "error" ? 5000 : 4000);
    try {
      this.showMessageFn(formatted, timeout, type);
    } catch {
      // Safely ignore host display errors
    }
  }

  handleError(error: unknown, fallbackMessage?: string): void {
    if (isAbortError(error)) {
      return;
    }
    this.notify(fallbackMessage || describeError(error), "error");
  }

  async copyable(text: string, notice?: string): Promise<boolean> {
    if (this.scope && !this.scope.active) return false;
    if (!text) return false;

    try {
      if (this.clipboardFn) {
        await this.clipboardFn(text);
      } else if (typeof navigator !== "undefined" && navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(text);
      } else {
        return false;
      }
      if (this.scope && !this.scope.active) return false;
      if (notice) {
        this.notify(notice);
      }
      return true;
    } catch {
      return false;
    }
  }
}
