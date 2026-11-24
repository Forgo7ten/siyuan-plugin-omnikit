import {
  precalculateOriginal,
  evaluateMSSSIMWithPrecomputed,
  type PrecomputedOriginal,
} from "./ms-ssim.ts";
import {
  combineHybridScores,
  computeProxyDimensions,
  selectDetailPatches,
  type PatchRect,
} from "./patch-selector.ts";

export type SimilarityWorkerMessage =
  | {
      type: "initSession";
      id: number;
      original: Blob;
      targetWidth: number;
      targetHeight: number;
      fullFrameMaxEdge?: number;
      globalMaxEdge?: number;
      patchSize?: number;
      patchCount?: number;
    }
  | {
      type: "encodeAndEvaluate";
      id: number;
      quality: number;
      maxAllowedBytes?: number;
      skipEvaluateIfOversize?: boolean;
    }
  | {
      type: "dispose";
      id?: number;
    };

export interface SimilarityWorkerResponse {
  id: number;
  type?: "initSession" | "encodeAndEvaluate" | "dispose";
  success?: boolean;
  width?: number;
  height?: number;
  patchCount?: number;
  blob?: Blob;
  bytes?: number;
  similarity?: number;
  error?: string;
}

let sourceCanvas: OffscreenCanvas | undefined;
let readCanvas: OffscreenCanvas | undefined;
let readCtx: OffscreenCanvasRenderingContext2D | null = null;
let sessionTargetWidth = 0;
let sessionTargetHeight = 0;
let fullPrecomputed: PrecomputedOriginal | undefined;
let globalWidth = 0;
let globalHeight = 0;
let globalPrecomputed: PrecomputedOriginal | undefined;
let detailPatches: Array<{ rect: PatchRect; precomputed: PrecomputedOriginal }> = [];

const workerScope = (typeof self !== "undefined" ? self : globalThis) as unknown as {
  onmessage: ((event: MessageEvent<SimilarityWorkerMessage>) => void) | null;
  postMessage: (message: SimilarityWorkerResponse) => void;
};

function cleanupSession(): void {
  if (sourceCanvas) {
    sourceCanvas.width = 0;
    sourceCanvas.height = 0;
    sourceCanvas = undefined;
  }
  if (readCanvas) {
    readCanvas.width = 0;
    readCanvas.height = 0;
    readCanvas = undefined;
  }
  readCtx = null;
  sessionTargetWidth = 0;
  sessionTargetHeight = 0;
  fullPrecomputed = undefined;
  globalWidth = 0;
  globalHeight = 0;
  globalPrecomputed = undefined;
  detailPatches = [];
}

function readRegion(
  src: CanvasImageSource,
  sx: number,
  sy: number,
  sw: number,
  sh: number,
  dw: number,
  dh: number,
): ImageData {
  if (!readCanvas) {
    readCanvas = new OffscreenCanvas(dw, dh);
    readCtx = readCanvas.getContext("2d", { willReadFrequently: true });
  } else if (readCanvas.width !== dw || readCanvas.height !== dh) {
    readCanvas.width = dw;
    readCanvas.height = dh;
    readCtx = readCanvas.getContext("2d", { willReadFrequently: true });
  }
  if (!readCtx) throw new Error("OffscreenCanvas 2D context unavailable");
  if (typeof readCtx.clearRect === "function") {
    readCtx.clearRect(0, 0, dw, dh);
  }
  readCtx.imageSmoothingEnabled = true;
  readCtx.imageSmoothingQuality = "high";
  readCtx.drawImage(src, sx, sy, sw, sh, 0, 0, dw, dh);
  return readCtx.getImageData(0, 0, dw, dh);
}

