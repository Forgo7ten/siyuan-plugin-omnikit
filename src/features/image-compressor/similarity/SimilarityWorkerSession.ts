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

/**
 * Manages an inline similarity worker session for one image search.
 * Supports two-stage protocol (initOriginal pyramid caching + evaluate candidate).
 */
export class SimilarityWorkerSession {
  private readonly worker: Worker;
  private readonly pending = new Map<number, PendingRequest>();
  private nextID = 1;
  private disposed = false;
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

  initOriginal(
    original: Blob,
    maxEdge = 512,
    originalDimensions?: { width: number; height: number },
  ): Promise<{ width: number; height: number }> {
    if (this.disposed || this.signal?.aborted) {
      return Promise.reject(
        this.signal?.aborted
          ? toAbortError(this.signal)
          : new DOMException("Similarity worker session closed", "AbortError"),
      );
    }
    const id = this.nextID++;
    return new Promise<{ width: number; height: number }>((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      try {
        const msg: SimilarityWorkerMessage = {
          type: "initOriginal",
          id,
          original,
          maxEdge,
          ...(originalDimensions ? { width: originalDimensions.width, height: originalDimensions.height } : {}),
        };
        this.worker.postMessage(msg);
      } catch (err) {
        this.pending.delete(id);
        reject(err);
      }
    });
  }

  evaluate(candidate: Blob): Promise<number> {
    if (this.disposed || this.signal?.aborted) {
      return Promise.reject(
        this.signal?.aborted
          ? toAbortError(this.signal)
          : new DOMException("Similarity worker session closed", "AbortError"),
      );
    }
    const id = this.nextID++;
    return new Promise<number>((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      try {
        const msg: SimilarityWorkerMessage = { type: "evaluate", id, candidate };
        this.worker.postMessage(msg);
      } catch (err) {
        this.pending.delete(id);
        reject(err);
      }
    });
  }

  dispose(reason: unknown = new DOMException("Similarity worker session closed", "AbortError")): void {
    if (this.disposed) return;
    this.disposed = true;
    this.signal?.removeEventListener("abort", this.abortHandler);
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

    if (response.type === "initOriginal") {
      req.resolve({ width: response.width ?? 0, height: response.height ?? 0 });
      return;
    }

    if (typeof response.similarity !== "number" || !Number.isFinite(response.similarity)) {
      req.reject(new Error("Similarity worker returned an invalid score"));
      return;
    }
    req.resolve(response.similarity);
  }
}
