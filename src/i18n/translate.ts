/**
 * @design Read strings from the locale dictionary loaded by SiYuan's Plugin runtime.
 * @compat Missing keys fall back to the key itself, which makes a locale-naming mistake visible
 * in the UI instead of silently rendering an empty label.
 */
export function translate(source: Record<string, unknown> | undefined, key: string, values?: Record<string, string | number>): string {
  const value = source?.[key];
  if (typeof value !== "string") return key;
  if (!values || Object.keys(values).length === 0) return value;
  return value.replace(/\$\{([a-zA-Z0-9_]+)\}|\{([a-zA-Z0-9_]+)\}/g, (match, name1: string | undefined, name2: string | undefined) => {
    const placeholder = name1 ?? name2 ?? "";
    if (!Object.hasOwn(values, placeholder)) return match;
    const replacement = values[placeholder];
    // @compat Keep the raw placeholder when a caller forgets an argument: a visible
    // `${count}` is diagnosable, an empty string is not.
    return replacement === undefined ? match : String(replacement);
  });
}
