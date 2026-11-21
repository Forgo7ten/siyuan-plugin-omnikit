import { isAbortError } from "../../../core/feedback/UiFeedback.ts";
import type { KernelClient } from "../../../core/host/KernelClient.ts";
import type { Logger } from "../../../core/host/Logger.ts";
import { NODE_ID } from "../policy/parseImageConfig.ts";
import { resolveDocumentTitle } from "./documentTitle.ts";

export const ALLOWLIST_SQL_BATCH_SIZE = 32;

export interface AllowlistPathOptions {
  signal?: AbortSignal;
  batchSize?: number;
  fallbackConcurrency?: number;
  logger?: Logger;
  fallbackResolver?: (
    kernel: KernelClient,
    id: string,
    signal?: AbortSignal,
  ) => Promise<string>;
}

interface NotebookItem {
  id?: unknown;
  name?: unknown;
}

interface ListNotebooksData {
  notebooks?: Array<NotebookItem | null> | null;
}

interface AllowlistSqlRow {
  id?: unknown;
  box?: unknown;
  hpath?: unknown;
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw new DOMException("Aborted", "AbortError");
  }
}

async function fetchNotebookNames(
  kernel: KernelClient,
  signal?: AbortSignal,
  logger?: Logger,
): Promise<Map<string, string>> {
  const names = new Map<string, string>();
  try {
    const response = await kernel.post<ListNotebooksData>(
      "/api/notebook/lsNotebooks",
      {},
      signal ? { signal } : undefined,
    );
    const notebooks = response.data?.notebooks;
    if (Array.isArray(notebooks)) {
      for (const notebook of notebooks) {
        if (!notebook || typeof notebook !== "object") continue;
        if (typeof notebook.id === "string" && notebook.id.length > 0
          && typeof notebook.name === "string" && notebook.name.trim().length > 0) {
          names.set(notebook.id, notebook.name.trim());
        }
      }
    }
  } catch (error) {
    if (signal?.aborted || isAbortError(error)) throw error;
    logger?.debug("读取笔记本列表失败，回退单文档标题解析", error);
  }
  return names;
}

function formatSqlRowPath(row: AllowlistSqlRow, notebookNames: Map<string, string>): string | undefined {
  if (typeof row.id !== "string" || typeof row.box !== "string") return undefined;
  const notebookName = notebookNames.get(row.box);
  if (!notebookName) return undefined;
  if (row.id === row.box) {
    return notebookName;
  }
  if (typeof row.hpath !== "string" || row.hpath.length === 0) {
    return undefined;
  }
  return row.hpath.startsWith("/") ? `${notebookName}${row.hpath}` : `${notebookName}/${row.hpath}`;
}

/**
 * Resolves display paths for allowlisted document IDs using batched read-only SQL queries
 * joined with a single `/api/notebook/lsNotebooks` lookup, routing any unresolved IDs
 * (truncated, encrypted/locked, unindexed, or failed) to bounded-concurrency fallback.
 */
export async function resolveAllowlistPaths(
  kernel: KernelClient,
  ids: readonly string[],
  options: AllowlistPathOptions = {},
): Promise<Record<string, string>> {
  const { signal, logger, fallbackResolver } = options;
  throwIfAborted(signal);

  const validIds: string[] = [];
  const seen = new Set<string>();
  for (const id of ids) {
    if (typeof id === "string" && NODE_ID.test(id) && !seen.has(id)) {
      seen.add(id);
      validIds.push(id);
    }
  }
  if (validIds.length === 0) return {};

  const resolved: Record<string, string> = {};
  const pendingSet = new Set<string>(validIds);
  const notebookNames = await fetchNotebookNames(kernel, signal, logger);
  throwIfAborted(signal);

  let chunkSize = Math.max(1, Math.min(ALLOWLIST_SQL_BATCH_SIZE, Math.floor(options.batchSize ?? ALLOWLIST_SQL_BATCH_SIZE)));

  if (notebookNames.size > 0) {
    let offset = 0;
    while (offset < validIds.length) {
      throwIfAborted(signal);
      const batch = validIds.slice(offset, offset + chunkSize);
      offset += batch.length;
      const inClause = batch.map(id => `'${id}'`).join(", ");
      const stmt = `SELECT id, box, hpath FROM blocks WHERE type = 'd' AND id IN (${inClause}) LIMIT ${batch.length}`;

      try {
        const response = await kernel.post<Array<AllowlistSqlRow | null>>(
          "/api/query/sql",
          { stmt, mode: "readonly" },
          signal ? { signal } : undefined,
        );
        throwIfAborted(signal);

        if (response.truncated || typeof response.limit === "number") {
          logger?.debug("白名单批量 SQL 查询响应", {
            batchCount: batch.length,
            limit: response.limit,
            truncated: response.truncated,
          });
        }
        if (response.truncated && typeof response.limit === "number"
          && Number.isSafeInteger(response.limit) && response.limit > 0 && response.limit < chunkSize) {
          chunkSize = response.limit;
        }

        if (Array.isArray(response.data)) {
          for (const row of response.data) {
            if (!row || typeof row !== "object") continue;
            if (typeof row.id !== "string" || !pendingSet.has(row.id)) continue;
            const formatted = formatSqlRowPath(row, notebookNames);
            if (formatted) {
              resolved[row.id] = formatted;
              pendingSet.delete(row.id);
            }
          }
        }
      } catch (error) {
        if (signal?.aborted || isAbortError(error)) throw error;
        logger?.debug("白名单批量 SQL 查询失败，剩余文档回退单文档标题解析", {
          batchCount: batch.length,
          error,
        });
        break;
      }
    }
  }

  const unresolved = [...pendingSet];
  if (unresolved.length > 0) {
    const concurrency = Math.max(1, Math.floor(options.fallbackConcurrency ?? 4));
    let next = 0;
    const worker = async (): Promise<void> => {
      while (next < unresolved.length) {
        throwIfAborted(signal);
        const id = unresolved[next++];
        try {
          const title = fallbackResolver
            ? await fallbackResolver(kernel, id, signal)
            : await resolveDocumentTitle(kernel, id, { signal });
          throwIfAborted(signal);
          resolved[id] = typeof title === "string" && title.trim() ? title.trim() : id;
        } catch (error) {
          if (signal?.aborted || isAbortError(error)) throw error;
          logger?.debug("单文档标题回退解析失败，使用文档 ID 兜底", { id, error });
          resolved[id] = id;
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(concurrency, unresolved.length) }, () => worker()));
  }

  return resolved;
}
