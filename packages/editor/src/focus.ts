const FOCUSABLE_SELECTOR = [
  'a[href]',
  'button:not([disabled])',
  'input:not([disabled])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  'summary',
  '[tabindex]:not([tabindex="-1"])'
].join(',');

/** Enabled, sequentially focusable descendants in DOM order. */
export function focusableWithin(root: ParentNode): HTMLElement[] {
  return Array.from(
    root.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)
  ).filter((element) => element.getAttribute('aria-hidden') !== 'true');
}

/** Wraps Tab navigation around a focus ring of the given length. */
export function wrapFocusIndex(
  current: number,
  length: number,
  backwards: boolean
): number {
  if (length <= 0) return -1;
  if (backwards) return current <= 0 ? length - 1 : current - 1;
  return current >= length - 1 ? 0 : current + 1;
}
