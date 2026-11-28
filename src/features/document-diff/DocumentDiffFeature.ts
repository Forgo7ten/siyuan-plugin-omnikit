import type { MenuContext, OmniMenuItem } from "../../core/feedback/MenuRegistry.ts";
import { BaseFeature } from "../../core/framework/BaseFeature.ts";
import type { FeatureContext } from "../../core/framework/FeatureContext.ts";
import type { FeatureScope } from "../../core/framework/FeatureScope.ts";
import { describeError } from "../../core/host/describeError.ts";
import type { KernelClient } from "../../core/host/KernelClient.ts";
import type { SiyuanFrontend } from "../../core/host/Platform.ts";
import { combineSignals } from "../../core/host/ProtyleAdapter.ts";
import type { SettingsManager } from "../../core/store/SettingsManager.ts";
import { translate } from "../../i18n/translate.ts";
import type { HostBridge } from "./host/SiyuanBridge.ts";
import {
  parseConflictTitle,
  resolveOriginalDocument,
  type ConflictManualReasonCode,
} from "./model/conflict.ts";
import type { DocumentDiffConfig } from "./model/settings.ts";
import type { ToolbarFactory } from "./model/toolbarState.ts";
import { DocumentDiffSession } from "./runtime/DocumentDiffSession.ts";
import { KernelSnapshot } from "./runtime/KernelSnapshot.ts";
import { chooseComparisonDocument } from "./runtime/ManualPicker.ts";
import {
  inspectVisiblePair,
  openAndVerifyPair,
  PairLayoutError,
  type PairLayoutErrorCode,
  type VisibleDoc,
} from "./runtime/VisiblePair.ts";
import { classifyWsMainDiffEvent, type ComparableDocRef } from "./runtime/wsMainFilter.ts";

export const DOCUMENT_DIFF_FRONTENDS: readonly SiyuanFrontend[] = [
  "desktop",
  "desktop-window",
  "browser-desktop",
];

export interface DocumentDiffFeatureDeps {
  bridge: HostBridge;
  mountToolbar: ToolbarFactory;
  kernel: KernelClient;
}

interface RecentlyDestroyedPair {
  left: ComparableDocRef;
  right: ComparableDocRef;
  at: number;
}

const DESTROYED_DOC_REMOVAL_WINDOW_MS = 1000;

function extractTitleFromDocTitleMenu(menu: MenuContext): string | undefined {
  const fromDocInfo = menu.detail?.data?.name;
  if (typeof fromDocInfo === "string" && fromDocInfo) return fromDocInfo;
  const fromProtyle = menu.detail?.protyle?.title?.getText?.();
  if (typeof fromProtyle === "string" && fromProtyle) return fromProtyle;
  return undefined;
}

function extractTitleFromSingleDocTreeMenu(menu: MenuContext): string | undefined {
  const detail = menu.detail;
  if (detail?.type !== "doc" || menu.selectedDocumentCount !== 1 || !menu.rootID) {
    return undefined;
  }
  const el = menu.targetElement;
  if (!el) return undefined;
  const rowType = el.getAttribute?.("data-type");
  if (rowType && rowType !== "navigation-file") return undefined;
  if (el.getAttribute?.("aria-disabled") === "true" || el.getAttribute?.("data-spec-too-new") === "true") {
    return undefined;
  }
  const textEl = typeof el.querySelector === "function"
    ? el.querySelector(".b3-list-item__text")
    : null;
  const raw = textEl?.textContent ?? undefined;
  return typeof raw === "string" && raw ? raw : undefined;
}

