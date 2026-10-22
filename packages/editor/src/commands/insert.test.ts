import { beforeEach, describe, expect, it } from 'vitest';
import { defaultInsertRect, prepareInsertion } from './insert';

const TINY_PNG =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

function slide(): Element {
  document.body.innerHTML =
    '<section data-slide-id="s1" data-width="1600" data-height="900"></section>';
  return document.querySelector('[data-slide-id]')!;
}

beforeEach(() => {
  document.body.innerHTML = '';
});

describe('defaultInsertRect', () => {
  it('centers each kind with its default size', () => {
    expect(defaultInsertRect({ width: 1600, height: 900 }, 'text')).toEqual({
      x: 560,
      y: 390,
      width: 480,
      height: 120
    });
    expect(defaultInsertRect({ width: 1600, height: 900 }, 'shape')).toEqual({
      x: 640,
      y: 350,
      width: 320,
      height: 200
    });
    expect(defaultInsertRect({ width: 1600, height: 900 }, 'image')).toEqual({
      x: 560,
      y: 315,
      width: 480,
      height: 270
    });
  });

  it('never produces negative coordinates on a small canvas', () => {
    expect(defaultInsertRect({ width: 300, height: 100 }, 'text')).toMatchObject({
      x: 0,
      y: 0
    });
  });
});

describe('prepareInsertion', () => {
  it('prepares a text box with real text', async () => {
    const prepared = await prepareInsertion({ kind: 'text' }, { width: 1600, height: 900 });
    const element = prepared.apply(slide());

    expect(element.textContent).toBe('新文字方塊');
    expect(element.getAttribute('data-ppt-el')).toBe('e1');
  });

  it('prepares a shape at the centered rect', async () => {
    const prepared = await prepareInsertion(
      { kind: 'shape', shape: 'ellipse' },
      { width: 1600, height: 900 }
    );
    const element = prepared.apply(slide()) as HTMLElement;

    expect(element.style.borderRadius).toBe('50%');
    expect(element.style.left).toBe('640px');
    expect(element.style.top).toBe('350px');
  });

  it('accepts an absolute image URL', async () => {
    const prepared = await prepareInsertion(
      { kind: 'image', url: 'https://example.com/a.png' },
      { width: 1600, height: 900 }
    );
    const element = prepared.apply(slide()) as HTMLImageElement;

    expect(element.tagName).toBe('IMG');
    expect(element.getAttribute('src')).toBe('https://example.com/a.png');
  });

  it('rejects an unsafe image URL before touching the slide', async () => {
    await expect(
      prepareInsertion(
        { kind: 'image', url: 'javascript:alert(1)' },
        { width: 1600, height: 900 }
      )
    ).rejects.toThrow(/image/i);
  });

  it('reads a local image File into a data URL', async () => {
    const bytes = Uint8Array.from(atob(TINY_PNG), (char) => char.charCodeAt(0));
    const file = new File([bytes], 'pixel.png', { type: 'image/png' });

    const prepared = await prepareInsertion(
      { kind: 'image', file },
      { width: 1600, height: 900 }
    );
    const element = prepared.apply(slide()) as HTMLImageElement;

    expect(element.getAttribute('src')).toBe(`data:image/png;base64,${TINY_PNG}`);
  });
});
