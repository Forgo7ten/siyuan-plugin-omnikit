import { test } from "node:test";
import assert from "node:assert/strict";
import { ALLOWLIST_SQL_BATCH_SIZE, resolveAllowlistPaths } from "../../../src/features/image-compressor/services/allowlistPaths.ts";

const makeId = n => `20260101000000-${String(n).padStart(7, "a")}`;

test("resolveAllowlistPaths filters invalid IDs, deduplicates, and returns empty without API calls", async () => {
  let calls = 0;
  const kernel = {
    async post() {
      calls++;
      return { code: 0, data: null, msg: "" };
    },
  };
  const result = await resolveAllowlistPaths(kernel, ["not-an-id", "20260101000000-INVALID"]);
  assert.deepEqual(result, {});
  assert.equal(calls, 0);
});

test("resolveAllowlistPaths batches readonly SQL in chunks of 32, calls lsNotebooks once, and formats root vs child paths", async () => {
  const rootDocId = "20260101000000-box0001";
  const ids = [rootDocId, ...Array.from({ length: 34 }, (_, i) => makeId(i)), rootDocId];
  const calls = [];

  const kernel = {
    async post(path, body) {
      calls.push({ path, body });
      if (path === "/api/notebook/lsNotebooks") {
        return {
          code: 0,
          msg: "",
          data: {
            notebooks: [
              null,
              { id: rootDocId, name: "RootNotebook" },
              { id: "box-2", name: "MainBox" },
            ],
          },
        };
      }
      if (path === "/api/query/sql") {
        const matches = [...body.stmt.matchAll(/'(\d{14}-[a-z0-9]{7})'/g)].map(m => m[1]);
        const rows = matches.map(id => {
          if (id === rootDocId) {
            return { id, box: rootDocId, hpath: "/" };
          }
          return { id, box: "box-2", hpath: `/Folder/${id}` };
        });
        return { code: 0, msg: "", data: [null, ...rows], limit: 32, truncated: false };
      }
      throw new Error(`Unexpected path: ${path}`);
    },
  };

  const result = await resolveAllowlistPaths(kernel, ids);
  const lsCalls = calls.filter(c => c.path === "/api/notebook/lsNotebooks");
  const sqlCalls = calls.filter(c => c.path === "/api/query/sql");

  assert.equal(lsCalls.length, 1);
  assert.equal(sqlCalls.length, 2);
  assert.equal(sqlCalls[0].body.mode, "readonly");
  assert.match(sqlCalls[0].body.stmt, new RegExp(`LIMIT ${ALLOWLIST_SQL_BATCH_SIZE}$`));
  assert.equal(sqlCalls[1].body.mode, "readonly");
  assert.match(sqlCalls[1].body.stmt, /LIMIT 3$/);

  assert.equal(result[rootDocId], "RootNotebook");
  assert.equal(result[makeId(0)], `MainBox/Folder/${makeId(0)}`);
  assert.equal(result[makeId(33)], `MainBox/Folder/${makeId(33)}`);
});

test("resolveAllowlistPaths preserves returned rows on truncated SQL, lowers chunk size, and routes remaining IDs to bounded fallback", async () => {
  const ids = Array.from({ length: 5 }, (_, i) => makeId(i));
  const sqlStatements = [];
  const fallbackOrder = [];
  let activeFallbacks = 0;
  let peakFallbacks = 0;

  const kernel = {
    async post(path, body) {
      if (path === "/api/notebook/lsNotebooks") {
        return {
          code: 0,
          msg: "",
          data: { notebooks: [{ id: "box-1", name: "Notes" }] },
        };
      }
      if (path === "/api/query/sql") {
        sqlStatements.push(body.stmt);
        if (sqlStatements.length === 1) {
          return {
            code: 0,
            msg: "",
            limit: 2,
            truncated: true,
            data: [
              { id: ids[0], box: "box-1", hpath: "/Doc0" },
              // missing hpath -> must go to fallback
              { id: ids[1], box: "box-1", hpath: "" },
            ],
          };
        }
        return {
          code: 0,
          msg: "",
          limit: 2,
          truncated: false,
          // ids[3] unindexed / missing, ids[4] belongs to missing/locked notebook
          data: [
            { id: ids[2], box: "box-1", hpath: "/Doc2" },
            { id: ids[4], box: "locked-box", hpath: "/Secret" },
          ],
        };
      }
      throw new Error(`Unexpected path: ${path}`);
    },
  };

  const result = await resolveAllowlistPaths(kernel, ids, {
    batchSize: 3,
    fallbackConcurrency: 2,
    fallbackResolver: async (_k, id) => {
      activeFallbacks++;
      peakFallbacks = Math.max(peakFallbacks, activeFallbacks);
      fallbackOrder.push(id);
      await new Promise(resolve => setTimeout(resolve, 10));
      activeFallbacks--;
      if (id === ids[3]) return id; // unresolved -> rootID
      return `Fallback/${id}`;
    },
  });

  assert.equal(sqlStatements.length, 2);
  assert.match(sqlStatements[0], /LIMIT 3$/);
  assert.match(sqlStatements[1], /LIMIT 2$/);
  assert.equal(result[ids[0]], "Notes/Doc0");
  assert.equal(result[ids[2]], "Notes/Doc2");
  assert.equal(result[ids[1]], `Fallback/${ids[1]}`);
  assert.equal(result[ids[3]], ids[3]);
  assert.equal(result[ids[4]], `Fallback/${ids[4]}`);
  assert.equal(fallbackOrder.length, 3);
  assert.ok(peakFallbacks <= 2);
});

test("resolveAllowlistPaths routes remaining IDs to fallback when SQL or lsNotebooks fails and propagates AbortError", async () => {
  const idA = makeId(1);
  const idB = makeId(2);
  let sqlCalls = 0;

  const kernel = {
    async post(path) {
      if (path === "/api/notebook/lsNotebooks") {
        return { code: 0, msg: "", data: { notebooks: null } };
      }
      sqlCalls++;
      throw new Error("SQL failed");
    },
  };

  const res = await resolveAllowlistPaths(kernel, [idA, idB], {
    fallbackResolver: async (_k, id) => (id === idA ? "Doc A" : Promise.reject(new Error("title fail"))),
  });
  assert.equal(sqlCalls, 0); // skipped SQL when notebooks map is empty
  assert.equal(res[idA], "Doc A");
  assert.equal(res[idB], idB);

  const ac = new AbortController();
  ac.abort();
  await assert.rejects(
    () => resolveAllowlistPaths(kernel, [idA], { signal: ac.signal }),
    err => err?.name === "AbortError",
  );
});
