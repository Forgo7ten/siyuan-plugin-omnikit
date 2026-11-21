export interface AutoPasteHelpLanguages {
  configGroupBehavior?: unknown;
  pasteURLAutoConvert?: unknown;
}

type Translator = (key: string, values?: Record<string, string | number>) => string;

function nonEmptyString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

/**
 * Resolve settings help text for automatic link titling on paste using SiYuan's
 * runtime language dictionary when available, falling back to static locale copy.
 */
export function resolveAutoPasteHelp(
  t: Translator,
  languages: AutoPasteHelpLanguages | undefined = (globalThis as { siyuan?: { languages?: AutoPasteHelpLanguages } }).siyuan?.languages,
): string {
  const group = nonEmptyString(languages?.configGroupBehavior);
  const setting = nonEmptyString(languages?.pasteURLAutoConvert);
  if (group && setting) {
    return t("feature.titledLink.settings.autoHelpDynamic", { group, setting });
  }
  return t("feature.titledLink.settings.autoHelp");
}
