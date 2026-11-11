/** @design browser-image-compression's public API expects File; fetched asset Blobs have no name. */
export function createCompressionFile(source: Blob, sourcePath: string): File {
  const name = sourcePath.split(/[\\/]/).pop()?.split(/[?#]/, 1)[0] || "image";
  const lastModified = typeof File !== "undefined" && source instanceof File ? source.lastModified : Date.now();
  return new File([source], name, { type: source.type, lastModified });
}
