export type AppearanceKind = 'image' | 'shape';

/** Images keep crop/alt controls; every other element maps to shape styles. */
export function appearanceKindFor(element: Element): AppearanceKind {
  return element.tagName.toLowerCase() === 'img' ? 'image' : 'shape';
}