workerScope.onmessage = async (event: MessageEvent<SimilarityWorkerMessage>) => {
  const req = event.data;
  try {
    if (req.type === "dispose") {
      cleanupSession();
      if (typeof req.id === "number") {
        workerScope.postMessage({ id: req.id, type: "dispose", success: true });
      }
      return;
    }

    if (req.type === "initSession") {
      cleanupSession();
      const tw = Math.max(1, Math.floor(req.targetWidth));
      const th = Math.max(1, Math.floor(req.targetHeight));
      const fullFrameMaxEdge = req.fullFrameMaxEdge ?? 768;
      const globalMaxEdge = req.globalMaxEdge ?? 512;
      const patchSize = req.patchSize ?? 384;
      const maxPatches = req.patchCount ?? 2;

      let originalBitmap: ImageBitmap | undefined;
      try {
        originalBitmap = await createImageBitmap(req.original);
        const canvas = new OffscreenCanvas(tw, th);
        const sourceCtx = canvas.getContext("2d");
        if (!sourceCtx) throw new Error("OffscreenCanvas 2D context unavailable");
        sourceCtx.imageSmoothingEnabled = true;
        sourceCtx.imageSmoothingQuality = "high";
        sourceCtx.drawImage(originalBitmap, 0, 0, tw, th);
        originalBitmap.close();
        originalBitmap = undefined;

        sourceCanvas = canvas;
        sessionTargetWidth = tw;
        sessionTargetHeight = th;

        if (Math.max(tw, th) <= fullFrameMaxEdge) {
          const fullData = readRegion(canvas, 0, 0, tw, th, tw, th);
          fullPrecomputed = precalculateOriginal({
            width: tw,
            height: th,
            data: fullData.data,
          });
          workerScope.postMessage({
            id: req.id,
            type: "initSession",
            success: true,
            width: tw,
            height: th,
            patchCount: 0,
          });
        } else {
          const gScale = Math.min(1, globalMaxEdge / Math.max(tw, th));
          const gw = Math.max(1, Math.floor(tw * gScale));
          const gh = Math.max(1, Math.floor(th * gScale));
          globalWidth = gw;
          globalHeight = gh;

          const globalData = readRegion(canvas, 0, 0, tw, th, gw, gh);
          globalPrecomputed = precalculateOriginal({
            width: gw,
            height: gh,
            data: globalData.data,
          });

          const proxyDims = computeProxyDimensions(tw, th);
          const proxyFrame =
            proxyDims.width === gw && proxyDims.height === gh
              ? { width: gw, height: gh, data: globalData.data }
              : {
                  width: proxyDims.width,
                  height: proxyDims.height,
                  data: readRegion(canvas, 0, 0, tw, th, proxyDims.width, proxyDims.height).data,
                };

          const rects = selectDetailPatches(proxyFrame, tw, th, {
            fullFrameMaxEdge,
            patchSize,
            maxPatches,
          });

          detailPatches = rects.map(rect => {
            const patchData = readRegion(canvas, rect.x, rect.y, rect.width, rect.height, rect.width, rect.height);
            return {
              rect,
              precomputed: precalculateOriginal({
                width: rect.width,
                height: rect.height,
                data: patchData.data,
              }),
            };
          });

          workerScope.postMessage({
            id: req.id,
            type: "initSession",
            success: true,
            width: tw,
            height: th,
            patchCount: detailPatches.length,
          });
        }
      } catch (err) {
        cleanupSession();
        throw err;
      } finally {
        originalBitmap?.close();
      }
      return;
    }

    if (req.type === "encodeAndEvaluate") {
      if (!sourceCanvas || sessionTargetWidth <= 0 || sessionTargetHeight <= 0) {
        throw new Error("Worker encodeAndEvaluate called before initSession");
      }

      const webpBlob = await sourceCanvas.convertToBlob({
        type: "image/webp",
        quality: req.quality,
      });
      if (!webpBlob || webpBlob.type !== "image/webp" || webpBlob.size <= 0) {
        throw new Error("WebP encoding is not supported by the current host engine");
      }

      if (
        req.skipEvaluateIfOversize &&
        typeof req.maxAllowedBytes === "number" &&
        webpBlob.size > req.maxAllowedBytes
      ) {
        workerScope.postMessage({
          id: req.id,
          type: "encodeAndEvaluate",
          blob: webpBlob,
          bytes: webpBlob.size,
        });
        return;
      }

      let candidateBitmap: ImageBitmap | undefined;
      try {
        candidateBitmap = await createImageBitmap(webpBlob);
        let similarity: number;

        if (fullPrecomputed) {
          const candData = readRegion(
            candidateBitmap,
            0,
            0,
            sessionTargetWidth,
            sessionTargetHeight,
            sessionTargetWidth,
            sessionTargetHeight,
          );
          similarity = evaluateMSSSIMWithPrecomputed(fullPrecomputed, {
            width: sessionTargetWidth,
            height: sessionTargetHeight,
            data: candData.data,
          });
        } else if (globalPrecomputed) {
          const candGlobal = readRegion(
            candidateBitmap,
            0,
            0,
            sessionTargetWidth,
            sessionTargetHeight,
            globalWidth,
            globalHeight,
          );
          const globalScore = evaluateMSSSIMWithPrecomputed(globalPrecomputed, {
            width: globalWidth,
            height: globalHeight,
            data: candGlobal.data,
          });

          const patchScores = detailPatches.map(({ rect, precomputed }) => {
            const candPatch = readRegion(
              candidateBitmap!,
              rect.x,
              rect.y,
              rect.width,
              rect.height,
              rect.width,
              rect.height,
            );
            return evaluateMSSSIMWithPrecomputed(precomputed, {
              width: rect.width,
              height: rect.height,
              data: candPatch.data,
            });
          });

          similarity = combineHybridScores(globalScore, patchScores);
        } else {
          throw new Error("Worker session state is incomplete");
        }

        workerScope.postMessage({
          id: req.id,
          type: "encodeAndEvaluate",
          blob: webpBlob,
          bytes: webpBlob.size,
          similarity,
        });
      } finally {
        candidateBitmap?.close();
      }
      return;
    }
  } catch (err) {
    workerScope.postMessage({
      id: typeof req?.id === "number" ? req.id : -1,
      error: err instanceof Error ? err.message : String(err),
    });
  }
};

export default class SimilarityWorker {}
