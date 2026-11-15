export type LogLevel = "debug" | "info" | "warn" | "error";

/**
 * @design Console-only diagnostics. The plugin never writes click counts, compression counts
 * or session logs into the workspace; exporting a log would be an explicit user action.
 * @invariant One global instance (`Logger.shared`) backs core, features and UI, so the single
 * "debug log" switch in general settings governs every debug line at once.
 * @safety `info` / `warn` / `error` always print; only `debug` is gated, so a failure is never
 * hidden by leaving debug output off.
 */
export class Logger {
  private static sharedInstance: Logger | undefined;
  private debugEnabled = false;
  readonly name: string;

  constructor(name = "OmniKit") { this.name = name; }

  /** Global instance used by the plugin entry; tests may construct isolated loggers. */
  static get shared(): Logger { return (Logger.sharedInstance ??= new Logger()); }

  get isDebugEnabled(): boolean { return this.debugEnabled; }

  /** Applied from `general.debugLog` at load and whenever that switch changes. */
  setDebugEnabled(enabled: boolean): void { this.debugEnabled = enabled === true; }

  debug(message: string, data?: unknown): void {
    if (!this.debugEnabled) return;
    console.debug(`[${this.name}][debug] ${message}`, data ?? "");
  }

  info(message: string, data?: unknown): void { console.info(`[${this.name}][info] ${message}`, data ?? ""); }
  warn(message: string, data?: unknown): void { console.warn(`[${this.name}][warn] ${message}`, data ?? ""); }
  error(message: string, data?: unknown): void { console.error(`[${this.name}][error] ${message}`, data ?? ""); }
}
