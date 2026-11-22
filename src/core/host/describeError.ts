/**
 * Formats an Error, SiYuan kernel `{ msg, code }` payload, or string into a readable message.
 */
export function describeError(error: unknown): string {
  if (error instanceof Error) {
    return error.message || error.name;
  }
  if (error && typeof error === "object") {
    const { msg, code, message } = error as { msg?: unknown; code?: unknown; message?: unknown };
    if (typeof msg === "string" && msg.trim()) {
      return `${msg}${code == null ? "" : ` (code ${String(code)})`}`;
    }
    if (typeof message === "string" && message.trim()) {
      return `${message}${code == null ? "" : ` (code ${String(code)})`}`;
    }
    if (code != null && (typeof code === "number" || typeof code === "string")) {
      return `Error (code ${String(code)})`;
    }
  }
  return typeof error === "string" && error.trim() ? error : "Unknown error";
}
