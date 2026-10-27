import { describe, expect, it, vi } from 'vitest';
import {
  measureElementBox,
  parseFitMode,
  readFitMode,
  sameBox,
  scaleFor,
  writeFitMode,
  PLAY_FIT_STORAGE_KEY
} from './play-fit';

const box = { left: 0, top: 0, width: 1200, height: 900 };
const viewport = { width: 1440, height: 900 };

describe('scaleFor', () => {
  it('fits inside and fills outside the viewport', () => {
    expect(scaleFor(box, viewport, 'fit')).toBeCloseTo(1);
    expect(scaleFor(box, viewport, 'fill')).toBeCloseTo(1.2);
  });

  it('falls back to 1 for invalid input', () => {
    expect(scaleFor({ ...box, width: 0 }, viewport, 'fit')).toBe(1);
    expect(scaleFor(box, { width: 0, height: 900 }, 'fill')).toBe(1);
  });
});

describe('fit preference', () => {
  it('parses only fill as fill and defaults to fit', () => {
    expect(parseFitMode('fill')).toBe('fill');
    expect(parseFitMode('fit')).toBe('fit');
    expect(parseFitMode('other')).toBe('fit');
    expect(parseFitMode(null)).toBe('fit');
  });

  it('reads and writes the stored mode with a safe fallback', () => {
    const getItem = vi.fn(() => 'fill');
    expect(readFitMode({ getItem })).toBe('fill');
    expect(getItem).toHaveBeenCalledWith(PLAY_FIT_STORAGE_KEY);

    const setItem = vi.fn();
    writeFitMode('fill', { setItem });
    expect(setItem).toHaveBeenCalledWith(PLAY_FIT_STORAGE_KEY, 'fill');

    const broken = {
      getItem: () => {
        throw new Error('blocked');
      }
    };
    expect(readFitMode(broken)).toBe('fit');
  });
});

describe('measureElementBox', () => {
  const rect = {
    left: 200,
    top: 0,
    width: 1200,
    height: 900,
    right: 1400,
    bottom: 900
  };

  it('measures a centered box inside the iframe viewport', () => {
    const element = {
      getBoundingClientRect: () => rect
    } as unknown as Element;
    expect(measureElementBox(element, { width: 1600, height: 900 })).toEqual({
      left: 200,
      top: 0,
      width: 1200,
      height: 900
    });
  });

  it('rejects boxes that overflow the iframe viewport', () => {
    const element = {
      getBoundingClientRect: () => rect
    } as unknown as Element;
    expect(measureElementBox(element, { width: 1000, height: 900 })).toBeNull();
    expect(measureElementBox(null, viewport)).toBeNull();
  });
});

describe('sameBox', () => {
  it('treats sub-pixel changes as equal', () => {
    expect(sameBox(box, { ...box, left: 0.2 })).toBe(true);
    expect(sameBox(box, { ...box, width: 1201 })).toBe(false);
    expect(sameBox(null, null)).toBe(true);
    expect(sameBox(box, null)).toBe(false);
  });
});
