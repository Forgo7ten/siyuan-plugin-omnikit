import type { FeatureScope } from "../../../core/framework/FeatureScope.ts";
import { imagePath } from "../services/ImageOccurrenceResolver.ts";
import type { ImageProcessingServices } from "../services/ImageProcessingServices.ts";
import { inspectImage, type ImageInfo } from "../services/image.ts";
import type { OccurrenceTarget } from "../policy/contracts.ts";
import { autoAllowed, type ImageConfig } from "../policy/parseImageConfig.ts";
import { blockDOM, type DocumentRow } from "../services/references.ts";
import { scanDOM } from "../policy/dom.ts";
import { resolveSource, type ImageSource } from "../policy/source.ts";
import { classifyImageCandidate } from "../policy/ImageCandidateClassifier.ts";

const PROTECTED_SELECTOR = "pre, code, script, style, [data-type='NodeCodeBlock'], [data-type='NodeBlockQueryEmbed'], .protyle-wysiwyg__embed";

interface Candidate { blockID: string; source: ImageSource; count: number }
export type RemoteWatcherLogger = Pick<Console, "warn">;
export interface RemoteWatcherHandle {
  dispose(): void;
  pause(): void;
  resume(): void;
  reconcile(): Promise<void>;
}

/** Only a newly persisted, authorized HTTP(S) image may be localized. */
export function addedRemoteCandidates(
  previous: ReadonlyMap<string, Candidate>, current: ReadonlyMap<string, Candidate>,
  config: ImageConfig, rootID: string,
): Candidate[] {
  if (!autoAllowed(config, rootID)) return [];
  return [...current].flatMap(([key, candidate]) => {
    if (candidate.source.kind !== "remote" || candidate.count <= (previous.get(key)?.count ?? 0)) return [];
    const decision = classifyImageCandidate({
      path: candidate.source.raw,
      mode: "auto",
      excludedExtensions: config.compression.excludedExtensions,
    });
    return decision.eligible ? [candidate] : [];
  });
}

