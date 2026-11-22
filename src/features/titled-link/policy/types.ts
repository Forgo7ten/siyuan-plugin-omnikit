export const DEFAULT_MAX_TITLE_LENGTH = 80;

export type LinkActionResult =
  | "updated"
  | "unchanged"
  | "conflict"
  | "failed"
  | "unknown"
  | "aborted"
  | "superseded"
  | "ime-timeout";

export interface TitledLinkConfig {
  schemaVersion: 1;
  auto: {
    enabled: boolean;
  };
  replaceTitle: boolean;
  fallbackToHostname: boolean;
}

export interface TitledLinkProtyle {
  updateTransactionElement(element: Element, oldHTML: string): void | Promise<void>;
}

/**
 * A single link occurrence captured before asynchronous title resolution begins.
 * Stable block identity and ordinal/value snapshots prevent URL-wide replacement.
 */
export interface LinkOccurrenceTarget {
  readonly protyle?: TitledLinkProtyle | null;
  readonly notebook: string;
  readonly rootID: string;
  readonly blockID: string;
  readonly ordinal: number;
  readonly linkElement: HTMLElement;
  readonly blockElement: HTMLElement;
  readonly originalHref: string;
  readonly originalText: string;
  readonly originalTitle: string | null;
  readonly originalBlockHTML?: string;
}

export type TitleFetchSource =
  | "static-file"
  | "title"
  | "og:title"
  | "twitter:title"
  | "hostname";

export type TitleFetchFailureReason =
  | "network"
  | "timeout"
  | "http"
  | "missing-title"
  | "challenge"
  | "aborted";

export type TitleFetchResult =
  | {
      readonly status: "success";
      readonly url: string;
      readonly title: string;
      readonly source: TitleFetchSource;
      readonly fallback: boolean;
    }
  | {
      readonly status: "failure";
      readonly url: string;
      readonly reason: TitleFetchFailureReason;
      readonly httpStatus?: number;
      readonly error?: unknown;
    };

