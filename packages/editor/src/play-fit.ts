export type PlayFitMode = 'fit' | 'fill';

export interface SlideBox {
  left: number;
  top: number;
  width: number;
  height: number;
}

export interface ViewportSize {
  width: number;
  height: number;
}

export const PLAY_FIT_STORAGE_KEY = 'htmlppt.play-fit';

export function scaleFor(
  box: SlideBox,
  viewport: ViewportSize,
  mode: PlayFitMode
): number {
  if (
    !Number.isFinite(box.width) ||
    !Number.isFinite(box.height) ||
    box.width <= 0 ||
    box.height <= 0 ||
    !Number.isFinite(viewport.width) ||
    !Number.isFinite(viewport.height) ||
    viewport.width <= 0 ||
    viewport.height <= 0
  ) {
    return 1;
  }
  const fit = Math.min(viewport.width / box.width, viewport.height / box.height);
  const fill = Math.max(viewport.width / box.width, viewport.height / box.height);
  const scale = mode === 'fill' ? fill : fit;
  return Number.isFinite(scale) && scale > 0 ? scale : 1;
}

export function parseFitMode(value: string | null | undefined): PlayFitMode {
  return value === 'fill' ? 'fill' : 'fit';
}

export function readFitMode(
  storage?: Pick<Storage, 'getItem'> | null
): PlayFitMode {
  if (!storage) return 'fit';
  try {
    return parseFitMode(storage.getItem(PLAY_FIT_STORAGE_KEY));
  } catch {
    return 'fit';
  }
}

export function writeFitMode(
  mode: PlayFitMode,
  storage?: Pick<Storage, 'setItem'> | null
): void {
  if (!storage) return;
  try {
    storage.setItem(PLAY_FIT_STORAGE_KEY, mode);
  } catch {
    // Blocked storage leaves the session default in place.
  }
}

export function sameBox(a: SlideBox | null, b: SlideBox | null): boolean {
  if (!a || !b) return a === b;
  return (
    Math.abs(a.left - b.left) < 0.5 &&
    Math.abs(a.top - b.top) < 0.5 &&
    Math.abs(a.width - b.width) < 0.5 &&
    Math.abs(a.height - b.height) < 0.5
  );
}

export function measureElementBox(
  element: Element | null,
  viewport: ViewportSize
): SlideBox | null {
  if (!element) return null;
  const rect = element.getBoundingClientRect();
  if (
    !Number.isFinite(rect.left) ||
    !Number.isFinite(rect.top) ||
    !Number.isFinite(rect.width) ||
    !Number.isFinite(rect.height) ||
    rect.width <= 0 ||
    rect.height <= 0
  ) {
    return null;
  }
  if (
    rect.left < -1 ||
    rect.top < -1 ||
    rect.right > viewport.width + 1 ||
    rect.bottom > viewport.height + 1
  ) {
    return null;
  }
  return {
    left: rect.left,
    top: rect.top,
    width: rect.width,
    height: rect.height
  };
}