/** Observe persisted document DOM and localize newly inserted remote images first. */
export async function watchRemoteImages(
  editor: HTMLElement, doc: DocumentRow, scope: FeatureScope,
  services: ImageProcessingServices, logger: RemoteWatcherLogger = console,
): Promise<RemoteWatcherHandle> {
  const owned = new AbortController();
  const abortFromScope = () => owned.abort(scope.signal.reason);
  if (scope.signal.aborted) abortFromScope();
  else scope.signal.addEventListener("abort", abortFromScope, { once: true });
  const signal = owned.signal;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let disposed = false, paused = false, rebasing = false, reading = false, rerun = false;
  let pendingInsertConfirm = false;
  let observing = false;
  let previous: Map<string, Candidate> = new Map();
  const inFlight = new Set<string>();
  const tasks = new Set<AbortController>();
  const hasPersistedTarget = new Map<AbortController, boolean>();
  const keyOf = (blockID: string, key: string) => `${blockID}\n${key}`;

  const snapshot = async (): Promise<Map<string, Candidate>> => {
    const dom = await blockDOM(services.kernel, doc.id, doc.box, signal);
    const result = new Map<string, Candidate>();
    for (const ref of scanDOM(dom, services.origin)) {
      if (ref.kind !== "image") continue;
      const identity = keyOf(ref.blockID, ref.key), found = result.get(identity);
      if (found) found.count++;
      else result.set(identity, { blockID: ref.blockID, source: resolveSource(ref.raw, services.origin), count: 1 });
    }
    return result;
  };

  const hasUnprotectedImage = (node: Node): boolean => {
    if (!(node instanceof Element) || node.closest(PROTECTED_SELECTOR)) return false;
    if (node.matches("img")) return true;
    return [...node.querySelectorAll("img")].some(img => !img.closest(PROTECTED_SELECTOR));
  };
  const observer = new MutationObserver(records => {
    let hasInsert = false;
    let hasRemoval = false;
    for (const record of records) {
      if (record.type === "attributes") {
        if (record.target instanceof HTMLImageElement && !record.target.closest(PROTECTED_SELECTOR)) {
          hasInsert = true;
        }
        continue;
      }
      if (record.target instanceof Element && record.target.closest(PROTECTED_SELECTOR)) continue;
      if ([...record.addedNodes].some(hasUnprotectedImage)) hasInsert = true;
      else if ([...record.removedNodes].some(hasUnprotectedImage)) hasRemoval = true;
    }
    if (hasInsert) schedule(450, true);
    else if (hasRemoval) schedule(450, false);
  });
  const observe = () => {
    if (observing || disposed || paused || !scope.active || signal.aborted) return;
    observing = true;
    observer.observe(editor, { childList: true, subtree: true, attributes: true, attributeFilter: ["src", "data-src"] });
  };

  const stopWatching = () => {
    observing = false;
    observer.disconnect();
    if (timer !== undefined) clearTimeout(timer);
    timer = undefined;
  };
  const dispose = () => {
    if (disposed) return;
    disposed = true;
    stopWatching();
    signal.removeEventListener("abort", stopWatching);
    for (const task of tasks) {
      if (!hasPersistedTarget.get(task)) task.abort("Editor closed before image position was persisted");
    }
    if (!tasks.size) scope.signal.removeEventListener("abort", abortFromScope);
    editor.removeEventListener("beforeinput", onUndo, true);
  };
  const release = scope.own(dispose);
  signal.addEventListener("abort", stopWatching, { once: true });

  if (autoAllowed(services.config(), doc.id)) {
    try {
      previous = await snapshot();
      if (!scope.active || signal.aborted) {
        scope.signal.removeEventListener("abort", abortFromScope);
        return { dispose() {}, pause() {}, resume() {}, async reconcile() {} };
      }
      observe();
    } catch (error) {
      if (!signal.aborted && scope.active) logger.warn("读取初始图片状态失败", error);
    }
  }

  async function process(candidate: Candidate, oldCount: number): Promise<void> {
    // Duplicate identical remote references cannot be mapped to one physical image safely.
    if (disposed || paused || !scope.active || signal.aborted || oldCount !== 0 || candidate.count !== 1) return;
    const config = services.config();
    if (!autoAllowed(config, doc.id)) return;
    const taskKey = keyOf(candidate.blockID, candidate.source.key);
    if (inFlight.has(taskKey)) return;
    inFlight.add(taskKey);
    const task = new AbortController();
    const abortTask = () => task.abort(signal.reason);
    signal.addEventListener("abort", abortTask, { once: true });
    tasks.add(task);
    hasPersistedTarget.set(task, false);
    try {
      const persistedDOM = await blockDOM(services.kernel, candidate.blockID, doc.box, task.signal);
      if (!persistedDOM.trim()) return;
      const template = document.createElement("template");
      template.innerHTML = persistedDOM;
      const roots = [...template.content.children]
        .filter(node => node.getAttribute("data-node-id") === candidate.blockID);
      if (template.content.children.length !== 1 || roots.length !== 1 || roots[0].querySelector("[data-node-id]")) return;
      const images = [...roots[0].querySelectorAll("img")];
      let matchedOrdinal = -1;
      let matchedRaw = "";
      for (let i = 0; i < images.length; i++) {
        const raw = imagePath(images[i]);
        if (!raw) continue;
        try {
          if (resolveSource(raw, services.origin).key === candidate.source.key) {
            if (matchedOrdinal >= 0) return;
            matchedOrdinal = i;
            matchedRaw = raw;
          }
        } catch {
          // Ignore malformed image src
        }
      }
      if (matchedOrdinal < 0 || matchedRaw !== candidate.source.raw || !scope.active || task.signal.aborted) return;
      const target: OccurrenceTarget = {
        rootID: doc.id,
        notebook: doc.box,
        blockID: candidate.blockID,
        imageOrdinal: matchedOrdinal,
        oldPath: matchedRaw,
        baselineBlockDOM: persistedDOM,
      };
      hasPersistedTarget.set(task, true);

      const downloaded = await services.reader.read(candidate.source, {
        maxBytes: Math.min(config.compression.maxInputBytes, 32 * 1024 * 1024), timeoutMs: 30_000, signal: task.signal,
        userAgent: services.userAgent(),
      });
      await assertImagePayload(downloaded.blob);
      if (!scope.active || task.signal.aborted) return;
      const providedFile = await calibrateRemoteImageFile(downloaded.blob, downloaded.name || candidate.source.name);
      const localOriginal = await services.assets.upload(providedFile, doc.id, task.signal);
      const localSource = resolveSource(localOriginal, services.origin);
      if (localSource.kind !== "asset") return;

      // Localization is a standalone commit. Even unsupported/too-small images remain
      // safely referenced by their local original if later compression is skipped.
      const localized = await services.references.commitOccurrence(target, localOriginal, task.signal);
      if (localized !== "replaced" || !scope.active || task.signal.aborted) return;

      const nextTarget = { ...target, oldPath: localOriginal };

      // prepareImage persists the Dock mapping before a compressed path is eligible for
      // replacement. A skipped format/threshold leaves the localized original in place.
      const currentConfig = services.config();
      if (!autoAllowed(currentConfig, doc.id) || !scope.active || task.signal.aborted) return;
      const compressed = await services.compressOccurrence(nextTarget, currentConfig, task.signal,
        { mode: "auto", replace: true, providedFile });
      if (compressed.status === "saved" && compressed.reference !== "replaced") {
        logger.warn("自动处理外链图片的压缩引用更新未能确认", compressed.reference);
      }
    } catch (error) {
      if (!task.signal.aborted && scope.active) {
        logger.warn("自动处理外链图片失败", error);
      }
    } finally {
      tasks.delete(task);
      hasPersistedTarget.delete(task);
      inFlight.delete(taskKey);
      signal.removeEventListener("abort", abortTask);
      if (disposed && !tasks.size) scope.signal.removeEventListener("abort", abortFromScope);
    }
  }

  async function sweep(confirmIfEmpty = false): Promise<void> {
    if (disposed || paused || !scope.active || signal.aborted || !observing) return;
    if (!autoAllowed(services.config(), doc.id)) return;
    if (reading) {
      if (confirmIfEmpty) pendingInsertConfirm = true;
      rerun = true;
      return;
    }
    reading = true;
    try {
      const current = await snapshot();
      const old = previous;
      previous = current;
      if (rebasing) { rebasing = false; return; }
      const added = addedRemoteCandidates(old, current, services.config(), doc.id);
      if (added.length > 20) { logger.warn("检测到大量新增外链图片，请使用文档批量操作"); return; }
      if (!added.length && confirmIfEmpty && !paused && !disposed && observing && !signal.aborted && !rerun) {
        schedule(900, false);
        return;
      }
      for (const candidate of added) {
        if (disposed || paused || !scope.active || signal.aborted) break;
        const identity = keyOf(candidate.blockID, candidate.source.key);
        const oldCount = old.get(identity)?.count ?? 0;
        await process(candidate, oldCount);
      }
    } catch (error) {
      if (!signal.aborted && scope.active) logger.warn("读取持久化图片状态失败", error);
    } finally {
      reading = false;
      if (rerun && !paused && !disposed && observing) {
        rerun = false;
        const nextConfirm = pendingInsertConfirm;
        pendingInsertConfirm = false;
        schedule(350, nextConfirm);
      }
    }
  }
  function schedule(delay = 450, confirmIfEmpty = false): void {
    if (paused || disposed || !observing) return;
    if (confirmIfEmpty) pendingInsertConfirm = true;
    if (timer !== undefined) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = undefined;
      const shouldConfirm = pendingInsertConfirm;
      pendingInsertConfirm = false;
      void sweep(shouldConfirm);
    }, delay);
  }
  const onUndo = (event: Event) => {
    if (!observing || paused || disposed) return;
    const type = (event as InputEvent).inputType;
    if (type === "historyUndo" || type === "historyRedo") { rebasing = true; schedule(200); }
  };
  const onSyncStart = () => {
    paused = true; stopWatching();
    for (const task of tasks) task.abort("Sync started");
    tasks.clear();
  };
  const onSyncEnd = () => {
    paused = false;
    if (disposed || !scope.active || signal.aborted) return;
    if (!autoAllowed(services.config(), doc.id)) { observing = false; return; }
    void snapshot().then(value => {
      if (!disposed && scope.active && !paused) { previous = value; observe(); }
    }).catch(error => { if (!signal.aborted) logger.warn("同步后重建图片基线失败", error); });
  };
  const reconcile = async (): Promise<void> => {
    if (disposed || !scope.active || signal.aborted) return;
    const allowed = autoAllowed(services.config(), doc.id);
    if (!allowed) {
      if (observing) {
        stopWatching();
        for (const task of tasks) {
          if (!hasPersistedTarget.get(task)) task.abort("Document permission revoked");
        }
      }
      return;
    }
    if (!observing) {
      try {
        previous = await snapshot();
        if (disposed || !scope.active || signal.aborted) return;
        observe();
      } catch (error) {
        if (!signal.aborted && scope.active) logger.warn("重建图片基线失败", error);
      }
    } else {
      schedule(200);
    }
  };
  editor.addEventListener("beforeinput", onUndo, true);
  return { dispose: release, pause: onSyncStart, resume: onSyncEnd, reconcile };
}

