/** Accept only canonical relative assets paths, without URL, query, traversal or encoded separators. */
export function originalAssetURL(image: HTMLImageElement): string | undefined {
  for (const value of [image.getAttribute("data-src"), image.getAttribute("src")]) {
    if (!value || !/^assets\//i.test(value) || /[?#\\]/.test(value)) continue;
    let decoded: string;
    try { decoded = decodeURIComponent(value); } catch { continue; }
    if (decoded.split("/").some(part => !part || part === "." || part === "..") || decoded.includes("\\")) continue;
    return value;
  }
  return undefined;
}
