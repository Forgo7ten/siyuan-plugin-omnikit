/**
 * @compat Version boundaries:
 * - 3.8.4: base Plugin API, Dock/TopBar, menu events, findAssetReferences, before-upload-assets (minimum supported host);
 * - 3.8.7: independent settings window (`settingsWindow` + `body--settings`).
 * Below 3.8.4 the plugin stays disabled.
 */
export class Compatibility {
  readonly version: string;
  constructor() { this.version = String((window as any).siyuan?.config?.system?.kernelVersion ?? "0.0.0"); }
  supportsBeforeUpload(): boolean { return compare(this.version, "3.8.4") >= 0; }
  supportsBase(): boolean { return compare(this.version, "3.8.4") >= 0; }
  supportsSettingsWindow(): boolean { return compare(this.version, "3.8.7") >= 0; }
}
function compare(a: string, b: string): number {
  const x = a.match(/\d+/g)?.map(Number) ?? [], y = b.split(".").map(Number);
  for (let i = 0; i < 3; i++) { const d = (x[i] ?? 0) - (y[i] ?? 0); if (d) return d; }
  return 0;
}
