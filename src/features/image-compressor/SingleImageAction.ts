import type { FeatureContext } from "../../core/FeatureContext.ts";
import type { FeatureScope } from "../../core/FeatureScope.ts";
import { translate } from "../../i18n/translate.ts";
import { prepareImage, type ImageProcessingServices } from "./ImageProcessingServices.ts";
import { NODE_ID, type Intent } from "./parseImageConfig.ts";
import { resolveSource, imageSourceAttribute } from "./source.ts";
import { sqlLiteral, type DocumentRow, type ReferencePlan } from "./references.ts";
import { scanDOM } from "./dom.ts";
import { digest } from "./assets.ts";

export interface SingleImageEditorContext {
  rootID: string;
  notebook: string;
  disabled?: boolean;
}

/** Compresses the source selected in this editor; document references are changed only after preflight. */
export async function compressSelectedImage(
  menuDetail: unknown,
  context: FeatureContext,
  scope: FeatureScope,
  editor: SingleImageEditorContext,
  services: ImageProcessingServices,
  providedFile?: File,
): Promise<void> {
  const image = findTargetImage(menuDetail);
  const blockID = image?.closest("[data-node-id]")?.getAttribute("data-node-id");
  const config = services.config();
  if (!scope.active || !image || !blockID || !NODE_ID.test(blockID) || !NODE_ID.test(editor.rootID)
    || !NODE_ID.test(editor.notebook) || editor.disabled) {
    services.ui.notify(translate(context.plugin.i18n, "image.single.invalidTarget"));
    return;
  }

  const raw = imageSourceAttribute(image);
  if (!raw) {
    services.ui.notify(translate(context.plugin.i18n, "image.single.invalidTarget"));
    return;
  }
  const signal = scope.signal;
  try {
    const source = resolveSource(raw, services.origin);
    const doc = await resolveDocument(services, editor, signal);
    const documentDOM = await blockDOM(services, doc.id, doc.box, signal);
    if (!scanDOM(documentDOM, services.origin).some(ref => ref.blockID === blockID && ref.kind === "image" && ref.key === source.key)) {
      services.ui.notify(translate(context.plugin.i18n, "image.single.unmappable"));
      return;
    }
    const initialDOM = await blockDOM(services, blockID, doc.box, signal);
    const persisted = scanDOM(initialDOM, services.origin).filter(ref => ref.blockID === blockID && ref.kind === "image" && ref.key === source.key);
    const sameSourceImages = Array.from(image.closest("[data-node-id]")!.querySelectorAll("img"))
      .filter(candidate => {
        const value = imageSourceAttribute(candidate);
        if (!value) return false;
        try { return resolveSource(value, services.origin).key === source.key; } catch { return false; }
      });
    const imageIndex = sameSourceImages.indexOf(image);
    if (imageIndex < 0 || persisted.length !== sameSourceImages.length) {
      services.ui.notify(translate(context.plugin.i18n, "image.single.unmappable"));
      return;
    }

    const intent: Intent = { kind: "manual-single", rootID: doc.id };
    let file = providedFile;
    if (source.kind === "file" && !file && services.desktopFiles && !config.sources.desktopLocalFiles) throw new Error("本地文件处理已关闭");
    if (source.kind === "file" && !file && !services.desktopFiles) {
      const accepted = await services.ui.confirm(translate(context.plugin.i18n, "sources.pickOriginal"),
        translate(context.plugin.i18n, "image.confirmOriginalFile", { name: source.name }), signal);
      if (!accepted) return;
      file = await services.ui.pickImage(source.name, signal);
      if (!file) return;
    }

    const prepared = await prepareImage(services, source, doc.id, intent, config, signal, file);
    if (!prepared) {
      services.ui.notify(translate(context.plugin.i18n, "image.single.noBenefit"));
      return;
    }
    if (!scope.active || signal.aborted) return;

    const mapping = { key: source.key, oldPath: source.kind === "asset" ? source.path : source.raw, newPath: prepared.path,
      ...(file ? { selection: { blockID, expectedCount: persisted.length, imageIndices: [imageIndex] } } : {}) };
    const seed: DocumentRow = doc;
    const forceSQL = config.references.backend === "sql" || source.kind !== "asset" || Boolean(file) || Boolean(source.kind === "asset" && source.box);
    const plan = await services.references.plan([mapping], seed, config.references.maxDocuments,
      forceSQL,
      file ? blockID : undefined, signal);
    if (!await confirmPlan(services, context, plan, signal, Boolean(file))) return;
    const latestTarget = await blockDOM(services, blockID, doc.box, signal);
    const latestRefs = scanDOM(latestTarget, services.origin).filter(ref => ref.blockID === blockID && ref.kind === "image" && ref.key === source.key);
    if (!latestRefs[imageIndex] || latestRefs.length !== persisted.length) {
      services.ui.notify(translate(context.plugin.i18n, "image.single.conflict"));
      return;
    }
    const written = await services.references.commit(plan, signal);
    if (written.state !== "verified") {
      services.ui.notify(translate(context.plugin.i18n, "image.single.conflict"));
      return;
    }
    if (image.isConnected && imageSourceAttribute(image) === raw) {
      const attr = image.hasAttribute("data-src") ? "data-src" : "src";
      image.setAttribute(attr, prepared.path);
    }

    if (!file && source.kind === "asset") {
      try {
        const cleanup = await services.finalizer.finish(intent, config, source, prepared.path, written,
          async () => {
            const current = await services.reader.read(source, { maxBytes: config.compression.maxInputBytes,
              timeoutMs: 30_000, signal });
            return await digest(current.blob) === prepared.originalHash;
          }, signal);
        if (cleanup.status !== "retained") services.ui.notify(cleanup.status === "unknown"
          ? translate(context.plugin.i18n, "image.cleanupUnknown")
          : translate(context.plugin.i18n, "image.cleanupDone"));
      } catch (error) {
        context.logger.warn("单图引用已更新，原图清理未完成", error);
      }
    }
    services.ui.notify(translate(context.plugin.i18n, "image.single.success", {
      original: formatBytes(prepared.originalBytes), compressed: formatBytes(prepared.compressedBytes),
    }));
  } catch (error) {
    if (!signal.aborted) {
      context.logger.warn("压缩所选图片失败", error);
      services.ui.notify(translate(context.plugin.i18n, "image.single.failed"));
    }
  }
}

