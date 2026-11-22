import {
  precalculateOriginal,
  evaluateMSSSIMWithPrecomputed,
  type PrecomputedOriginal,
} from "./ms-ssim.ts";

export type SimilarityWorkerMessage =
  | { type: "initOriginal"; id: number; original: Blob; maxEdge?: number; width?: number; height?: number }
  | { type: "evaluate"; id: number; candidate: Blob };

export interface SimilarityWorkerResponse {
  id: number;
  type?: "initOriginal" | "evaluate";
  similarity?: number;
  success?: boolean;
  width?: number;
  height?: number;
  error?: string;
}

let cachedOriginal: PrecomputedOriginal | undefined;
let cachedWidth = 0;
let cachedHeight = 0;

const workerScope = (typeof self !== "undefined" ? self : globalThis) as unknown as {
  onmessage: ((event: MessageEvent<SimilarityWorkerMessage>) => void) | null;
  postMessage: (message: SimilarityWorkerResponse) => void;
};

function computeScaledDimensions(srcWidth: number, srcHeight: number, rawMaxEdge?: number): { width: number; height: number } {
  const maxEdge = Math.max(128, Math.min(768, Math.floor(rawMaxEdge ?? 512)));
  const scale = Math.min(1, maxEdge / Math.max(srcWidth, srcHeight));
  return {
    width: Math.max(1, Math.round(srcWidth * scale)),
    height: Math.max(1, Math.round(srcHeight * scale)),
  };
}

workerScope.onmessage = async (event: MessageEvent<SimilarityWorkerMessage>) => {
  const req = event.data;
  try {
    if (req.type === "initOriginal") {
      let originalBitmap: ImageBitmap | undefined;
      try {
        if (req.width && req.height && req.width > 0 && req.height > 0) {
          const target = computeScaledDimensions(req.width, req.height, req.maxEdge);
          cachedWidth = target.width;
          cachedHeight = target.height;
          originalBitmap = await createImageBitmap(req.original, {
            resizeWidth: cachedWidth,
            resizeHeight: cachedHeight,
            resizeQuality: "high",
          });
        } else {
          originalBitmap = await createImageBitmap(req.original);
          const target = computeScaledDimensions(originalBitmap.width, originalBitmap.height, req.maxEdge);
          cachedWidth = target.width;
          cachedHeight = target.height;
        }

        const canvas = new OffscreenCanvas(cachedWidth, cachedHeight);
        const ctx = canvas.getContext("2d", { willReadFrequently: true });
        if (!ctx) throw new Error("OffscreenCanvas 2D context unavailable");
        ctx.imageSmoothingEnabled = true;
        ctx.imageSmoothingQuality = "high";

        ctx.drawImage(originalBitmap, 0, 0, cachedWidth, cachedHeight);
        const pixels = ctx.getImageData(0, 0, cachedWidth, cachedHeight);

        cachedOriginal = precalculateOriginal({
          width: cachedWidth,
          height: cachedHeight,
          data: pixels.data,
        });

        workerScope.postMessage({
          id: req.id,
          type: "initOriginal",
          success: true,
          width: cachedWidth,
          height: cachedHeight,
        });
      } finally {
        originalBitmap?.close();
      }
      return;
    }

    if (req.type === "evaluate") {
      if (!cachedOriginal || cachedWidth <= 0 || cachedHeight <= 0) {
        throw new Error("Worker evaluate called before initOriginal");
      }
      let candidateBitmap: ImageBitmap | undefined;
      try {
        candidateBitmap = await createImageBitmap(req.candidate, {
          resizeWidth: cachedWidth,
          resizeHeight: cachedHeight,
          resizeQuality: "high",
        });
        const canvas = new OffscreenCanvas(cachedWidth, cachedHeight);
        const ctx = canvas.getContext("2d", { willReadFrequently: true });
        if (!ctx) throw new Error("OffscreenCanvas 2D context unavailable");
        ctx.imageSmoothingEnabled = true;
        ctx.imageSmoothingQuality = "high";

        ctx.drawImage(candidateBitmap, 0, 0, cachedWidth, cachedHeight);
        const pixels = ctx.getImageData(0, 0, cachedWidth, cachedHeight);

        const similarity = evaluateMSSSIMWithPrecomputed(cachedOriginal, {
          width: cachedWidth,
          height: cachedHeight,
          data: pixels.data,
        });

        workerScope.postMessage({
          id: req.id,
          type: "evaluate",
          similarity,
        });
      } finally {
        candidateBitmap?.close();
      }
      return;
    }
  } catch (err) {
    workerScope.postMessage({
      id: req.id,
      error: err instanceof Error ? err.message : String(err),
    });
  }
};

export default class SimilarityWorker {}
