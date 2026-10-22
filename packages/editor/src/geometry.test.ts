import { describe, expect, it } from 'vitest';
import {
  nudge,
  normalizeAngle,
  resizeRect,
  rotatePoint,
  snapRect,
  toDesignPoint,
  type Guide,
  type Handle,
  type Rect
} from './geometry.js';

const rect = (x: number, y: number, width: number, height: number): Rect => ({
  x,
  y,
  width,
  height
});

const SLIDE: Rect = rect(0, 0, 1600, 900);

describe('toDesignPoint', () => {
  it('maps client coordinates through the iframe offset at scale 0.5', () => {
    const frame = rect(100, 50, 800, 450);

    expect(toDesignPoint(300, 200, frame, 0.5)).toEqual({ x: 400, y: 300 });
  });

  it('maps client coordinates through the iframe offset at scale 2', () => {
    const frame = rect(40, 20, 3200, 1800);

    expect(toDesignPoint(240, 220, frame, 2)).toEqual({ x: 100, y: 100 });
  });

  it('keeps fractional design coordinates', () => {
    const frame = rect(10, 20, 800, 450);

    expect(toDesignPoint(35, 45, frame, 0.5)).toEqual({ x: 50, y: 50 });
  });
});

describe('snapRect', () => {
  it('snaps the moving left edge to a sibling left edge', () => {
    const moving = rect(102, 200, 80, 40);
    const target = rect(100, 400, 60, 40);

    const result = snapRect(moving, [target], 4, SLIDE);

    expect(result.rect).toEqual(rect(100, 200, 80, 40));
    expect(result.guides).toEqual<Guide[]>([{ axis: 'x', position: 100 }]);
  });

  it('snaps the moving center to a sibling center and prefers the nearest delta', () => {
    const moving = rect(96, 200, 80, 40);
    const target = rect(100, 400, 72, 40);

    const result = snapRect(moving, [target], 4, SLIDE);

    expect(result.rect).toEqual(rect(96, 200, 80, 40));
    expect(result.guides).toEqual<Guide[]>([{ axis: 'x', position: 136 }]);
  });

  it('snaps the moving right edge to a sibling right edge', () => {
    const moving = rect(130, 200, 70, 40);
    const target = rect(20, 400, 180, 40);

    const result = snapRect(moving, [target], 4, SLIDE);

    expect(result.rect).toEqual(rect(130, 200, 70, 40));
    expect(result.guides).toEqual<Guide[]>([{ axis: 'x', position: 200 }]);
  });

  it('snaps the moving top edge to a sibling top edge', () => {
    const moving = rect(200, 102, 80, 40);
    const target = rect(400, 100, 40, 60);

    const result = snapRect(moving, [target], 4, SLIDE);

    expect(result.rect).toEqual(rect(200, 100, 80, 40));
    expect(result.guides).toEqual<Guide[]>([{ axis: 'y', position: 100 }]);
  });

  it('snaps the moving middle to a sibling middle', () => {
    const moving = rect(200, 96, 80, 40);
    const target = rect(400, 100, 40, 32);

    const result = snapRect(moving, [target], 4, SLIDE);

    expect(result.rect).toEqual(rect(200, 96, 80, 40));
    expect(result.guides).toEqual<Guide[]>([{ axis: 'y', position: 116 }]);
  });

  it('snaps the moving bottom edge to a sibling bottom edge', () => {
    const moving = rect(200, 130, 80, 70);
    const target = rect(400, 20, 40, 180);

    const result = snapRect(moving, [target], 4, SLIDE);

    expect(result.rect).toEqual(rect(200, 130, 80, 70));
    expect(result.guides).toEqual<Guide[]>([{ axis: 'y', position: 200 }]);
  });

  it('snaps every edge and center to the slide bounds', () => {
    const bounds = rect(0, 0, 1000, 1000);
    const cases: Array<[Rect, Rect, Guide[]]> = [
      [rect(3, 300, 80, 40), rect(0, 300, 80, 40), [{ axis: 'x', position: 0 }]],
      [
        rect(457, 300, 80, 40),
        rect(460, 300, 80, 40),
        [{ axis: 'x', position: 500 }]
      ],
      [
        rect(917, 300, 80, 40),
        rect(920, 300, 80, 40),
        [{ axis: 'x', position: 1000 }]
      ],
      [rect(300, 3, 80, 40), rect(300, 0, 80, 40), [{ axis: 'y', position: 0 }]],
      [
        rect(300, 476, 80, 40),
        rect(300, 480, 80, 40),
        [{ axis: 'y', position: 500 }]
      ],
      [
        rect(300, 957, 80, 40),
        rect(300, 960, 80, 40),
        [{ axis: 'y', position: 1000 }]
      ]
    ];

    for (const [moving, expected, guides] of cases) {
      expect(snapRect(moving, [], 4, bounds)).toEqual({ rect: expected, guides });
    }
  });

  it('picks the nearest of several candidate targets', () => {
    const moving = rect(104, 300, 50, 40);
    const far = rect(100, 600, 200, 40);
    const near = rect(106, 700, 200, 40);

    const result = snapRect(moving, [far, near], 4, SLIDE);

    expect(result.rect).toEqual(rect(106, 300, 50, 40));
    expect(result.guides).toEqual<Guide[]>([{ axis: 'x', position: 106 }]);
  });

  it('does not snap when the delta is beyond the threshold', () => {
    const moving = rect(103, 300, 80, 40);
    const target = rect(100, 600, 60, 40);

    const result = snapRect(moving, [target], 2, SLIDE);

    expect(result).toEqual({ rect: moving, guides: [] });
  });

  it('snaps exactly at the threshold', () => {
    const moving = rect(103, 300, 80, 40);
    const target = rect(100, 600, 60, 40);

    const result = snapRect(moving, [target], 3, SLIDE);

    expect(result.rect).toEqual(rect(100, 300, 80, 40));
    expect(result.guides).toEqual<Guide[]>([{ axis: 'x', position: 100 }]);
  });

  it('snaps both axes and reports one guide per axis', () => {
    const moving = rect(102, 203, 80, 40);
    const target = rect(100, 200, 60, 40);

    const result = snapRect(moving, [target], 4, SLIDE);

    expect(result.rect).toEqual(rect(100, 200, 80, 40));
    expect(result.guides).toEqual<Guide[]>([
      { axis: 'x', position: 100 },
      { axis: 'y', position: 200 }
    ]);
  });
});

