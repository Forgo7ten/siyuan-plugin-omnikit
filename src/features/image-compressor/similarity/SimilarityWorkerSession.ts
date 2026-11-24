import SimilarityWorker from "./similarity.worker.ts?worker&inline";
import type { SimilarityWorkerResponse, SimilarityWorkerMessage } from "./similarity.worker.ts";
import { toAbortError } from "../services/image.ts";

interface PendingRequest {
  resolve: (value: any) => void;
  reject: (error: unknown) => void;
}

export type WorkerFactory = (options?: { name?: string }) => Worker;

export interface SimilarityWorkerSessionOptions {
  workerFactory?: WorkerFactory;
  signal?: AbortSignal;
}

export interface InitSessionOptions {
  fullFrameMaxEdge?: number;
  globalMaxEdge?: number;
  patchSize?: number;
  patchCount?: number;
}

export interface InitSessionResult {
  width: number;
  height: number;
  patchCount: number;
}

export interface EncodeAndEvaluateOptions {
  maxAllowedBytes?: number;
  skipEvaluateIfOversize?: boolean;
}

export interface EncodeAndEvaluateResult {
  blob: Blob;
  bytes: number;
  similarity?: number;
}

/**
 * Manages a single-session inline similarity worker for one image search.
 * Decodes and renders the source image once in `initSession`, then runs `encodeAndEvaluate` steps
 * off the same `OffscreenCanvas` so candidate and reference frames are strictly co-aligned.
 */
export class SimilarityWorkerSession {
  private readonly worker: Worker;
  private readonly pending = new Map<number, PendingRequest>();
  private nextID = 1;
  private disposed = false;
  private disposePosted = false;
  private readonly abortHandler: () => void;
  private readonly signal?: AbortSignal;

  constructor(options: SimilarityWorkerSessionOptions = {}) {
    this.signal = options.signal;
    if (this.signal?.aborted) throw toAbortError(this.signal);

    const factory = options.workerFactory ?? ((opts) => new SimilarityWorker(opts));
    this.worker = factory({ name: "OmniKit-MS-SSIM" });

    this.worker.onmessage = (event: MessageEvent<SimilarityWorkerResponse>) => {
      this.handleMessage(event.data);
    };
    this.worker.onerror = (event: ErrorEvent) => {
      this.dispose(new Error(event.message || "Similarity worker error"));
    };
    this.worker.onmessageerror = () => {
      this.dispose(new Error("Similarity worker message could not be decoded"));
    };

    this.abortHandler = () => {
      this.dispose(this.signal ? toAbortError(this.signal) : new DOMException("Operation cancelled", "AbortError"));
    };
    this.signal?.addEventListener("abort", this.abortHandler, { once: true });
  }

  initSession(
    original: Blob,
    targetWidth: number,
    targetHeight: number,
    options: InitSessionOptions = {},
  ): Promise<InitSessionResult> {
    if (this.disposed || this.signal?.aborted) {
      return Promise.reject(
        this.signal?.aborted
          ? toAbortError(this.signal)
          : new DOMException("Similarity worker session closed", "AbortError"),
      );
    }
    const id = this.nextID++;
    return new Promise<InitSessionResult>((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      try {
        const msg: SimilarityWorkerMessage = {
          type: "initSession",
          id,
          original,
          targetWidth,
          targetHeight,
          ...(options.fullFrameMaxEdge !== undefined ? { fullFrameMaxEdge: options.fullFrameMaxEdge } : {}),
          ...(options.globalMaxEdge !== undefined ? { globalMaxEdge: options.globalMaxEdge } : {}),
          ...(options.patchSize !== undefined ? { patchSize: options.patchSize } : {}),
          ...(options.patchCount !== undefined ? { patchCount: options.patchCount } : {}),
        };
        this.worker.postMessage(msg);
      } catch (err) {
        this.pending.delete(id);
        reject(err);
      }
    });
  }

  encodeAndEvaluate(
    quality: number,
    options: EncodeAndEvaluateOptions = {},
  ): Promise<EncodeAndEvaluateResult> {
    if (this.disposed || this.signal?.aborted) {
      return Promise.reject(
        this.signal?.aborted
          ? toAbortError(this.signal)
          : new DOMException("Similarity worker session closed", "AbortError"),
      );
    }
    const id = this.nextID++;
    return new Promise<EncodeAndEvaluateResult>((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      try {
        const msg: SimilarityWorkerMessage = {
          type: "encodeAndEvaluate",
          id,
          quality,
          ...(options.maxAllowedBytes !== undefined ? { maxAllowedBytes: options.maxAllowedBytes } : {}),
          ...(options.skipEvaluateIfOversize !== undefined
            ? { skipEvaluateIfOversize: options.skipEvaluateIfOversize }
            : {}),
        };
        this.worker.postMessage(msg);
      } catch (err) {
        this.pending.delete(id);
        reject(err);
      }
    });
  }

  async close(): Promise<void> {
    if (this.disposed) return;
    if (this.signal?.aborted) {
      this.dispose(toAbortError(this.signal));
      return;
    }
    const id = this.nextID++;
    await new Promise<void>(resolve => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        resolve();
      }, 50);
      (timer as unknown as { unref?: () => void }).unref?.();
      this.pending.set(id, {
        resolve: () => {
          clearTimeout(timer);
          resolve();
        },
        reject: () => {
          clearTimeout(timer);
          resolve();
        },
      });
      try {
        const msg: SimilarityWorkerMessage = { type: "dispose", id };
        this.disposePosted = true;
        this.worker.postMessage(msg);
      } catch {
        clearTimeout(timer);
        this.pending.delete(id);
        resolve();
      }
    });
    this.dispose();
  }

  dispose(reason: unknown = new DOMException("Similarity worker session closed", "AbortError")): void {
    if (this.disposed) return;
    this.disposed = true;
    this.signal?.removeEventListener("abort", this.abortHandler);
    if (!this.disposePosted) {
      try {
        const msg: SimilarityWorkerMessage = { type: "dispose" };
        this.disposePosted = true;
        this.worker.postMessage(msg);
      } catch {
        // ignore postMessage errors on closing worker
      }
    }
    try {
      this.worker.terminate();
    } catch {
      // ignore termination errors
    }
    for (const req of this.pending.values()) {
      req.reject(reason);
    }
    this.pending.clear();
  }

  private handleMessage(response: SimilarityWorkerResponse): void {
    const req = this.pending.get(response.id);
    if (!req) return;
    this.pending.delete(response.id);

    if (typeof response.error === "string") {
      req.reject(new Error(response.error));
      return;
    }

    if (response.type === "dispose") {
      req.resolve(undefined);
      return;
    }

    if (response.type === "initSession") {
      req.resolve({
        width: response.width ?? 0,
        height: response.height ?? 0,
        patchCount: response.patchCount ?? 0,
      });
      return;
    }

    if (response.type === "encodeAndEvaluate") {
      if (!(response.blob instanceof Blob) || typeof response.bytes !== "number" || response.bytes <= 0) {
        req.reject(new Error("Similarity worker returned an invalid WebP candidate"));
        return;
      }
      if (
        response.similarity !== undefined &&
        (!Number.isFinite(response.similarity) || response.similarity < 0 || response.similarity > 1)
      ) {
        req.reject(new Error("Similarity worker returned an invalid score"));
        return;
      }
      req.resolve({
        blob: response.blob,
        bytes: response.bytes,
        ...(response.similarity !== undefined ? { similarity: response.similarity } : {}),
      });
      return;
    }

    req.reject(new Error("Unexpected worker response"));
  }
}
