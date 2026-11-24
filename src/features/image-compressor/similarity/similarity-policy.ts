import { isMobileFrontend } from "../../../core/host/Platform.ts";

export interface SimilarityPolicy {
  maxEvaluations: number;
  fullFrameMaxEdge: number;
  globalMaxEdge: number;
  patchSize: number;
  patchCount: number;
  startQuality: number;
  qualityTolerance: number;
  minQuality: number;
  maxQuality: number;
}

export function getSimilarityPolicy(): SimilarityPolicy {
  const mobile = isMobileFrontend();
  return {
    maxEvaluations: mobile ? 4 : 5,
    fullFrameMaxEdge: 768,
    globalMaxEdge: 512,
    patchSize: 384,
    patchCount: 2,
    startQuality: 0.78,
    qualityTolerance: 0.02,
    minQuality: 0.5,
    maxQuality: 1.0,
  };
}
