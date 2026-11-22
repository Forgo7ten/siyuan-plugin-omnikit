export type KernelOutcome = "not-sent" | "rejected" | "unknown";

export function getKernelOutcome(error: unknown): KernelOutcome | undefined {
  let current: unknown = error;
  const seen = new Set<unknown>();
  while (current && typeof current === "object" && !seen.has(current)) {
    seen.add(current);
    const outcome = (current as { outcome?: unknown }).outcome;
    if (outcome === "not-sent" || outcome === "rejected" || outcome === "unknown") {
      return outcome;
    }
    current = (current as { cause?: unknown }).cause;
  }
  return undefined;
}