function extractTwoDocTreeTargets(menu: MenuContext): readonly [string, string] | undefined {
  const detail = menu.detail;
  if (detail?.type !== "docs") return undefined;
  if (!Array.isArray(detail.items) || detail.items.length !== 2) return undefined;
  const ids = menu.selectedDocumentIDs;
  if (!ids || ids.length !== 2) return undefined;
  const [leftID, rightID] = ids;
  if (typeof leftID !== "string" || typeof rightID !== "string" || !leftID || !rightID || leftID === rightID) {
    return undefined;
  }
  if (detail.elements !== undefined) {
    try {
      const elements = Array.from(detail.elements as ArrayLike<HTMLElement>);
      if (elements.length !== 2) return undefined;
      for (const el of elements) {
        const dt = el?.getAttribute?.("data-type");
        if (dt && dt !== "navigation-file") return undefined;
        if (el?.getAttribute?.("aria-disabled") === "true" || el?.getAttribute?.("data-spec-too-new") === "true") {
          return undefined;
        }
      }
    } catch {
      return undefined;
    }
  }
  return [leftID, rightID];
}

export class DocumentDiffFeature extends BaseFeature {
  static readonly ID = "document-diff";
  private readonly kernel: KernelClient;
  private readonly bridge: HostBridge;
  private readonly mountToolbar: ToolbarFactory;
  private session?: DocumentDiffSession;
  private launchAborter?: AbortController;
  private recentlyDestroyedPair?: RecentlyDestroyedPair;

  constructor(
    plugin: FeatureContext["plugin"],
    settings: SettingsManager,
    deps: DocumentDiffFeatureDeps,
  ) {
    super({
      id: DocumentDiffFeature.ID,
      title: translate(plugin.i18n as Record<string, unknown>, "feature.documentDiff.title"),
      description: translate(plugin.i18n as Record<string, unknown>, "feature.documentDiff.description"),
      category: "document",
      icon: "iconScrollHoriz",
      defaultEnabled: true,
      minimumAppVersion: "3.8.4",
      frontends: DOCUMENT_DIFF_FRONTENDS,
    });
    this.kernel = deps.kernel;
    this.bridge = deps.bridge;
    this.mountToolbar = deps.mountToolbar;
    settings.store(DocumentDiffFeature.ID);
  }

  private t(ctx: FeatureContext, key: string, values?: Record<string, string | number>): string {
    return translate(ctx.plugin.i18n as Record<string, unknown>, key, values);
  }

  protected onEnable(ctx: FeatureContext, scope: FeatureScope): void {
    const buildConflictItems = (conflictID: string): OmniMenuItem[] => [
      {
        id: "compare-conflict",
        label: this.t(ctx, "diff.menuCompareOriginal"),
        icon: "iconScrollHoriz",
        run: () => this.launchConflictComparison(conflictID, false, ctx, scope),
      },
      {
        id: "choose-conflict-target",
        label: this.t(ctx, "diff.menuChooseTarget"),
        icon: "iconSearch",
        run: () => this.launchConflictComparison(conflictID, true, ctx, scope),
      },
    ];

    // Entry A1: Conflict document editor title menu
    ctx.menus.contribute(scope, this.meta.id, "doc-title", "conflict-doc-title", menu => {
      if (!menu.rootID) return [];
      const title = extractTitleFromDocTitleMenu(menu);
      if (!title || !parseConflictTitle(title)) return [];
      const lockedID = menu.rootID;
      return buildConflictItems(lockedID);
    });

    // Entry A2 (single conflict doc) + Entry C (exact dual doc selection) in file tree menu
    ctx.menus.contribute(scope, this.meta.id, "doc-tree", "doc-tree-diff", menu => {
      const twoDocs = extractTwoDocTreeTargets(menu);
      if (twoDocs) {
        const lockedPair: readonly [string, string] = [twoDocs[0], twoDocs[1]];
        return [
          {
            id: "compare-two-docs",
            label: this.t(ctx, "diff.menuCompareTwo"),
            icon: "iconScrollHoriz",
            run: () => this.launchPairComparison(lockedPair[0], lockedPair[1], ctx, scope),
          },
        ];
      }

      const singleConflictTitle = extractTitleFromSingleDocTreeMenu(menu);
      if (menu.rootID && singleConflictTitle && parseConflictTitle(singleConflictTitle)) {
        const lockedID = menu.rootID;
        return buildConflictItems(lockedID);
      }
      return [];
    });

    // Entry B: Top-bar menu for currently visible left/right split panes
    ctx.menus.contribute(scope, this.meta.id, "topbar", "compare-visible-split", () => [
      {
        id: "compare-visible-panes",
        label: this.t(ctx, "diff.menuCompareVisible"),
        icon: "iconScrollHoriz",
        run: () => this.launchVisibleSplitComparison(ctx, scope),
      },
    ]);

    // Reconcile `destroy-protyle` racing ahead of `ws-main (removeDoc / removeBox / closeBox)` without timers.
    const bus = ctx.plugin.eventBus;
    const onScopeWsMain = (event: CustomEvent<any>) => {
      const recent = this.recentlyDestroyedPair;
      if (!recent) return;
      if (Date.now() - recent.at > DESTROYED_DOC_REMOVAL_WINDOW_MS) {
        this.recentlyDestroyedPair = undefined;
        return;
      }
      if (classifyWsMainDiffEvent(event.detail, recent.left, recent.right) === "doc-removed") {
        this.recentlyDestroyedPair = undefined;
        ctx.feedback.notify(this.t(ctx, "diff.notice.docRemoved"), "error", { timeout: 4000 });
      }
    };
    bus.on("ws-main" as any, onScopeWsMain);
    scope.own(() => bus.off("ws-main" as any, onScopeWsMain));

    scope.own(() => this.teardownActive());
  }

