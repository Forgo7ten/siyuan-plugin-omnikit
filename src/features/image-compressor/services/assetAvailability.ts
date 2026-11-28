import { isAbortError } from "../../../core/feedback/UiFeedback.ts";
import { Logger } from "../../../core/host/Logger.ts";
import type { KernelClient } from "../../../core/host/KernelClient.ts";
import { combineSignals } from "../../../core/host/ProtyleAdapter.ts";
import type { AssetAvailability, CompressionRecord } from "../policy/contracts.ts";
import { trySource } from "../policy/source.ts";
import { isRemoteRecordSource, type ImageCompressionRecordStore } from "../store/ImageCompressionRecordStore.ts";

const GET_FILE_TIMEOUT_MS = 30_000;

function readKernelCode(raw: string): number | undefined {
  try {
    const parsed = JSON.parse(raw) as { code?: unknown } | null;
    return typeof parsed?.code === "number" ? parsed.code : undefined;
  } catch {
    return undefined;
  }
}

export async function verifyOrdinaryAssetViaGetFile(
  kernelPath: string,
  signal?: AbortSignal,
  fetchFn?: typeof fetch,
): Promise<AssetAvailability> {
  const fetcher = fetchFn ?? globalThis.fetch;
  if (typeof fetcher !== "function") return "unknown";
  const timeoutController = new AbortController();
  const timer = setTimeout(() => timeoutController.abort(new Error("getFile timed out")), GET_FILE_TIMEOUT_MS);
  const effectiveSignal = combineSignals(signal, timeoutController.signal) ?? timeoutController.signal;
  try {
    const response = await fetcher("/api/file/getFile", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path: `data/${kernelPath}` }),
      signal: effectiveSignal,
    });
    if (response.status === 200) {
      await response.body?.cancel?.().catch(() => undefined);
      return "present";
    }
    if (response.status === 202) {
      const text = await response.text();
      const code = readKernelCode(text);
      if (code === 404) return "missing-confirmed";
      Logger.shared.debug("getFile 返回 202 但非 404，资源状态降级为 unknown", { kernelPath, code });
      return "unknown";
    }
    await response.body?.cancel?.().catch(() => undefined);
    Logger.shared.debug("getFile 返回非预期状态码，资源状态降级为 unknown", { kernelPath, status: response.status });
    return "unknown";
  } catch (error) {
    if (signal?.aborted || isAbortError(error)) {
      if (signal?.aborted) throw error;
    }
    Logger.shared.debug("getFile 请求异常，资源状态降级为 unknown", { kernelPath, error });
    return "unknown";
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Checks asset availability via `/api/asset/statAsset` while preserving `?box=` parameters.
 * When an ordinary asset (without `?box=`) returns ambiguous `code === 1`, falls back to
 * `/api/file/getFile`: HTTP 200 confirms `"present"`, while HTTP 202 + `code: 404` confirms
 * `"missing-confirmed"`. Encrypted `?box=` assets and all other errors stay `"unknown"`.
 */
export async function checkAssetAvailability(
  kernel: KernelClient,
  path: string,
  signal?: AbortSignal,
  options?: { fetchFn?: typeof fetch; origin?: string },
): Promise<AssetAvailability> {
  let statCodeOne = false;
  try {
    const res = await kernel.post<unknown>("/api/asset/statAsset", { path }, { signal });
    if (res.code === 0) return "present";
    statCodeOne = res.code === 1;
  } catch (error) {
    if (signal?.aborted || isAbortError(error)) throw error;
    statCodeOne = (error as { code?: unknown })?.code === 1;
  }

  if (!statCodeOne) return "unknown";
  const parsed = trySource(path, options?.origin ?? "http://127.0.0.1:6806");
  if (!parsed || parsed.kind !== "asset" || parsed.box) {
    return "unknown";
  }
  return verifyOrdinaryAssetViaGetFile(parsed.kernelPath, signal, options?.fetchFn);
}

/**
 * Reconciles one record's original and latest compressed asset availability.
 * Removes ONLY that single record (via atomic `compareAndRemove`) when either asset
 * is proven `"missing-confirmed"`. Never deletes physical files or cascades across chains.
 */
export async function reconcileRecordPair(
  record: CompressionRecord,
  checkAsset: (path: string, signal?: AbortSignal) => Promise<AssetAvailability>,
  records: Pick<ImageCompressionRecordStore, "compareAndRemove">,
  signal?: AbortSignal,
): Promise<{ original: AssetAvailability; compressed: AssetAvailability; removed: boolean }> {
  if (isRemoteRecordSource(record.originalPath)) {
    const compressed = await checkAsset(record.compressedPath, signal);
    if (signal?.aborted) return { original: "present", compressed, removed: false };
    if (compressed === "missing-confirmed") {
      const removed = await records.compareAndRemove(record.originalPath, record.compressedPath);
      return { original: "present", compressed, removed };
    }
    return { original: "present", compressed, removed: false };
  }
  const [original, compressed] = await Promise.all([
    checkAsset(record.originalPath, signal),
    checkAsset(record.compressedPath, signal),
  ]);
  if (signal?.aborted) return { original, compressed, removed: false };
  if (original === "missing-confirmed" || compressed === "missing-confirmed") {
    const removed = await records.compareAndRemove(record.originalPath, record.compressedPath);
    return { original, compressed, removed };
  }
  return { original, compressed, removed: false };
}
