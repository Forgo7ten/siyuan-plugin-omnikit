/**
 * @design Read strings from the locale dictionary loaded by SiYuan's Plugin runtime.
 * @compat Missing keys fall back to the key itself, which makes a locale-naming mistake visible
 * in the UI instead of silently rendering an empty label.
 */
export function translate(source: Record<string, unknown> | undefined, key: string, values: Record<string, string | number> = {}): string {
  const value = source?.[key];
  if (typeof value !== "string") return key;
  return value.replace(/\$\{([a-zA-Z0-9_]+)\}|\{([a-zA-Z0-9_]+)\}/g, (_match, name1: string | undefined, name2: string | undefined) => {
    const key = name1 ?? name2 ?? "";
    return String(values[key] ?? "");
  });
}
