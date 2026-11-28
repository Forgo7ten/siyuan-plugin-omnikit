import type { Plugin } from "siyuan";
import { Logger } from "../host/Logger.ts";

export interface StoreCodec<T> {
  defaults(): T;
  parse(raw: unknown): T;
}
export type StoreListener<T> = (next: Readonly<T>) => void;
const READ_TIMEOUT_MS = 30_000;
const SAVE_TIMEOUT_MS = 30_000;

async function withTimeout<R>(operation: Promise<R>, timeoutMs: number, message: string): Promise<R> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(message)), timeoutMs);
  });
  try {
    return await Promise.race([operation, timeout]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}
function serialize(value: unknown): string {
  return JSON.stringify(value);
}

/** Minimal shape the store needs; avoids re-wrapping the host Response. */
interface StorageResponse {
  status: number;
  ok: boolean;
  body: string;
}

function readKernelBody(text: string): { code?: number; msg?: string } | null {
  try {
    const value: unknown = JSON.parse(text);
    return value && typeof value === "object" ? (value as { code?: number; msg?: string }) : null;
  } catch {
    return null;
  }
}

/**
 * @design Every JSON document has its own queue and schema; features never share a
 * giant mutable settings object. Core switches and feature options are independent.
 * @invariant Missing files use defaults in RAM. load/reload/open UI do not save.
 * @safety Corrupt/unreadable files are read-only until explicit backup + recovery.
 */
export class JsonStore<T> {
  private value: T;
  private fingerprint: string;
  private tail: Promise<void> = Promise.resolve();
  private listeners = new Set<StoreListener<T>>();
  private rawToBackup: unknown;
  private readOnlyReason?: string;
  private recoveryPromise?: Promise<void>;

  constructor(
    private readonly plugin: Plugin,
    readonly file: string,
    private readonly codec: StoreCodec<T>,
    private readonly fetchFn?: typeof fetch,
  ) {
    if (!/^(omnikit-core|feature-[a-z0-9-]+)\.json$/.test(file)) {
      throw new Error(`Unsafe OmniKit storage filename: ${file}`);
    }
    this.value = codec.defaults();
    this.fingerprint = serialize(this.value);
  }

  get needsRecovery(): boolean { return !!this.readOnlyReason; }
  get error(): string | undefined { return this.readOnlyReason; }
  snapshot(): T { return clone(this.value); }

  subscribe(listener: StoreListener<T>): () => void {
    this.listeners.add(listener);
    listener(this.snapshot());
    return () => this.listeners.delete(listener);
  }

  async load(): Promise<void> {
    return this.enqueue(async () => {
      await this.readIntoMemory();
    });
  }

  async reload(): Promise<boolean> {
    return this.enqueue(async () => {
      const beforeFingerprint = this.fingerprint;
      const beforeReadOnlyReason = this.readOnlyReason;
      await this.readIntoMemory();
      return beforeFingerprint !== this.fingerprint || beforeReadOnlyReason !== this.readOnlyReason;
    });
  }

  async update(mutator: (draft: T) => void): Promise<boolean> {
    return this.enqueue(async () => {
      if (this.readOnlyReason) {
        throw new Error(`${this.file} is read-only: ${this.readOnlyReason}`);
      }
      // @invariant Clone inside the queue, never from an out-of-date external draft.
      const draft = this.snapshot();
      mutator(draft);
      const next = this.codec.parse(draft);
      const serialized = serialize(next);
      if (serialized === this.fingerprint) return false;

      await this.saveConfirmed(this.file, next, "save");
      this.value = next;
      this.fingerprint = serialized;
      this.emit();
      return true;
    });
  }

  async recoverWithBackup(): Promise<void> {
    if (this.recoveryPromise) return this.recoveryPromise;
    const operation = this.enqueue(async () => {
      if (!this.readOnlyReason) return;
      if (this.rawToBackup === undefined) {
        throw new Error(`Cannot back up unreadable ${this.file}; do not overwrite it`);
      }
      const next = this.codec.parse(this.codec.defaults());
      const hasNonEmptyBackup = typeof this.rawToBackup !== "string" || this.rawToBackup.trim().length > 0;
      if (hasNonEmptyBackup) {
        const backupName = this.file.replace(/\.json$/, `.backup-${Date.now()}.json`);
        await this.saveConfirmed(backupName, this.rawToBackup, "back up");
      }
      await this.saveConfirmed(this.file, next, "save");
      this.value = next;
      this.fingerprint = serialize(next);
      this.readOnlyReason = undefined;
      this.rawToBackup = undefined;
      this.emit();
    });
    this.recoveryPromise = operation;
    try { await operation; }
    finally { this.recoveryPromise = undefined; }
  }

  private enqueue<R>(action: () => Promise<R>): Promise<R> {
    const run = async () => action();
    const operation = this.tail.catch(() => undefined).then(run);
    this.tail = operation.then(() => undefined, () => undefined);
    return operation;
  }

  private async saveConfirmed(path: string, data: unknown, action: string): Promise<void> {
    const response = await withTimeout(
      Promise.resolve(this.plugin.saveData(path, data)),
      SAVE_TIMEOUT_MS,
      `Storage save timed out to ${action} ${this.file}`,
    );
    if (
      response &&
      typeof response === "object" &&
      "code" in response &&
      (response as { code: number }).code !== 0
    ) {
      throw new Error(`Save failed to ${action} ${this.file}`);
    }
  }

  private getStoragePath(): string {
    const pluginName = this.plugin.name || "siyuan-plugin-omnikit";
    return `/data/storage/petal/${pluginName}/${this.file}`;
  }

  private async fetchStorageFile(path: string, timeoutMs: number): Promise<StorageResponse> {
    const fetcher = this.fetchFn ?? globalThis.fetch;
    if (typeof fetcher !== "function") {
      throw new Error("No fetch implementation available");
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new Error("Storage read timed out")), timeoutMs);
    try {
      const response = await fetcher("/api/file/getFile", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ path }),
        signal: controller.signal,
      });
      // @safety The deadline must cover the body, not only the response headers:
      // a stalled body would otherwise hold the per-file queue (and plugin
      // initialization) forever. Return a plain object instead of new Response()
      // to avoid RangeError on 204/205/304 and header re-encoding mismatches.
      const body = await new Promise<string>((resolve, reject) => {
        if (controller.signal.aborted) {
          reject(controller.signal.reason ?? new Error("Storage read timed out"));
          return;
        }
        const onAbort = () => {
          reject(controller.signal.reason ?? new Error("Storage read timed out"));
        };
        controller.signal.addEventListener("abort", onAbort, { once: true });
        response.text().then(
          text => {
            controller.signal.removeEventListener("abort", onAbort);
            resolve(text);
          },
          error => {
            controller.signal.removeEventListener("abort", onAbort);
            reject(error);
          },
        );
      });
      return { status: response.status, ok: response.ok, body };
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * @safety Strictly reads via /api/file/getFile; a transport failure is NEVER "file missing".
   */
  private async readIntoMemory(): Promise<void> {
    let raw: unknown;
    const storagePath = this.getStoragePath();
    let isMissing = false;

    try {
      const res = await this.fetchStorageFile(storagePath, READ_TIMEOUT_MS);
      if (res.status === 202) {
        const body = readKernelBody(res.body);
        if (body?.code === 404) {
          isMissing = true;
        } else {
          throw new Error(
            `Kernel getFile failed: ${body?.code ?? 202} ${body?.msg ?? "getFile returned 202 error"}`,
          );
        }
      } else if (!res.ok) {
        // Only the kernel's documented 202 + code 404 means "missing".
        // A bare HTTP 404 is a proxy/static-host fault, not an empty file.
        throw new Error(`Server error reading ${this.file}: HTTP ${res.status}`);
      } else if (!res.body.trim()) {
        // HTTP 200 with empty/whitespace body is corrupt, never missing.
        this.enterReadOnly(`Corrupt empty storage file in ${this.file}`, res.body);
        return;
      } else {
        try {
          raw = JSON.parse(res.body);
        } catch (jsonErr) {
          this.enterReadOnly(`Invalid JSON syntax in ${this.file}: ${String(jsonErr)}`, res.body);
          return;
        }
      }
    } catch (ioError) {
      this.enterReadOnly(`Unable to read settings: ${String(ioError)}`, undefined);
      throw ioError;
    }

    try {
      const candidate = isMissing ? this.codec.defaults() : this.codec.parse(raw);
      if (isMissing) {
        Logger.shared.debug("配置文件不存在，使用内存默认值", { file: this.file });
      }
      const fingerprint = serialize(candidate);
      const changed = fingerprint !== this.fingerprint || !!this.readOnlyReason;
      this.value = candidate;
      this.fingerprint = fingerprint;
      this.readOnlyReason = undefined;
      this.rawToBackup = undefined;
      if (changed) this.emit();
    } catch (parseError) {
      this.enterReadOnly(`Unable to validate settings: ${String(parseError)}`, raw);
    }
  }

  private enterReadOnly(reason: string, backup?: unknown): void {
    Logger.shared.debug("配置存储进入只读保护模式", {
      file: this.file,
      reason,
      hasBackup: backup !== undefined,
    });
    // Unconditionally replace rawToBackup so a prior corrupt snapshot cannot survive a later read failure.
    this.rawToBackup = backup;
    this.readOnlyReason = reason;
    this.emit();
  }

  private emit(): void {
    if (this.listeners.size === 0) return;
    const snapshot = this.snapshot();
    for (const listener of [...this.listeners]) {
      try { listener(snapshot); }
      catch (error) { Logger.shared.error("设置监听器执行失败", error); }
    }
  }
}