describe('resizeRect', () => {
  const start = rect(100, 100, 200, 100);
  const delta = { dx: 30, dy: 20 };

  it.each<[Handle, Rect]>([
    ['e', rect(100, 100, 230, 100)],
    ['w', rect(130, 100, 170, 100)],
    ['n', rect(100, 120, 200, 80)],
    ['s', rect(100, 100, 200, 120)],
    ['ne', rect(100, 120, 230, 80)],
    ['nw', rect(130, 120, 170, 80)],
    ['se', rect(100, 100, 230, 120)],
    ['sw', rect(130, 100, 170, 120)]
  ])('resizes from the %s handle', (handle, expected) => {
    expect(resizeRect(start, handle, delta, 20)).toEqual(expected);
  });

  it('clamps width and keeps the opposite edge fixed when shrinking from the east', () => {
    const result = resizeRect(rect(100, 100, 30, 100), 'e', { dx: -50, dy: 0 }, 20);

    expect(result).toEqual(rect(100, 100, 20, 100));
  });

  it('clamps width and adjusts the origin when shrinking from the west', () => {
    const result = resizeRect(rect(100, 100, 30, 100), 'w', { dx: 50, dy: 0 }, 20);

    expect(result).toEqual(rect(110, 100, 20, 100));
  });

  it('clamps height and adjusts the origin when shrinking from the north', () => {
    const result = resizeRect(rect(100, 100, 200, 30), 'n', { dx: 0, dy: 50 }, 20);

    expect(result).toEqual(rect(100, 110, 200, 20));
  });

  it('grows from west and north while moving the origin', () => {
    const result = resizeRect(rect(100, 100, 200, 100), 'nw', { dx: -30, dy: -20 }, 20);

    expect(result).toEqual(rect(70, 80, 230, 120));
  });
});

describe('nudge', () => {
  it('moves a rect inside the bounds', () => {
    expect(nudge(rect(100, 100, 100, 50), 10, -10, SLIDE)).toEqual(
      rect(110, 90, 100, 50)
    );
  });

  it('clamps at the left and top slide edges', () => {
    expect(nudge(rect(10, 10, 100, 50), -100, -100, SLIDE)).toEqual(
      rect(0, 0, 100, 50)
    );
  });

  it('clamps at the right and bottom slide edges', () => {
    expect(nudge(rect(1400, 800, 100, 50), 500, 500, SLIDE)).toEqual(
      rect(1500, 850, 100, 50)
    );
  });

  it('respects a bounds origin that is not zero', () => {
    const bounds = rect(50, 20, 300, 200);

    expect(nudge(rect(50, 20, 100, 50), -10, -10, bounds)).toEqual(
      rect(50, 20, 100, 50)
    );
    expect(nudge(rect(50, 20, 100, 50), 1000, 1000, bounds)).toEqual(
      rect(250, 170, 100, 50)
    );
  });
});

describe('rotatePoint', () => {
  const center = { x: 100, y: 100 };

  it('rotates a point a quarter turn in screen coordinates', () => {
    const result = rotatePoint({ x: 110, y: 100 }, center, Math.PI / 2);

    expect(result.x).toBeCloseTo(100, 10);
    expect(result.y).toBeCloseTo(110, 10);
  });

  it('returns the same point for a zero rotation', () => {
    expect(rotatePoint({ x: 130, y: 70 }, center, 0)).toEqual({ x: 130, y: 70 });
  });

  it('rotates a half turn across the center', () => {
    const result = rotatePoint({ x: 110, y: 100 }, center, Math.PI);

    expect(result.x).toBeCloseTo(90, 10);
    expect(result.y).toBeCloseTo(100, 10);
  });
});

describe('normalizeAngle', () => {
  it('normalizes negative angles into [0, 360)', () => {
    expect(normalizeAngle(-90)).toBe(270);
    expect(normalizeAngle(-450)).toBe(270);
    expect(normalizeAngle(-0.5)).toBe(359.5);
  });

  it('normalizes angles at or above a full turn into [0, 360)', () => {
    expect(normalizeAngle(360)).toBe(0);
    expect(normalizeAngle(450)).toBe(90);
    expect(normalizeAngle(720.5)).toBe(0.5);
  });

  it('keeps in-range angles unchanged', () => {
    expect(normalizeAngle(0)).toBe(0);
    expect(normalizeAngle(180)).toBe(180);
  });
});