  protected onDisable(): void {
    this.teardownActive();
  }

  private teardownActive(): void {
    this.recentlyDestroyedPair = undefined;
    this.launchAborter?.abort();
    this.launchAborter = undefined;
    this.session?.dispose();
    this.session = undefined;
  }

  private beginLaunch(scope: FeatureScope): AbortSignal | null {
    if (!scope.active) return null;
    this.launchAborter?.abort();
    const controller = new AbortController();
    this.launchAborter = controller;
    return combineSignals(scope.signal, controller.signal) ?? controller.signal;
  }

  private formatConflictManualReason(ctx: FeatureContext, code: ConflictManualReasonCode): string {
    return this.t(ctx, `diff.conflictReason.${code}`);
  }

  private formatLayoutError(ctx: FeatureContext, error: unknown): string {
    if (error instanceof PairLayoutError) {
      const code: PairLayoutErrorCode = error.code;
      return this.t(ctx, `diff.layoutError.${code}`);
    }
    return describeError(error);
  }

  private async launchVisibleSplitComparison(ctx: FeatureContext, scope: FeatureScope): Promise<void> {
    const signal = this.beginLaunch(scope);
    if (!signal) return;
    const inspected = inspectVisiblePair(this.bridge);
    if (!inspected.ok) {
      ctx.feedback.notify(this.t(ctx, `diff.layoutError.${inspected.code}`), "error", { timeout: 4500 });
      return;
    }
    this.mountSession(inspected.pair[0], inspected.pair[1], undefined, ctx, scope);
  }

