export function formatBytes(size: number): string {
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
  return `${(size / (1024 * 1024)).toFixed(2)} MB`;
}

export function formatCompressionRatio(originalBytes: number, compressedBytes: number): string {
  if (!Number.isFinite(originalBytes) || originalBytes <= 0 || !Number.isFinite(compressedBytes)) {
    return "0.0%";
  }
  const deltaPct = ((compressedBytes - originalBytes) / originalBytes) * 100;
  if (Math.abs(deltaPct) < 0.05) return "0.0%";
  const sign = deltaPct > 0 ? "+" : "-";
  return `${sign}${Math.abs(deltaPct).toFixed(1)}%`;
}

export function buildCompressionNoticeValues(
  originalBytes?: number,
  compressedBytes?: number,
): { original: string; compressed: string; ratio: string } {
  if (
    typeof originalBytes === "number" && Number.isFinite(originalBytes) && originalBytes >= 0 &&
    typeof compressedBytes === "number" && Number.isFinite(compressedBytes) && compressedBytes >= 0
  ) {
    return {
      original: formatBytes(originalBytes),
      compressed: formatBytes(compressedBytes),
      ratio: formatCompressionRatio(originalBytes, compressedBytes),
    };
  }
  return { original: "-", compressed: "-", ratio: "-" };
}
