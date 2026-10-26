/**
 * Mirrors the pin condition in `applyGeometryEdit`: a flow object is converted
 * to absolute positioning by its first position or size edit.
 */
export function willPinToAbsolute(element: Element): boolean {
  const style = (element as HTMLElement).style;
  if (!style) return false;
  return style.position !== 'absolute' && style.position !== 'fixed';
}