/** Explicit menu action for replacing a source with a user-selected original file. */
export function compressSelectedImageFromFile(
  menuDetail: unknown,
  file: File,
  context: FeatureContext,
  scope: FeatureScope,
  editor: SingleImageEditorContext,
  services: ImageProcessingServices,
): Promise<void> {
  return compressSelectedImage(menuDetail, context, scope, editor, services, file);
}

async function resolveDocument(services: ImageProcessingServices, editor: SingleImageEditorContext, signal: AbortSignal): Promise<DocumentRow> {
  const rows = (await services.kernel.post<unknown>("/api/query/sql", {
    stmt: `SELECT id, root_id, box FROM blocks WHERE type = 'd' AND id = ${sqlLiteral(editor.rootID)} LIMIT 1`, mode: "readonly",
  }, { signal })).data;
  if (!Array.isArray(rows) || rows.length !== 1 || rows[0]?.id !== editor.rootID
    || rows[0]?.root_id !== editor.rootID || rows[0]?.box !== editor.notebook) throw new Error("无法确认当前编辑器对应的普通文档");
  return rows[0] as DocumentRow;
}

async function blockDOM(services: ImageProcessingServices, id: string, notebook: string, signal: AbortSignal): Promise<string> {
  const data = (await services.kernel.post<any>("/api/block/getBlockDOM", { id, notebook }, { signal })).data;
  if (!data || data.id !== undefined && data.id !== id || typeof data.dom !== "string" || !data.dom.trim()) throw new Error("无法读取目标图片块");
  return data.dom;
}

async function confirmPlan(services: ImageProcessingServices, context: FeatureContext, plan: ReferencePlan, signal: AbortSignal, selectedOccurrence: boolean): Promise<boolean> {
  const key = selectedOccurrence ? "image.confirmSelectedReference"
    : plan.backend === "native" ? "image.confirmNativeReferences" : "image.confirmSQLReferences";
  return services.ui.confirm(translate(context.plugin.i18n, "common.confirm"), translate(context.plugin.i18n, key), signal);
}

function findTargetImage(detail: unknown): HTMLImageElement | undefined {
  const element = (detail as any)?.element as HTMLElement | undefined;
  if (element instanceof HTMLImageElement) return element;
  return (element?.matches("img") ? element : element?.querySelector("img")) as HTMLImageElement | null ?? undefined;
}

function formatBytes(size: number): string { return size < 1024 ? `${size} B` : `${(size / 1024).toFixed(1)} KB`; }
