const HTML_NAMESPACE = 'http://www.w3.org/1999/xhtml';
const SVG_NAMESPACE = 'http://www.w3.org/2000/svg';

export type AppearanceKind = 'image' | 'shape';

/**
 * Images keep crop/alt controls, HTML elements and the outermost SVG map to
 * shape styles, and every other namespace — SVG descendants included — or an
 * element without an inline style object gets no appearance panel.
 */
export function appearanceKindFor(element: Element): AppearanceKind | null {
  const style = (element as Element & { style?: unknown }).style;
  if (!style || typeof style !== 'object') return null;

  const tag = element.tagName.toLowerCase();
  if (element.namespaceURI === SVG_NAMESPACE) {
    const parentIsSvg = element.parentElement?.namespaceURI === SVG_NAMESPACE;
    return tag === 'svg' && !parentIsSvg ? 'shape' : null;
  }
  if (element.namespaceURI === HTML_NAMESPACE) {
    return tag === 'img' ? 'image' : 'shape';
  }
  // Chromium gives MathML and other foreign elements a `.style` object, so the
  // no-style guard above is not enough; core's shape mapping is HTML-only.
  return null;
}
