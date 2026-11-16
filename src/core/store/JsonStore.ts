import type { Plugin } from "siyuan";

export interface StoreCodec<T> {
  defaults(): T;
  parse(raw: unknown): T;
}
export type StoreListener<T> = (next: Readonly<T>) => void;
const SAVE_TIMEOUT_MS = 30_000;
const READ_TIMEOUT_MS = 30_000;

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}
function serialize(value: unknown): string {
  return JSON.stringify(value);
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
  private writeUncertain = false;
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
  get readOnly(): boolean { return !!this.readOnlyReason; }
  get isReadOnly(): boolean { return !!this.readOnlyReason; }
  get error(): string | undefined { return this.readOnlyReason; }
  snapshot(): T { return clone(this.value); }

  subscribe(listener: StoreListener<T>): () => void {
    this.listeners.add(listener);
    listener(this.snapshot());
    return () => this.listeners.delete(listener);
  }

  async load(): Promise<void> {
    return this.enqueue(async () => {
      this.assertCertain();
      await this.readIntoMemory();
    });
  }

  async reload(): Promise<boolean> {
    return this.enqueue(async () => {
      this.assertCertain();
      const before = this.fingerprint;
      if (this.plugin.data && typeof this.plugin.data === "object") {
        delete this.plugin.data[this.file];
      }
      await this.readIntoMemory();
      return before !== this.fingerprint;
    });
  }

  async update(mutator: (draft: T) => void): Promise<boolean> {
    return this.enqueue(async () => {
      this.assertCertain();
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
      this.assertCertain();
      if (!this.readOnlyReason) return;
      if (this.rawToBackup === undefined) {
        throw new Error(`Cannot back up unreadable ${this.file}; do not overwrite it`);
      }
      const next = this.codec.parse(this.codec.defaults());
      const backupName = this.file.replace(/\.json$/, `.backup-${Date.now()}.json`);
      await this.saveConfirmed(backupName, this.rawToBackup, "back up");
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

  private assertCertain(): void {
    if (this.writeUncertain) {
      throw new Error(`${this.file} has an unconfirmed write; reload the plugin before retrying`);
    }
  }

  private async saveConfirmed(path: string, data: unknown, action: string): Promise<void> {
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const timeoutError = new Error("timeout");
    const save = this.plugin.saveData(path, data);
    try {
      const response = await Promise.race([
        save,
        new Promise<never>((_, reject) => {
          timeout = setTimeout(() => reject(timeoutError), SAVE_TIMEOUT_MS);
        }),
      ]);
      if (response && typeof response === "object" && "code" in response &&
          (response as {code: number}).code !== 0) {
        throw new Error(`Save failed to ${action} ${this.file}`);
      }
    } catch (error) {
      if (error === timeoutError) {
        this.writeUncertain = true;
        this.readOnlyReason = `Write outcome is unconfirmed for ${this.file}`;
        this.emit();
        throw new Error(`Save timed out while trying to ${action} ${this.file}; outcome is unconfirmed`);
      }
      throw error;
    } finally {
      if (timeout !== undefined) clearTimeout(timeout);
    }
  }

  private getStoragePath(): string {
    const pluginName = this.plugin.name || "siyuan-plugin-omnikit";
    return `/data/storage/petal/${pluginName}/${this.file}`;
  }

  private async fetchStorageFile(path: string, timeoutMs: number): Promise<Response> {
    const fetcher = this.fetchFn || globalThis.fetch;
    if (typeof fetcher !== "function") {
      throw new Error("No fetch implementation available");
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new Error("Storage read timed out")), timeoutMs);
    try {
      return await fetcher("/api/file/getFile", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ path }),
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timer);
    }
  }

  private async readIntoMemory(): Promise<void> {
    let raw: unknown;
    const storagePath = this.getStoragePath();
    let isMissing = false;

    try {
      const res = await this.fetchStorageFile(storagePath, READ_TIMEOUT_MS);
      if (res.status === 202) {
        const body = await res.json().catch(() => null);
        if (body && typeof body === "object" && (body as { code?: number }).code === 404) {
          isMissing = true;
        } else {
          const code = (body as { code?: number })?.code ?? 202;
          const msg = (body as { msg?: string })?.msg ?? "getFile returned 202 error";
          throw new Error(`Kernel getFile failed: ${code} ${msg}`);
        }
      } else if (res.status === 404) {
        isMissing = true;
      } else if (!res.ok) {
        throw new Error(`Server error reading ${this.file}: HTTP ${res.status}`);
      } else {
        const text = await res.text();
        if (!text || text.trim() === "") {
          isMissing = true;
        } else {
          try {
            raw = JSON.parse(text);
          } catch (jsonErr) {
            this.rawToBackup = text;
            this.readOnlyReason = `Invalid JSON syntax in ${this.file}: ${String(jsonErr)}`;
            this.emit();
            return;
          }
        }
      }
    } catch (ioError) {
      if (
        !this.fetchFn &&
        (ioError instanceof TypeError || (ioError as Error)?.message?.includes("Invalid URL")) &&
        typeof (this.plugin as any).loadData === "function"
      ) {
        const legacy = await this.plugin.loadData(this.file);
        if (legacy === "" || legacy == null) {
          isMissing = true;
        } else {
          raw = legacy;
        }
      } else {
        this.readOnlyReason = `Unable to read settings: ${String(ioError)}`;
        this.emit();
        throw ioError;
      }
    }

    try {
      const candidate = isMissing ? this.codec.defaults() : this.codec.parse(raw);
      const fingerprint = serialize(candidate);
      const changed = fingerprint !== this.fingerprint || !!this.readOnlyReason;
      this.value = candidate;
      this.fingerprint = fingerprint;
      this.readOnlyReason = undefined;
      this.rawToBackup = undefined;
      if (changed) this.emit();
    } catch (parseError) {
      this.rawToBackup = raw;
      this.readOnlyReason = `Unable to validate settings: ${String(parseError)}`;
      this.emit();
    }
  }

  private emit(): void {
    for (const listener of [...this.listeners]) {
      try { listener(this.snapshot()); }
      catch (error) { console.error("[OmniKit][error] 设置监听器执行失败", error); }
    }
  }
}
