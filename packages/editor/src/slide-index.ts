/** Clamps a slide index into the current slide list; empty decks resolve to 0. */
export function clampSlideIndex(index: number, length: number): number {
  if (length <= 0) return 0;
  return Math.max(0, Math.min(index, length - 1));
}
