import { describe, expect, it } from 'vitest';
import {
  canvasCrop,
  metadataBox,
  miniatureCrop,
  sameMeasuredBox,
  stageBoxFor
} from './canvas-fit';

const slide = { id: 's1', width: 1600, height: 900 };
const measured = {
  id: 's1',
  box: { left: 0, top: 0, width: 1200, height: 900 }
};

describe('stageBoxFor', () => {
  it('falls back to metadata when nothing was measured', () => {
    expect(stageBoxFor(slide, null)).toEqual({
      left: 0,
      top: 0,
      width: 1600,
      height: 900
    });
  });

  it('uses the measured box for the same slide', () => {
    expect(stageBoxFor(slide, measured)).toEqual(measured.box);
  });

  it('rejects a measurement from another slide', () => {
    expect(stageBoxFor(slide, { ...measured, id: 's2' })).toEqual(
      metadataBox(slide)
    );
  });
});

describe('canvasCrop', () => {
  it('sizes the stage and translates the frame by the crop origin', () => {
    expect(
      canvasCrop({ left: 120, top: 40, width: 1200, height: 900 }, 0.5)
    ).toEqual({
      width: 600,
      height: 450,
      translateX: -60,
      translateY: -20
    });
  });

  it('is the identity for a metadata-sized box at zero offset', () => {
    expect(canvasCrop(metadataBox(slide), 0.72)).toEqual({
      width: 1152,
      height: 648,
      translateX: 0,
      translateY: 0
    });
  });
});

describe('miniatureCrop', () => {
  it('keeps the display width and follows the box aspect', () => {
    const crop = miniatureCrop(
      { left: 0, top: 0, width: 1200, height: 900 },
      152
    );
    expect(crop.scale).toBe(152 / 1200);
    expect(crop.height).toBeCloseTo(114, 6);
    expect(crop.translateX).toBe(0);
    expect(crop.translateY).toBe(0);
  });

  it('guards a zero-width box', () => {
    expect(
      miniatureCrop({ left: 0, top: 0, width: 0, height: 0 }, 152)
    ).toEqual({ scale: 1, height: 0, translateX: 0, translateY: 0 });
  });
});

describe('sameMeasuredBox', () => {
  it('compares id and sub-pixel geometry', () => {
    expect(sameMeasuredBox(measured, measured)).toBe(true);
    expect(sameMeasuredBox(measured, { ...measured, id: 's2' })).toBe(false);
    expect(
      sameMeasuredBox(measured, {
        ...measured,
        box: { ...measured.box, width: 1201 }
      })
    ).toBe(false);
    expect(
      sameMeasuredBox(measured, {
        ...measured,
        box: { ...measured.box, left: -0.2 }
      })
    ).toBe(true);
  });

  it('treats a missing measurement as unequal unless both are missing', () => {
    expect(sameMeasuredBox(null, null)).toBe(true);
    expect(sameMeasuredBox(measured, null)).toBe(false);
  });
});
