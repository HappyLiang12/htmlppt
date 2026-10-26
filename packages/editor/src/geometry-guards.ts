/**
 * True when the element's inline style already positions it out of flow.
 * This is the single source of truth for the pin condition: `applyGeometryEdit`
 * uses it to decide whether to pin, and the editor uses it to explain the pin.
 */
export function isPositioned(element: Element): boolean {
  const style = (element as HTMLElement).style;
  if (!style) return false;
  return style.position === 'absolute' || style.position === 'fixed';
}

/**
 * Mirrors the pin condition in `applyGeometryEdit`: a flow object is converted
 * to absolute positioning by its first position or size edit. Elements without
 * an inline style cannot be pinned, matching the early `return false` there.
 */
export function willPinToAbsolute(element: Element): boolean {
  const style = (element as HTMLElement).style;
  return Boolean(style) && !isPositioned(element);
}

/**
 * Detects the pin for a whole gesture before its first geometry write. Drags
 * and nudges move several targets at once; one flow target is enough to explain
 * the conversion.
 */
export function willAnyPinToAbsolute(elements: readonly Element[]): boolean {
  return elements.some((element) => willPinToAbsolute(element));
}

/** The notice is due only for the first pin of the editor session. */
export function shouldNotifyPin(
  pinned: boolean,
  alreadyShown: boolean
): boolean {
  return pinned && !alreadyShown;
}

/**
 * The notice's Undo delegates to the global undo. A pending edit is settled
 * into its own history entry (and undone) before that undo runs, and an active
 * text-editing session is the same hazard, so the notice must step aside
 * rather than revert the wrong change. Toolbar and Ctrl+Z undo are untouched.
 */
export function shouldDismissPinNotice(
  noticeVisible: boolean,
  pendingEdit: boolean,
  textEditing: boolean
): boolean {
  return noticeVisible && (pendingEdit || textEditing);
}
