export interface Point {
  x: number;
  y: number;
}

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface Guide {
  axis: 'x' | 'y';
  position: number;
}

export type Handle = 'n' | 'ne' | 'e' | 'se' | 's' | 'sw' | 'w' | 'nw';

export interface SnapResult {
  rect: Rect;
  guides: Guide[];
}

/**
 * Converts a viewport pointer position into design pixels. `frame` is the
 * iframe's client rect, so its offset is removed before undoing the scale.
 */
export function toDesignPoint(
  clientX: number,
  clientY: number,
  frame: Rect,
  scale: number
): Point {
  return {
    x: (clientX - frame.x) / scale,
    y: (clientY - frame.y) / scale
  };
}

interface AxisSnap {
  delta: number;
  position: number;
}

function bestAxisSnap(
  start: number,
  size: number,
  boundsStart: number,
  boundsSize: number,
  targetStarts: number[],
  targetSizes: number[],
  threshold: number
): AxisSnap | null {
  const movingLines = [start, start + size / 2, start + size];
  const targetLines = [
    boundsStart,
    boundsStart + boundsSize / 2,
    boundsStart + boundsSize
  ];
  for (let index = 0; index < targetStarts.length; index += 1) {
    const targetStart = targetStarts[index];
    const targetSize = targetSizes[index];
    targetLines.push(
      targetStart,
      targetStart + targetSize / 2,
      targetStart + targetSize
    );
  }

  let best: AxisSnap | null = null;
  for (const position of targetLines) {
    for (const movingLine of movingLines) {
      const delta = position - movingLine;
      if (Math.abs(delta) > threshold) continue;
      if (!best || Math.abs(delta) < Math.abs(best.delta)) {
        best = { delta, position };
      }
    }
  }
  return best;
}

/**
 * Snaps a moving rect to the slide bounds and sibling edges/centers. Each axis
 * independently takes the smallest delta within `thresholdDesign` design
 * pixels; an inclusive threshold match snaps. Guides are ordered x then y and
 * carry the target line position in design pixels.
 */
export function snapRect(
  moving: Rect,
  targets: Rect[],
  thresholdDesign: number,
  bounds: Rect
): SnapResult {
  const xSnap = bestAxisSnap(
    moving.x,
    moving.width,
    bounds.x,
    bounds.width,
    targets.map((target) => target.x),
    targets.map((target) => target.width),
    thresholdDesign
  );
  const ySnap = bestAxisSnap(
    moving.y,
    moving.height,
    bounds.y,
    bounds.height,
    targets.map((target) => target.y),
    targets.map((target) => target.height),
    thresholdDesign
  );

  const rect = { ...moving };
  const guides: Guide[] = [];
  if (xSnap) {
    rect.x += xSnap.delta;
    guides.push({ axis: 'x', position: xSnap.position });
  }
  if (ySnap) {
    rect.y += ySnap.delta;
    guides.push({ axis: 'y', position: ySnap.position });
  }
  return { rect, guides };
}

/**
 * Resizes from one of the eight handles. West and north handles move the
 * origin so the opposite edge stays fixed; sizes never drop below `minSize`.
 */
export function resizeRect(
  start: Rect,
  handle: Handle,
  delta: { dx: number; dy: number },
  minSize: number
): Rect {
  const west = handle.includes('w');
  const east = handle.includes('e');
  const north = handle.includes('n');
  const south = handle.includes('s');

  let { x, y, width, height } = start;

  if (east) width = Math.max(minSize, start.width + delta.dx);
  if (west) {
    width = Math.max(minSize, start.width - delta.dx);
    x = start.x + start.width - width;
  }
  if (south) height = Math.max(minSize, start.height + delta.dy);
  if (north) {
    height = Math.max(minSize, start.height - delta.dy);
    y = start.y + start.height - height;
  }

  return { x, y, width, height };
}

/**
 * Rotates a point around a center in screen coordinates (y grows downward).
 */
export function rotatePoint(
  point: Point,
  center: Point,
  radians: number
): Point {
  const cosine = Math.cos(radians);
  const sine = Math.sin(radians);
  const dx = point.x - center.x;
  const dy = point.y - center.y;

  return {
    x: center.x + dx * cosine - dy * sine,
    y: center.y + dx * sine + dy * cosine
  };
}

/** Normalizes degrees into [0, 360). */
export function normalizeAngle(degrees: number): number {
  return ((degrees % 360) + 360) % 360;
}

/**
 * Offsets a rect and clamps its origin to the slide bounds. The size is kept,
 * so an oversized rect pins to the bounds' left/top edge.
 */
export function nudge(
  rect: Rect,
  dx: number,
  dy: number,
  bounds: Rect
): Rect {
  const maxX = Math.max(bounds.x, bounds.x + bounds.width - rect.width);
  const maxY = Math.max(bounds.y, bounds.y + bounds.height - rect.height);

  return {
    ...rect,
    x: Math.min(Math.max(rect.x + dx, bounds.x), maxX),
    y: Math.min(Math.max(rect.y + dy, bounds.y), maxY)
  };
}
