import type { Plugin } from "siyuan";

export interface StoreCodec<T> {
  defaults(): T;
  parse(raw: unknown): T;
}
export type StoreListener<T> = (next: Readonly<T>) => void;
const SAVE_TIMEOUT_MS = 30_000;

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
      this.assertCertain();
      await this.readIntoMemory();
    });
  }

  async reload(): Promise<boolean> {
    return this.enqueue(async () => {
      this.assertCertain();
      const before = this.fingerprint;
      // @compat SiYuan loadData falls back to plugin.data on read failure or missing files.
      // Clear that session cache so an external deletion cannot resurrect stale settings.
      // The API still cannot distinguish a missing file from an empty file/read failure.
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
    const operation = this.tail.catch(() => undefined).then(action);
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

  private async readIntoMemory(): Promise<void> {
    try {
      const raw = await this.plugin.loadData(this.file);
      const candidate = raw === "" || raw == null
        ? this.codec.defaults()
        : this.codec.parse(raw);
      const fingerprint = serialize(candidate);
      const changed = fingerprint !== this.fingerprint || !!this.readOnlyReason;
      this.value = candidate;
      this.fingerprint = fingerprint;
      this.readOnlyReason = undefined;
      this.rawToBackup = undefined;
      if (changed) this.emit();
    } catch (error) {
      this.readOnlyReason = `Unable to read/validate settings: ${String(error)}`;
      // @safety Do not overwrite missing/invalid settings on load failures.
      try { this.rawToBackup = await this.plugin.loadData(this.file); }
      catch { this.rawToBackup = undefined; }
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
