let sequence = 0;

/**
 * Generates a unique runtime identifier using timestamp and an in-process counter.
 * Compatible with non-secure HTTP contexts where `crypto.randomUUID()` is unavailable.
 */
export function createRuntimeId(prefix = "omnikit"): string {
  sequence = (sequence + 1) % Number.MAX_SAFE_INTEGER;
  return `${prefix}-${Date.now().toString(36)}-${sequence.toString(36)}`;
}