export function safeFileName(name: string): string {
  const base = name.replace(/\\/g, "/").split("/").pop() || "remote-image";
  const safe = base.replace(/[\u0000-\u001f<>:"/\\|?*]/g, "_").slice(0, 180);
  return safe || "remote-image";
}

const MIME_TO_EXT: Record<ImageInfo["mime"], string> = {
  "image/png": ".png",
  "image/jpeg": ".jpg",
  "image/webp": ".webp",
};

/** Calibrates extension and MIME from image signature bytes when supported, keeping other formats intact. */
export async function calibrateRemoteImageFile(blob: Blob, rawName: string): Promise<File> {
  const baseName = safeFileName(rawName);
  let fileName = baseName;
  let mime = blob.type;
  try {
    const info = inspectImage(new Uint8Array(await blob.arrayBuffer()));
    mime = info.mime;
    const targetExt = MIME_TO_EXT[info.mime];
    const extMatch = /\.[a-zA-Z0-9]{1,10}$/.exec(baseName);
    const currentExt = extMatch?.[0].toLowerCase();
    const compatibleExts = info.mime === "image/jpeg" ? [".jpg", ".jpeg"] : [targetExt];
    if (!currentExt || !compatibleExts.includes(currentExt)) {
      const stem = extMatch ? baseName.slice(0, -extMatch[0].length) : baseName;
      fileName = `${stem || "remote-image"}${targetExt}`;
    }
  } catch {
    // Preserve original file name and MIME for GIF/SVG or truncated test stubs
  }
  return new File([blob], fileName, { type: mime });
}

export async function assertImagePayload(blob: Blob): Promise<void> {
  const bytes = new Uint8Array(await blob.slice(0, 4096).arrayBuffer());
  const ascii = (start: number, length: number) => String.fromCharCode(...bytes.slice(start, start + length));
  const png = bytes.length >= 8 && [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]
    .every((byte, index) => bytes[index] === byte);
  const jpeg = bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
  const gif = bytes.length >= 6 && ["GIF87a", "GIF89a"].includes(ascii(0, 6));
  const webp = bytes.length >= 12 && ascii(0, 4) === "RIFF" && ascii(8, 4) === "WEBP";
  const prefix = new TextDecoder().decode(bytes).replace(/^\uFEFF/, "").trimStart();
  const svg = /^(?:<\?xml[^>]*>\s*)?<svg(?:\s|>)/i.test(prefix);
  if (svg) {
    const fullText = await blob.text();
    if (/<!DOCTYPE|<!ENTITY|<script\b|<foreignObject\b|<image\b|<use\b|<iframe\b|<object\b|<embed\b|<style\b|\son[a-z]+\s*=|\b(?:href|src)\s*=|url\s*\(|@import|(?:javascript|data|file):/i.test(fullText)) {
      throw new Error("Unsafe SVG image content");
    }
  }
  if (!png && !jpeg && !gif && !webp && !svg) throw new Error("Remote response is not a supported image payload");
}
