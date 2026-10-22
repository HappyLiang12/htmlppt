// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from 'vitest';
import { MAX_IMAGE_BYTES, imageSourceFromFile } from '../src/images.js';
import { insertImage, insertShape, insertTextBox } from '../src/insert.js';

const TINY_PNG =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
const TINY_PNG_URL = `data:image/png;base64,${TINY_PNG}`;

function slide(): Element {
  document.body.innerHTML =
    '<section data-slide-id="s1" data-width="1600" data-height="900"></section>';
  return document.querySelector('[data-slide-id]')!;
}

const rect = { x: 120, y: 80, width: 400, height: 200 };

beforeEach(() => {
  document.body.innerHTML = '';
});

describe('insertTextBox', () => {
  it('creates a top-level absolutely positioned text object with an id', () => {
    const root = slide();

    const element = insertTextBox(root, { ...rect, text: 'Hello <world>' });

    expect(element.parentElement).toBe(root);
    expect(element.tagName).toBe('DIV');
    expect(element.getAttribute('data-ppt-el')).toBe('e1');
    expect(element.textContent).toBe('Hello <world>');
    expect(element.querySelector('*')).toBeNull();
    const style = (element as HTMLElement).style;
    expect(style.position).toBe('absolute');
    expect(style.left).toBe('120px');
    expect(style.top).toBe('80px');
    expect(style.width).toBe('400px');
    expect(style.height).toBe('200px');
    expect(style.margin).toBe('0px');
  });

  it('assigns unique ids across insertions', () => {
    const root = slide();

    insertTextBox(root, { ...rect, text: 'One' });
    const second = insertShape(root, { ...rect, shape: 'rect' });

    expect(second.getAttribute('data-ppt-el')).toBe('e2');
  });

  it('rejects non-positive or non-finite geometry', () => {
    const root = slide();

    expect(() => insertTextBox(root, { ...rect, width: 0, text: 'x' })).toThrow(
      /positive/
    );
    expect(() =>
      insertTextBox(root, { ...rect, x: Number.NaN, text: 'x' })
    ).toThrow(/finite/);
    expect(root.children).toHaveLength(0);
  });
});

describe('insertShape', () => {
  it('creates deterministic rect and ellipse markup', () => {
    const first = slide();
    const rectElement = insertShape(first, {
      ...rect,
      shape: 'rect',
      fill: '#ff0000',
      stroke: '#000000',
      radius: 12
    }) as HTMLElement;

    expect(rectElement.style.background).toBe('rgb(255, 0, 0)');
    expect(rectElement.style.border).toContain('2px solid');
    expect(rectElement.style.borderRadius).toBe('12px');

    const second = slide();
    const ellipse = insertShape(second, {
      ...rect,
      shape: 'ellipse'
    }) as HTMLElement;
    expect(ellipse.style.borderRadius).toBe('50%');

    const a = insertShape(slide(), { ...rect, shape: 'rect', fill: '#123456' });
    const b = insertShape(slide(), { ...rect, shape: 'rect', fill: '#123456' });
    expect(a.outerHTML).toBe(b.outerHTML);
  });

  it('renders a line as a non-scaling svg', () => {
    const root = slide();

    const element = insertShape(root, {
      ...rect,
      shape: 'line',
      stroke: '#334455',
      strokeWidth: 6
    });

    expect(element.tagName.toLowerCase()).toBe('svg');
    const line = element.querySelector('line')!;
    expect(line.getAttribute('stroke')).toBe('#334455');
    expect(line.getAttribute('stroke-width')).toBe('6');
    expect(line.getAttribute('vector-effect')).toBe('non-scaling-stroke');
    expect(element.getAttribute('viewBox')).toBe('0 0 400 200');
    expect(element.getAttribute('data-ppt-el')).toBe('e1');
  });

  it('renders rounded rectangles, triangles, and arrows deterministically', () => {
    const rounded = insertShape(slide(), {
      ...rect,
      shape: 'rounded-rect'
    }) as HTMLElement;
    expect(rounded.style.borderRadius).toBe('24px');

    const triangleRoot = slide();
    const triangle = insertShape(triangleRoot, {
      ...rect,
      shape: 'triangle',
      fill: '#00ff00',
      stroke: '#112233'
    });
    expect(triangle.tagName.toLowerCase()).toBe('svg');
    const polygon = triangle.querySelector('polygon')!;
    expect(polygon.getAttribute('points')).toBe('200,0 400,200 0,200');
    expect(polygon.getAttribute('fill')).toBe('#00ff00');
    expect(polygon.getAttribute('stroke')).toBe('#112233');

    const arrowRoot = slide();
    const arrow = insertShape(arrowRoot, {
      ...rect,
      shape: 'arrow',
      stroke: '#445566',
      strokeWidth: 4
    });
    const line = arrow.querySelector('line')!;
    const head = arrow.querySelector('polygon')!;
    expect(line.getAttribute('stroke')).toBe('#445566');
    expect(line.getAttribute('x2')).toBe(String(400 - Math.min(400 * 0.3, 200 * 0.8, 48)));
    expect(head.getAttribute('fill')).toBe('#445566');
    expect(head.getAttribute('points')).toMatch(/^400,100 /);

    const a = insertShape(slide(), { ...rect, shape: 'arrow' });
    const b = insertShape(slide(), { ...rect, shape: 'arrow' });
    expect(a.outerHTML).toBe(b.outerHTML);
  });

  it('stores optional text inside div and SVG shapes', () => {
    const divShape = insertShape(slide(), {
      ...rect,
      shape: 'rect',
      text: 'Label'
    });
    expect(divShape.textContent).toBe('Label');

    const triangle = insertShape(slide(), {
      ...rect,
      shape: 'triangle',
      text: 'Tri'
    });
    const label = triangle.querySelector('text')!;
    expect(label.textContent).toBe('Tri');
    expect(label.getAttribute('text-anchor')).toBe('middle');
  });

  it('rejects unknown shape kinds', () => {
    const root = slide();
    expect(() =>
      insertShape(root, {
        ...rect,
        shape: 'hexagon' as 'rect'
      })
    ).toThrow(/Unsupported shape/);
  });
});

