import { isMobileFrontend } from "../../../core/host/Platform.ts";

export interface SimilarityPolicy {
  maxEvaluations: number;
  benchmarkMaxEdge: number;
  qualityTolerance: number;
  minQuality: number;
  maxQuality: number;
}

/**
 * Returns platform-tailored similarity search policy based on the host frontend.
 * Desktop: up to 7 evaluation rounds for quality convergence.
 * Mobile: up to 5 evaluation rounds to preserve device battery and UI responsiveness.
 * Benchmark maximum edge: uniformly 512px.
 */
export function getSimilarityPolicy(): SimilarityPolicy {
  const mobile = isMobileFrontend();
  return {
    maxEvaluations: mobile ? 5 : 7,
    benchmarkMaxEdge: 512,
    qualityTolerance: 0.01,
    minQuality: 0.1,
    maxQuality: 1.0,
  };
}
