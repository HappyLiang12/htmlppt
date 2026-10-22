// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from 'vitest';
import {
  imageCropOf,
  readShapeAppearance,
  replaceImageSource,
  setImageAlt,
  setImageCrop,
  setShapeAppearance,
  setShapeText
} from '../src/appearance.js';
import { insertImage, insertShape } from '../src/insert.js';

const TINY_PNG =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
const TINY_PNG_URL = `data:image/png;base64,${TINY_PNG}`;

const rect = { x: 10, y: 20, width: 200, height: 100 };

function slide(): Element {
  document.body.innerHTML =
    '<section data-slide-id="s1" data-width="1600" data-height="900"></section>';
  return document.querySelector('[data-slide-id]')!;
}

beforeEach(() => {
  document.body.innerHTML = '';
});

describe('setShapeAppearance', () => {
  it('updates fill, border, radius, and opacity on div shapes', () => {
    const shape = insertShape(slide(), { ...rect, shape: 'rect' }) as HTMLElement;

    setShapeAppearance(shape, {
      fill: '#ff0000',
      stroke: '#001122',
      strokeWidth: 4,
      radius: 16,
      opacity: 0.5
    });

    expect(shape.style.background).toBe('rgb(255, 0, 0)');
    expect(shape.style.border).toContain('4px solid');
    expect(shape.style.borderRadius).toBe('16px');
    expect(shape.style.opacity).toBe('0.5');

    setShapeAppearance(shape, { fill: null, stroke: null, radius: null, opacity: null });
    expect(shape.style.background).toBe('');
    expect(shape.style.border).toBe('');
    expect(shape.style.borderRadius).toBe('');
    expect(shape.style.opacity).toBe('');
  });

  it('updates fill and stroke attributes on SVG shapes', () => {
    const shape = insertShape(slide(), {
      ...rect,
      shape: 'triangle',
      fill: '#00ff00',
      stroke: '#112233'
    });

    setShapeAppearance(shape, {
      fill: '#0000ff',
      stroke: '#ff00ff',
      strokeWidth: 3,
      opacity: 0.25
    });

    const polygon = shape.querySelector('polygon')!;
    expect(polygon.getAttribute('fill')).toBe('#0000ff');
    expect(polygon.getAttribute('stroke')).toBe('#ff00ff');
    expect(polygon.getAttribute('stroke-width')).toBe('3');
    expect((shape as SVGElement).style.opacity).toBe('0.25');
  });

  it('rejects invalid values without partial application', () => {
    const shape = insertShape(slide(), {
      ...rect,
      shape: 'rect',
      fill: '#4f7cff'
    }) as HTMLElement;

    expect(() => setShapeAppearance(shape, { opacity: 2 })).toThrow(/Opacity/);
    expect(() => setShapeAppearance(shape, { strokeWidth: -1 })).toThrow(
      /Stroke width/
    );
    expect(() => setShapeAppearance(shape, { fill: 'url(https://x/y.png)' })).toThrow(
      /URL/
    );
    expect(shape.style.background).toBe('rgb(79, 124, 255)');
  });

  it('reads back the appearance that was applied', () => {
    const shape = insertShape(slide(), { ...rect, shape: 'rect' }) as HTMLElement;
    setShapeAppearance(shape, {
      fill: '#123456',
      stroke: '#654321',
      strokeWidth: 2,
      radius: 8,
      opacity: 0.75
    });

    expect(readShapeAppearance(shape)).toMatchObject({
      strokeWidth: '2px',
      radius: '8px',
      opacity: '0.75'
    });
  });
});

describe('setShapeText', () => {
  it('sets and clears text on div shapes and SVG labels', () => {
    const div = insertShape(slide(), { ...rect, shape: 'rect' });
    setShapeText(div, 'Hello');
    expect(div.textContent).toBe('Hello');
    setShapeText(div, '');
    expect(div.textContent).toBe('');

    const svg = insertShape(slide(), { ...rect, shape: 'arrow' });
    setShapeText(svg, 'Next');
    expect(svg.querySelector('text')?.textContent).toBe('Next');
    setShapeText(svg, '');
    expect(svg.querySelector('text')).toBeNull();
  });

  it('rejects images', () => {
    const image = insertImage(slide(), { ...rect, source: TINY_PNG_URL });
    expect(() => setShapeText(image, 'x')).toThrow(/Images/);
  });
});

describe('image editing', () => {
  it('replaces the source with a validated image', () => {
    const image = insertImage(slide(), { ...rect, source: TINY_PNG_URL });
    replaceImageSource(image, 'https://example.com/next.png');
    expect(image.getAttribute('src')).toBe('https://example.com/next.png');
    expect(() => replaceImageSource(image, 'javascript:alert(1)')).toThrow(/image/i);
    expect(image.getAttribute('src')).toBe('https://example.com/next.png');
  });

  it('sets normalized alt text and enforces a length limit', () => {
    const image = insertImage(slide(), { ...rect, source: TINY_PNG_URL });
    setImageAlt(image, '  Two\nlines  ');
    expect(image.getAttribute('alt')).toBe('Two lines');
    expect(() => setImageAlt(image, 'x'.repeat(1001))).toThrow(/1000/);
  });

  it('applies and clears percentage crop insets', () => {
    const image = insertImage(slide(), { ...rect, source: TINY_PNG_URL }) as HTMLImageElement;

    setImageCrop(image, { top: 10, right: 5, bottom: 0, left: 2.5 });

    expect(imageCropOf(image)).toEqual({ top: 10, right: 5, bottom: 0, left: 2.5 });
    expect(image.getAttribute('data-ppt-crop')).toBe('10 5 0 2.5');
    expect(image.style.clipPath).toBe('inset(10% 5% 0% 2.5%)');

    setImageCrop(image, null);
    expect(imageCropOf(image)).toBeNull();
    expect(image.hasAttribute('data-ppt-crop')).toBe(false);
    expect(image.style.clipPath).toBe('');
  });

  it('rejects impossible crops before mutating', () => {
    const image = insertImage(slide(), { ...rect, source: TINY_PNG_URL }) as HTMLImageElement;
    setImageCrop(image, { top: 10, right: 0, bottom: 0, left: 0 });

    expect(() => setImageCrop(image, { top: 60, right: 0, bottom: 40, left: 0 })).toThrow(
      /no visible image/
    );
    expect(() => setImageCrop(image, { top: -1, right: 0, bottom: 0, left: 0 })).toThrow(
      /between 0 and 90/
    );
    expect(imageCropOf(image)).toEqual({ top: 10, right: 0, bottom: 0, left: 0 });
  });
});
