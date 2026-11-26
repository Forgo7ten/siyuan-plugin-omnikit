import { test } from "node:test";
import assert from "node:assert/strict";
import {
  comparableTitle,
  parentDocPath,
  parseConflictTitle,
  resolveOriginalDocument,
} from "../../../src/features/document-diff/model/conflict.ts";
import {
  defaultDocumentDiffConfig,
  documentDiffSettingsCodec,
  parseDocumentDiffConfig,
} from "../../../src/features/document-diff/model/settings.ts";

test("parseConflictTitle validates suffix placement, calendar dates, leap years, and early years", () => {
  assert.deepEqual(parseConflictTitle("项目计划 (Conflicted 2026-11-15 10:20:30)"), {
    baseTitle: "项目计划",
    timestamp: "2026-11-15 10:20:30",
    suffix: " (Conflicted 2026-11-15 10:20:30)",
  });
  assert.ok(parseConflictTitle("闰年文档 (Conflicted 2024-02-29 23:59:59)"));
  assert.ok(parseConflictTitle("世纪前年份 (Conflicted 0099-01-15 00:00:00)"));

  // Invalid dates, non-ending suffixes, or empty base title must return null
  assert.equal(parseConflictTitle("平年二月 (Conflicted 2023-02-29 12:00:00)"), null);
  assert.equal(parseConflictTitle("非法时间 (Conflicted 2026-11-15 24:00:00)"), null);
  assert.equal(parseConflictTitle(" (Conflicted 2026-11-15 10:20:30)"), null);
  assert.equal(parseConflictTitle("日报 (Conflicted 2026-11-15 10:20:30) 备注"), null);
  assert.equal(parseConflictTitle("普通标题"), null);
});

test("parentDocPath extracts direct parent path and rejects traversal or invalid extensions", () => {
  assert.equal(parentDocPath("/20260101120000-abcdefg.sy"), "/");
  assert.equal(
    parentDocPath("/20260101000000-parent1/20260101120000-abcdefg.sy"),
    "/20260101000000-parent1",
  );
  assert.throws(() => parentDocPath("../20260101120000-abcdefg.sy"));
  assert.throws(() => parentDocPath("/folder/../20260101120000-abcdefg.sy"));
  assert.throws(() => parentDocPath("/folder/not-a-doc.md"));
});

test("resolveOriginalDocument matches unique same-folder sibling including .sy file names and rejects cross-folder or ambiguous cases", async () => {
  const conflictID = "20261115102030-conf001";
  const origID = "20261110090000-orig001";

  const makeGateway = (siblings, overrides = {}) => ({
    async location(id) {
      if (overrides.location) return overrides.location(id);
      if (id === conflictID) return { notebook: "box1", path: "/folderA/20261115102030-conf001.sy" };
      if (id === origID) return { notebook: "box1", path: "/folderA/20261110090000-orig001.sy" };
      return { notebook: "box1", path: `/folderA/${id}.sy` };
    },
    async title(id) {
      if (overrides.title) return overrides.title(id);
      if (id === conflictID) return "周报 (Conflicted 2026-11-15 10:20:30)";
      if (id === origID) return "周报";
      return "其他";
    },
    async siblings() {
      return siblings;
    },
  });

  // 1. Unique sibling whose listDocsByPath `name` carries `.sy` suffix
  const matched = await resolveOriginalDocument(
    conflictID,
    makeGateway([
      { id: conflictID, path: "/folderA/20261115102030-conf001.sy", name: "周报 (Conflicted 2026-11-15 10:20:30).sy" },
      { id: origID, path: "/folderA/20261110090000-orig001.sy", name: "周报.sy" },
    ]),
  );
  assert.deepEqual(matched, {
    kind: "matched",
    originalID: origID,
    conflictID,
    baseTitle: "周报",
  });

  // 2. No candidate in same folder -> manual-required (no-candidate)
  const none = await resolveOriginalDocument(
    conflictID,
    makeGateway([{ id: conflictID, path: "/folderA/20261115102030-conf001.sy", name: "周报.sy" }]),
  );
  assert.equal(none.kind, "manual-required");
  assert.equal(none.reasonCode, "no-candidate");

  // 3. Multiple same-title siblings -> manual-required (multiple-candidates)
  const secondOrig = "20261112090000-orig002";
  const multi = await resolveOriginalDocument(
    conflictID,
    makeGateway(
      [
        { id: origID, path: "/folderA/20261110090000-orig001.sy", name: "周报.sy" },
        { id: secondOrig, path: "/folderA/20261112090000-orig002.sy", name: "周报.sy" },
      ],
      {
        title: id => (id === conflictID ? "周报 (Conflicted 2026-11-15 10:20:30)" : "周报"),
      },
    ),
  );
  assert.equal(multi.kind, "manual-required");
  assert.equal(multi.reasonCode, "multiple-candidates");

  // 4. Nested conflict suffixes -> manual-required (nested-conflict)
  const nested = await resolveOriginalDocument(
    conflictID,
    makeGateway([], {
      title: () => "周报 (Conflicted 2026-11-14 08:00:00) (Conflicted 2026-11-15 10:20:30)",
    }),
  );
  assert.equal(nested.kind, "manual-required");
  assert.equal(nested.reasonCode, "nested-conflict");

  // 5. Truncated listing -> manual-required (truncated)
  const truncated = await resolveOriginalDocument(
    conflictID,
    makeGateway(
      [
        { id: origID, path: "/folderA/20261110090000-orig001.sy", name: "周报.sy" },
        { id: conflictID, path: "/folderA/20261115102030-conf001.sy", name: "周报.sy" },
      ],
    ),
    2,
  );
  assert.equal(truncated.kind, "manual-required");
  assert.equal(truncated.reasonCode, "truncated");

  // 6. TOCTOU rename mid-flight -> manual-required (moved-during-lookup)
  let conflictTitleReads = 0;
  const moved = await resolveOriginalDocument(
    conflictID,
    makeGateway(
      [{ id: origID, path: "/folderA/20261110090000-orig001.sy", name: "周报.sy" }],
      {
        title: id => {
          if (id === conflictID) {
            conflictTitleReads++;
            return conflictTitleReads === 1
              ? "周报 (Conflicted 2026-11-15 10:20:30)"
              : "已改名 (Conflicted 2026-11-15 10:20:30)";
          }
          return "周报";
        },
      },
    ),
  );
  assert.equal(moved.kind, "manual-required");
  assert.equal(moved.reasonCode, "moved-during-lookup");
});

test("comparableTitle exempts suffix strictly by confirmedConflictID regardless of visual side", () => {
  const conflictID = "20261115102030-conf001";
  const otherID = "20261110090000-orig001";
  const raw = "周报 (Conflicted 2026-11-15 10:20:30)";

  assert.equal(comparableTitle(conflictID, raw, conflictID), "周报");
  assert.equal(comparableTitle(otherID, raw, conflictID), raw);
  assert.equal(comparableTitle(conflictID, raw, undefined), raw);
});

test("documentDiffSettingsCodec parses valid settings and rejects malformed schemas", () => {
  assert.deepEqual(defaultDocumentDiffConfig(), { defaultSyncScroll: true });
  assert.deepEqual(documentDiffSettingsCodec.parse({}), { defaultSyncScroll: true });
  assert.deepEqual(parseDocumentDiffConfig({ defaultSyncScroll: false }), { defaultSyncScroll: false });

  assert.throws(() => parseDocumentDiffConfig(null));
  assert.throws(() => parseDocumentDiffConfig([]));
  assert.throws(() => parseDocumentDiffConfig({ defaultSyncScroll: "yes" }));
});
