/**
 * Structured error thrown when saving a settings draft detects a concurrent external modification.
 */
export class SettingsConflictError extends Error {
  readonly code = "SETTINGS_CONFLICT" as const;

  constructor(message = "Settings changed elsewhere") {
    super(message);
    this.name = "SettingsConflictError";
  }
}

/** Type guard matching SettingsConflictError instances or compatible coded objects. */
export function isSettingsConflictError(error: unknown): error is SettingsConflictError {
  return (
    error instanceof SettingsConflictError ||
    (typeof error === "object" &&
      error !== null &&
      "code" in error &&
      (error as { code?: unknown }).code === "SETTINGS_CONFLICT")
  );
}
