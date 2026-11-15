import {
  precalculateOriginal,
  evaluateMSSSIMWithPrecomputed,
  computeMSSSIM,
  type PrecomputedOriginal,
} from "./ms-ssim.ts";

export type SimilarityWorkerMessage =
  | { type: "initOriginal"; id: number; original: Blob; maxEdge?: number }
  | { type: "evaluate"; id: number; candidate: Blob }
  | { id: number; original: Blob; candidate: Blob; maxEdge?: number };

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

workerScope.onmessage = async (event: MessageEvent<SimilarityWorkerMessage>) => {
  const req = event.data;
  try {
    if ("type" in req && req.type === "initOriginal") {
      let originalBitmap: ImageBitmap | undefined;
      try {
        originalBitmap = await createImageBitmap(req.original);
        const maxEdge = Math.max(128, Math.min(768, Math.floor(req.maxEdge ?? 512)));
        const scale = Math.min(1, maxEdge / Math.max(originalBitmap.width, originalBitmap.height));
        cachedWidth = Math.max(1, Math.round(originalBitmap.width * scale));
        cachedHeight = Math.max(1, Math.round(originalBitmap.height * scale));

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

    if ("type" in req && req.type === "evaluate") {
      if (!cachedOriginal || cachedWidth <= 0 || cachedHeight <= 0) {
        throw new Error("Worker evaluate called before initOriginal");
      }
      let candidateBitmap: ImageBitmap | undefined;
      try {
        candidateBitmap = await createImageBitmap(req.candidate);
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

    // Direct one-off fallback
    let originalBitmap: ImageBitmap | undefined;
    let candidateBitmap: ImageBitmap | undefined;
    try {
      [originalBitmap, candidateBitmap] = await Promise.all([
        createImageBitmap(req.original),
        createImageBitmap(req.candidate),
      ]);
      const maxEdge = Math.max(128, Math.min(768, Math.floor(req.maxEdge ?? 512)));
      const scale = Math.min(1, maxEdge / Math.max(candidateBitmap.width, candidateBitmap.height));
      const width = Math.max(1, Math.round(candidateBitmap.width * scale));
      const height = Math.max(1, Math.round(candidateBitmap.height * scale));

      const canvas = new OffscreenCanvas(width, height);
      const ctx = canvas.getContext("2d", { willReadFrequently: true });
      if (!ctx) throw new Error("OffscreenCanvas 2D context unavailable");
      ctx.imageSmoothingEnabled = true;
      ctx.imageSmoothingQuality = "high";

      ctx.drawImage(originalBitmap, 0, 0, width, height);
      const origPixels = ctx.getImageData(0, 0, width, height);
      ctx.clearRect(0, 0, width, height);
      ctx.drawImage(candidateBitmap, 0, 0, width, height);
      const candPixels = ctx.getImageData(0, 0, width, height);

      const similarity = computeMSSSIM(
        { width, height, data: origPixels.data },
        { width, height, data: candPixels.data },
      );
      workerScope.postMessage({ id: req.id, similarity });
    } finally {
      originalBitmap?.close();
      candidateBitmap?.close();
    }
  } catch (err) {
    workerScope.postMessage({
      id: req.id,
      error: err instanceof Error ? err.message : String(err),
    });
  }
};

export default class SimilarityWorker {}
