export const PROTECTED_CONTAINER_SELECTOR =
  '[data-type="NodeCodeBlock"], [data-type="NodeBlockQueryEmbed"], .protyle-wysiwyg__embed, pre, code';

/**
 * Checks whether an element resides inside a code block or embed container
 * that must not be rewritten by automated processors.
 */
export function isInsideProtectedContainer(node: Element): boolean {
  return typeof node?.closest === "function"
    ? Boolean(node.closest(PROTECTED_CONTAINER_SELECTOR))
    : false;
}
