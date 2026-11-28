export interface ComparableDocRef {
  readonly id: string;
  readonly notebook: string;
}

export interface KnownBlockLookup {
  has(id: string): boolean;
}

export type WsMainDiffAction = "ignore" | "doc-removed" | "transactions" | "recompute";

function matchesAnyComparedDoc(
  id: unknown,
  left: ComparableDocRef,
  right: ComparableDocRef,
): boolean {
  return typeof id === "string" && (id === left.id || id === right.id);
}

function matchesAnyKnownBlock(
  id: unknown,
  left: ComparableDocRef,
  right: ComparableDocRef,
  leftBlocks?: KnownBlockLookup,
  rightBlocks?: KnownBlockLookup,
): boolean {
  if (typeof id !== "string" || !id) return false;
  if (id === left.id || id === right.id) return true;
  return Boolean(leftBlocks?.has(id) || rightBlocks?.has(id));
}

/**
 * Classifies a SiYuan `ws-main` event payload strictly against the active comparison pair `(left, right)`,
 * preventing unrelated workspace document/notebook broadcasts from triggering snapshot recomputations.
 */
export function classifyWsMainDiffEvent(
  detail: any,
  left: ComparableDocRef,
  right: ComparableDocRef,
  leftBlocks?: KnownBlockLookup,
  rightBlocks?: KnownBlockLookup,
): WsMainDiffAction {
  if (!detail || typeof detail !== "object") return "ignore";
  const cmd: unknown = detail.cmd ?? detail.data?.cmd;
  const data: any = detail.data;

  switch (cmd) {
    case "removeDoc": {
      const ids = data?.ids;
      return Array.isArray(ids) && ids.some(id => matchesAnyComparedDoc(id, left, right))
        ? "doc-removed"
        : "ignore";
    }

    case "removeBox":
    case "closeBox":
    case "unmount": {
      const box = typeof data === "string" ? data : (data?.box ?? data?.id);
      return typeof box === "string" && box.length > 0 && (box === left.notebook || box === right.notebook)
        ? "doc-removed"
        : "ignore";
    }

    case "rename": {
      const docID = typeof data === "string" ? data : data?.id;
      return matchesAnyComparedDoc(docID, left, right) ? "recompute" : "ignore";
    }

    case "reloaddoc": {
      const docID = typeof data === "string" ? data : data?.id;
      return matchesAnyComparedDoc(docID, left, right) ? "recompute" : "ignore";
    }

    case "reload": {
      if (typeof data === "string") {
        return matchesAnyComparedDoc(data, left, right) ? "recompute" : "ignore";
      }
      if (data && typeof data === "object" && typeof data.id === "string") {
        return matchesAnyComparedDoc(data.id, left, right) ? "recompute" : "ignore";
      }
      return "recompute";
    }

    case "syncMergeResult": {
      const removed = data?.removeRootIDs;
      if (Array.isArray(removed) && removed.some(id => matchesAnyComparedDoc(id, left, right))) {
        return "doc-removed";
      }
      const upserted = data?.upsertRootIDs;
      if (Array.isArray(upserted)) {
        return upserted.some(id => matchesAnyComparedDoc(id, left, right)) ? "recompute" : "ignore";
      }
      return "recompute";
    }

    case "transactions": {
      const rootIDs = detail.context?.rootIDs ?? data?.context?.rootIDs;
      if (Array.isArray(rootIDs) && rootIDs.length > 0) {
        return rootIDs.some(id => matchesAnyComparedDoc(id, left, right))
          ? "transactions"
          : "ignore";
      }
      if (!Array.isArray(data)) return "ignore";
      for (const tx of data) {
        if (!tx || typeof tx !== "object") continue;
        if (matchesAnyComparedDoc(tx.rootID, left, right)) return "transactions";
        const ops = Array.isArray(tx.doOperations) ? tx.doOperations : [];
        for (const op of ops) {
          if (!op || typeof op !== "object") continue;
          if (
            matchesAnyKnownBlock(op.id, left, right, leftBlocks, rightBlocks) ||
            matchesAnyKnownBlock(op.parentID, left, right, leftBlocks, rightBlocks) ||
            matchesAnyKnownBlock(op.rootID, left, right, leftBlocks, rightBlocks) ||
            matchesAnyKnownBlock(op.previousID, left, right, leftBlocks, rightBlocks) ||
            matchesAnyKnownBlock(op.nextID, left, right, leftBlocks, rightBlocks)
          ) {
            return "transactions";
          }
        }
      }
      return "ignore";
    }

    default:
      return "ignore";
  }
}