  private async launchConflictComparison(
    conflictID: string,
    forceManual: boolean,
    ctx: FeatureContext,
    scope: FeatureScope,
  ): Promise<void> {
    const signal = this.beginLaunch(scope);
    if (!signal) return;

    try {
      const reader = new KernelSnapshot(this.kernel, signal);
      let baseTitle = "";
      let leftID: string | undefined;

      if (!forceManual) {
        const outcome = await resolveOriginalDocument(conflictID, reader);
        if (signal.aborted) return;
        if (outcome.kind === "not-conflict") {
          ctx.feedback.notify(this.t(ctx, "diff.conflictReason.not-conflict"), "error", { timeout: 4500 });
          return;
        }
        if (outcome.kind === "matched") {
          leftID = outcome.originalID;
        } else {
          if (outcome.reasonCode === "conflict-unreadable") {
            ctx.feedback.notify(this.formatConflictManualReason(ctx, outcome.reasonCode), "error", { timeout: 4500 });
            return;
          }
          baseTitle = outcome.baseTitle ?? "";
          ctx.feedback.notify(
            this.formatConflictManualReason(ctx, outcome.reasonCode),
            "info",
            { timeout: 5000 },
          );
        }
      } else {
        let conflictTitle: string;
        try {
          const loc = await reader.location(conflictID);
          conflictTitle = await reader.title(conflictID, loc.notebook);
        } catch {
          if (!signal.aborted && scope.active) {
            ctx.feedback.notify(this.formatConflictManualReason(ctx, "conflict-unreadable"), "error", { timeout: 4500 });
          }
          return;
        }
        if (signal.aborted) return;
        const parsed = parseConflictTitle(conflictTitle);
        if (!parsed) {
          ctx.feedback.notify(this.t(ctx, "diff.conflictReason.not-conflict"), "error", { timeout: 4500 });
          return;
        }
        baseTitle = parsed.baseTitle;
      }

      if (!leftID) {
        const picked = await chooseComparisonDocument({
          kernel: this.kernel,
          bridge: this.bridge,
          signal,
          excludeDocID: conflictID,
          initialQuery: baseTitle,
          t: (key, values) => this.t(ctx, key, values),
        });
        if (!picked || signal.aborted) return;
        leftID = picked.id;
      }

      const pair = await openAndVerifyPair(
        ctx.plugin.app,
        leftID,
        conflictID,
        this.kernel,
        this.bridge,
        signal,
      );
      if (signal.aborted || !scope.active) return;
      this.mountSession(pair[0], pair[1], conflictID, ctx, scope);
    } catch (error) {
      if (signal.aborted || !scope.active) return;
      ctx.feedback.notify(this.formatLayoutError(ctx, error), "error", { timeout: 4500 });
    }
  }

  private async launchPairComparison(
    leftID: string,
    rightID: string,
    ctx: FeatureContext,
    scope: FeatureScope,
  ): Promise<void> {
    const signal = this.beginLaunch(scope);
    if (!signal) return;
    try {
      const pair = await openAndVerifyPair(
        ctx.plugin.app,
        leftID,
        rightID,
        this.kernel,
        this.bridge,
        signal,
      );
      if (signal.aborted || !scope.active) return;
      this.mountSession(pair[0], pair[1], undefined, ctx, scope);
    } catch (error) {
      if (signal.aborted || !scope.active) return;
      ctx.feedback.notify(this.formatLayoutError(ctx, error), "error", { timeout: 4500 });
    }
  }

  private mountSession(
    left: VisibleDoc,
    right: VisibleDoc,
    confirmedConflictID: string | undefined,
    ctx: FeatureContext,
    scope: FeatureScope,
  ): void {
    if (!scope.active) return;
    this.recentlyDestroyedPair = undefined;
    this.session?.dispose();
    const config = ctx.settings.getFeature<DocumentDiffConfig>(this.meta.id);
    const created = new DocumentDiffSession({
      plugin: ctx.plugin,
      kernel: this.kernel,
      bridge: this.bridge,
      logger: ctx.logger,
      left,
      right,
      signal: scope.signal,
      defaultSyncScroll: config.defaultSyncScroll,
      confirmedConflictID,
      mountToolbar: this.mountToolbar,
      notify: (msg, type = "info") => ctx.feedback.notify(msg, type, { timeout: 4000 }),
      t: (key, values) => this.t(ctx, key, values),
      onDestroyedByProtyle: (leftRef, rightRef) => {
        this.recentlyDestroyedPair = { left: leftRef, right: rightRef, at: Date.now() };
      },
      onClosed: () => {
        if (this.session === created) {
          this.session = undefined;
        }
      },
    });
    this.session = created;
  }
}
