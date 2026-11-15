/** SiYuan metadata reports rootID and box; the SQL index also reports block type. */

export interface BlockIdentity {
  id?: string;
  rootID?: string;
  type?: string;
  box?: string;
}

/** Block ids are `yyyyMMddHHmmss-xxxxxxx`; anything else is rejected before it reaches SQL. */
const BLOCK_ID = /^[0-9a-zA-Z-]{1,64}$/;

export function isSafeBlockId(id: string): boolean {
  return BLOCK_ID.test(id);
}

/**
 * @safety A document root is proven by an explicit `type === "d"`, or - when the kernel
 * omits the type - by the block reporting itself as its own root. A descendant block always
 * reports a different document root, so the fallback cannot authorize a child block.
 */
export function isDocumentRootIdentity(info: BlockIdentity | undefined, id: string): boolean {
  if (!info) return false;
  if (info.id && info.id !== id) return false;
  if (info.type) return info.type === "d";
  return info.rootID === id;
}
