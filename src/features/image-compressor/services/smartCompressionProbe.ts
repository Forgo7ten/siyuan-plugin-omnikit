export type SmartSupportReason =
  | "missing-worker"
  | "missing-offscreen-canvas"
  | "missing-image-bitmap"
  | "webp-encode-unsupported";

export type SmartCompressionSupport =
  | { supported: true }
  | { supported: false; reason: SmartSupportReason };

let customSmartSupportResolver: (() => SmartCompressionSupport | Promise<SmartCompressionSupport>) | undefined;
let cachedSmartSupportPromise: Promise<SmartCompressionSupport> | undefined;
let cachedSmartSupportValue: SmartCompressionSupport | undefined;

export function setSmartSupportResolverForTest(
  resolver?: () => SmartCompressionSupport | Promise<SmartCompressionSupport>,
): void {
  customSmartSupportResolver = resolver;
  cachedSmartSupportPromise = undefined;
  cachedSmartSupportValue = undefined;
}

export function getCachedSmartCompressionSupport(): SmartCompressionSupport | undefined {
  return cachedSmartSupportValue;
}

export function isSmartCompressionEffective(smartEnabled: boolean | undefined): boolean {
  if (!smartEnabled) return false;
  return cachedSmartSupportValue ? cachedSmartSupportValue.supported : true;
}

async function canSpawnInlineWorker(): Promise<boolean> {
  if (typeof Worker !== "function") return false;
  if (typeof Blob !== "function" || typeof URL?.createObjectURL !== "function") {
    return true;
  }
  const blob = new Blob(["self.onmessage=function(){self.postMessage(1)};"], {
    type: "text/javascript;charset=utf-8",
  });
  const url = URL.createObjectURL(blob);
  let worker: Worker | undefined;
  try {
    worker = new Worker(url);
    if (typeof worker.postMessage !== "function") {
      return true;
    }
    return await new Promise<boolean>(resolve => {
      const timer = setTimeout(() => resolve(false), 200);
      (timer as unknown as { unref?: () => void }).unref?.();
      worker!.onmessage = () => {
        clearTimeout(timer);
        resolve(true);
      };
      worker!.onerror = () => {
        clearTimeout(timer);
        resolve(false);
      };
      worker!.postMessage(0);
    });
  } catch {
    return false;
  } finally {
    try {
      worker?.terminate();
    } catch {
      // ignore worker termination errors
    }
    URL.revokeObjectURL(url);
  }
}

async function detectSmartCompressionSupport(): Promise<SmartCompressionSupport> {
  if (!(await canSpawnInlineWorker())) {
    return { supported: false, reason: "missing-worker" };
  }
  if (typeof OffscreenCanvas !== "function") {
    return { supported: false, reason: "missing-offscreen-canvas" };
  }
  if (typeof createImageBitmap !== "function") {
    return { supported: false, reason: "missing-image-bitmap" };
  }
  const canvas = new OffscreenCanvas(1, 1);
  try {
    const ctx = canvas.getContext("2d");
    if (!ctx) {
      return { supported: false, reason: "missing-offscreen-canvas" };
    }
    if (typeof ctx.fillRect === "function") {
      ctx.fillStyle = "#808080";
      ctx.fillRect(0, 0, 1, 1);
    }
    const blob = await canvas.convertToBlob({ type: "image/webp", quality: 0.8 });
    if (!blob || blob.type !== "image/webp" || blob.size <= 0) {
      return { supported: false, reason: "webp-encode-unsupported" };
    }
    return { supported: true };
  } catch {
    return { supported: false, reason: "webp-encode-unsupported" };
  } finally {
    canvas.width = 0;
    canvas.height = 0;
  }
}

export function probeSmartCompressionSupport(): Promise<SmartCompressionSupport> {
  if (customSmartSupportResolver) {
    return Promise.resolve()
      .then(() => customSmartSupportResolver!())
      .then(result => {
        cachedSmartSupportValue = result;
        return result;
      });
  }
  cachedSmartSupportPromise ??= detectSmartCompressionSupport().then(result => {
    cachedSmartSupportValue = result;
    return result;
  });
  return cachedSmartSupportPromise;
}
