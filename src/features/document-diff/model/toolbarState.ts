import {
  EMPTY_DIFF_COUNTS,
  type DiffCounts,
  type DiffFilter,
  type DocumentIdentityLabel,
  type SessionStatusKind,
} from "./types.ts";

export type TranslateFn = (key: string, values?: Record<string, string | number>) => string;

export interface ToolbarViewState {
  statusKind: SessionStatusKind;
  statusText: string;
  leftDoc: DocumentIdentityLabel;
  rightDoc: DocumentIdentityLabel;
  counts: DiffCounts;
  filter: DiffFilter;
  cursorIndex: number;
  filteredTotal: number;
  syncEnabled: boolean;
  canSwap: boolean;
  canNavigate: boolean;
}

export interface ToolbarActions {
  onPrev: () => void;
  onNext: () => void;
  onToggleFilter: (filter: DiffFilter) => void;
  onToggleSync: () => void;
  onSwap: () => void;
  onRefresh: () => void;
  onClose: () => void;
}

export interface ToolbarHandle {
  update(state: ToolbarViewState): void;
  dispose(): void;
}

export type ToolbarFactory = (
  initialState: ToolbarViewState,
  actions: ToolbarActions,
  t: TranslateFn,
) => ToolbarHandle;

export interface FormatToolbarStatusParams {
  statusKind: SessionStatusKind;
  errorReason: string;
  counts: DiffCounts;
  filteredTotal: number;
  hasNavigated: boolean;
  cursor: number;
  t: TranslateFn;
}

export function formatToolbarStatusText(params: FormatToolbarStatusParams): string {
  const { statusKind, errorReason, counts, filteredTotal, hasNavigated, cursor, t } = params;
  switch (statusKind) {
    case "comparing":
      return t("diff.status.comparing");
    case "unconfirmed":
      return t("diff.status.unconfirmed");
    case "equal":
      return t("diff.status.equal");
    case "failed":
      return t("diff.status.failed", { reason: errorReason || t("diff.error.unknown") });
    case "unresolved":
      return t("diff.status.unresolved", {
        confirmed: counts.confirmedDiff,
        unresolved: counts.unresolved,
      });
    case "diff":
      return filteredTotal === 0
        ? t("diff.status.filterEmpty")
        : t("diff.status.diff", { current: hasNavigated ? cursor + 1 : 0, total: filteredTotal });
  }
}

export interface BuildToolbarViewStateParams extends FormatToolbarStatusParams {
  pending: boolean;
  leftDoc: DocumentIdentityLabel;
  rightDoc: DocumentIdentityLabel;
  filter: DiffFilter;
  syncEnabled: boolean;
  canSwap: boolean;
}

export function buildToolbarViewState(params: BuildToolbarViewStateParams): ToolbarViewState {
  const {
    statusKind,
    pending,
    leftDoc,
    rightDoc,
    counts,
    filter,
    filteredTotal,
    hasNavigated,
    cursor,
    syncEnabled,
    canSwap,
  } = params;
  const canNavigate =
    !pending &&
    (statusKind === "diff" || statusKind === "unresolved") &&
    filteredTotal > 0;

  return {
    statusKind,
    statusText: formatToolbarStatusText(params),
    leftDoc,
    rightDoc,
    counts: pending || statusKind === "failed" ? { ...EMPTY_DIFF_COUNTS } : counts,
    filter,
    cursorIndex: hasNavigated && filteredTotal > 0 ? cursor + 1 : 0,
    filteredTotal,
    syncEnabled,
    canSwap,
    canNavigate,
  };
}
