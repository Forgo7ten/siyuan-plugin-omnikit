/** Pure policy; can be exercised in Node without loading the SiYuan runtime. */
export interface AutoPolicyInput {
  featureEnabled: boolean;
  globalEnabled: boolean;
  allowlisted: boolean;
  hostSupportsUpload: boolean;
  rootID?: string;
}

/**
 * @invariant Feature OFF => never auto compress.
 * @invariant Global ON => all editor documents, independent of allowlist.
 * @invariant Global OFF => allowlisted documents only.
 * @safety This governs future image uploads, not a background rewrite of existing assets.
 */
export function shouldAutoCompress(input: AutoPolicyInput): boolean {
  return input.featureEnabled && input.hostSupportsUpload && !!input.rootID &&
    (input.globalEnabled || input.allowlisted);
}
