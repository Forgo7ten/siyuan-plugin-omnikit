/**
 * @design Tiny DOM factories shared by the settings page and the Dock views. They create
 * elements only; no host state or plugin lifecycle is touched here.
 */
export function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className?: string,
  text?: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

export function button(
  label: string,
  onClick: () => void,
  className = "b3-button b3-button--outline",
): HTMLButtonElement {
  const node = el("button", className, label);
  node.type = "button";
  node.addEventListener("click", onClick);
  return node;
}

export function checkbox(
  label: string,
  checked: boolean,
  onChange: (checked: boolean) => void,
  options: { disabled?: boolean; note?: string } = {},
): HTMLLabelElement {
  const wrap = el("label", "omnikit-option");
  wrap.append(el("span", undefined, label));
  const input = el("input");
  input.type = "checkbox";
  input.checked = checked;
  input.disabled = options.disabled === true;
  input.addEventListener("change", () => onChange(input.checked));
  wrap.append(input);
  if (options.note) wrap.append(el("small", undefined, options.note));
  return wrap;
}
