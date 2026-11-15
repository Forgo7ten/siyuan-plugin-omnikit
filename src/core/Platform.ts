export type FrontendKind = "desktop" | "mobile" | "unknown";

export type SiyuanFrontend =
  | "desktop"
  | "desktop-window"
  | "mobile"
  | "browser-desktop"
  | "browser-mobile"
  | "all";

type FrontendResolver = () => string | undefined;

let frontendResolver: FrontendResolver | undefined;

/**
 * @design SiYuan's `getFrontend()` is injected by the plugin entry at load time.
 * @compat This module must stay importable outside the SiYuan runtime (Node regression tests),
 * so it never imports `siyuan` at module scope. Unknown hosts fall back to desktop-class behavior.
 */
export function setFrontendResolver(resolver?: FrontendResolver): void {
  frontendResolver = resolver;
}

export function getCurrentFrontend(): SiyuanFrontend {
  const reported = safeResolve();
  if (
    reported === "desktop" ||
    reported === "desktop-window" ||
    reported === "mobile" ||
    reported === "browser-desktop" ||
    reported === "browser-mobile" ||
    reported === "all"
  ) {
    return reported;
  }
  if (typeof document !== "undefined" && document.body.classList.contains("body--mobile")) return "mobile";
  if (typeof navigator !== "undefined" && /android|iphone|ipad|ipod|mobile/i.test(navigator.userAgent)) return "mobile";
  return "desktop";
}

/**
 * Checks whether the declared platforms support the target frontend.
 * Conforms strictly to SiYuan kernel's `IsTargetSupported` logic:
 * an empty/omitted list permits all frontends.
 */
export function isFrontendSupported(
  declared?: readonly SiyuanFrontend[] | null,
  current?: string,
): boolean {
  if (!declared || declared.length === 0) {
    return true;
  }
  const target = current ?? getCurrentFrontend();
  for (const v of declared) {
    if (v === target || v === "all") {
      return true;
    }
  }
  return false;
}

export function getFrontendKind(frontend?: string): FrontendKind {
  const reported = frontend ?? safeResolve();
  if (reported === "mobile" || reported === "browser-mobile") return "mobile";
  if (reported === "desktop" || reported === "desktop-window" || reported === "browser-desktop") return "desktop";
  // Older builds may not expose getFrontend() to plugin code; the body class and UA remain
  // fallbacks, but a reported browser-desktop value never reaches this branch.
  if (typeof document !== "undefined" && document.body.classList.contains("body--mobile")) return "mobile";
  if (typeof navigator !== "undefined" && /android|iphone|ipad|ipod|mobile/i.test(navigator.userAgent)) return "mobile";
  return "unknown";
}

export function isMobileFrontend(frontend?: string): boolean {
  return getFrontendKind(frontend) === "mobile";
}

/** Treat unknown browser hosts as desktop-class for conservative worker concurrency. */
export function isDesktopFrontend(frontend?: string): boolean {
  return getFrontendKind(frontend) !== "mobile";
}

function safeResolve(): string | undefined {
  try {
    return frontendResolver?.();
  } catch {
    return undefined;
  }
}