describe('insertImage', () => {
  it('inserts a data URL image with geometry and alt text', () => {
    const root = slide();

    const element = insertImage(root, {
      ...rect,
      source: TINY_PNG_URL,
      alt: 'Pixel'
    }) as HTMLImageElement;

    expect(element.tagName).toBe('IMG');
    expect(element.getAttribute('src')).toBe(TINY_PNG_URL);
    expect(element.getAttribute('alt')).toBe('Pixel');
    expect(element.style.objectFit).toBe('fill');
    expect(element.getAttribute('data-ppt-el')).toBe('e1');
  });

  it('accepts absolute http(s) URLs and rejects unsafe schemes', () => {
    const root = slide();
    expect(() =>
      insertImage(root, { ...rect, source: 'https://example.com/a.png' })
    ).not.toThrow();

    for (const source of [
      'javascript:alert(1)',
      'file:///etc/passwd',
      'data:text/html,<script>alert(1)</script>',
      'ftp://example.com/a.png',
      'relative/image.png'
    ]) {
      expect(() => insertImage(slide(), { ...rect, source })).toThrow(
        /image/i
      );
    }
  });

  it('rejects data URLs above the 8 MB limit', () => {
    const root = slide();
    const payload = 'A'.repeat(Math.ceil(((MAX_IMAGE_BYTES + 16) * 4) / 3));
    expect(() =>
      insertImage(root, {
        ...rect,
        source: `data:image/png;base64,${payload}`
      })
    ).toThrow(/8 MB/);
    expect(root.children).toHaveLength(0);
  });
});

describe('imageSourceFromFile', () => {
  it('reads a supported File into a data URL', async () => {
    const bytes = Uint8Array.from(atob(TINY_PNG), (char) => char.charCodeAt(0));
    const file = new File([bytes], 'pixel.png', { type: 'image/png' });

    const source = await imageSourceFromFile(file);

    expect(source).toBe(TINY_PNG_URL);
  });

  it('infers the MIME type from the filename when the File has none', async () => {
    const bytes = Uint8Array.from(atob(TINY_PNG), (char) => char.charCodeAt(0));
    const file = new File([bytes], 'pixel.webp', { type: '' });

    const source = await imageSourceFromFile(file);

    expect(source.startsWith('data:image/webp;base64,')).toBe(true);
  });

  it('rejects unsupported, empty, and oversized files', async () => {
    await expect(
      imageSourceFromFile(new File(['hello'], 'notes.txt', { type: 'text/plain' }))
    ).rejects.toThrow(/Unsupported image type/);
    await expect(
      imageSourceFromFile(new File([], 'empty.png', { type: 'image/png' }))
    ).rejects.toThrow(/empty/);
    await expect(
      imageSourceFromFile(
        new File([new Uint8Array(MAX_IMAGE_BYTES + 1)], 'huge.png', {
          type: 'image/png'
        })
      )
    ).rejects.toThrow(/8 MB/);
  });
});
