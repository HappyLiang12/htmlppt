import { describe, expect, it } from 'vitest';
import { RUNTIME_SOURCE } from '@htmlppt/runtime';
import { detectSlides } from '../src/detect.js';
import { parseDeckHtml } from '../src/node.js';
import { createDeckHtml } from '../src/template.js';
import { validateDeck } from '../src/validate.js';

describe('createDeckHtml', () => {
  it('creates a valid deck with the requested slide count', () => {
    const doc = parseDeckHtml(createDeckHtml({ title: 'Demo', slides: 3 }));

    expect(validateDeck(doc).valid).toBe(true);
    expect(detectSlides(doc).map((slide) => slide.id)).toEqual(['s1', 's2', 's3']);
    expect(doc.title).toBe('Demo');
  });

  it('escapes the title', () => {
    const html = createDeckHtml({ title: '<script>alert(1)</script>' });

    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
    expect(html).not.toContain('<script>alert(1)</script>');
  });

  it('embeds the runtime source exactly once', () => {
    const html = createDeckHtml();

    expect(RUNTIME_SOURCE).not.toMatch(/<\/script|<!--/i);

    const doc = parseDeckHtml(html);
    const scripts = doc.querySelectorAll('script[data-ppt-runtime="1"]');
    expect(scripts).toHaveLength(1);
    expect(scripts[0].textContent).toBe(RUNTIME_SOURCE);
  });

  it('renders the default title, slide count, and canvas size', () => {
    const doc = parseDeckHtml(createDeckHtml());

    expect(doc.title).toBe('Untitled deck');
    expect(doc.querySelector('[data-ppt-deck]')).not.toBeNull();
    expect(detectSlides(doc)).toHaveLength(2);

    const slides = Array.from(doc.querySelectorAll('[data-slide-id]'));
    expect(slides.map((slide) => slide.getAttribute('data-slide-id'))).toEqual(['s1', 's2']);
    for (const slide of slides) {
      expect(slide.getAttribute('data-width')).toBe('1600');
      expect(slide.getAttribute('data-height')).toBe('900');
    }
  });

  it('marks every heading and numbers the slides after the first', () => {
    const doc = parseDeckHtml(createDeckHtml({ title: 'Demo' }));
    const headings = Array.from(doc.querySelectorAll('[data-ppt-el]'));

    expect(headings.map((heading) => heading.getAttribute('data-ppt-el'))).toEqual(['e1', 'e2']);
    expect(headings[0]?.textContent).toBe('Demo');
    expect(headings[1]?.textContent).toBe('Demo — 2');
  });

  it('escapes the headings of the slides after the first', () => {
    const html = createDeckHtml({ title: '<b>x</b>' });
    const doc = parseDeckHtml(html);
    const heading = doc.querySelector('[data-ppt-el="e2"]');

    expect(heading?.textContent).toBe('<b>x</b> — 2');
    expect(heading?.outerHTML ?? '').not.toContain('<b>');
    expect(html).not.toContain('<b>');
  });

  it.each(['', '   '])('defaults an empty title %j to Untitled deck', (title) => {
    const doc = parseDeckHtml(createDeckHtml({ title }));

    expect(doc.title).toBe('Untitled deck');
    expect(doc.querySelector('[data-ppt-el="e1"]')?.textContent).toBe('Untitled deck');
  });

  it.each([
    { slides: 0, expected: 1 },
    { slides: -3, expected: 1 },
    { slides: Number.NaN, expected: 2 },
    { slides: Number.POSITIVE_INFINITY, expected: 2 },
    { slides: 2.9, expected: 2 }
  ])('normalizes slides: $slides to $expected slide(s)', ({ slides, expected }) => {
    const doc = parseDeckHtml(createDeckHtml({ slides }));

    expect(detectSlides(doc)).toHaveLength(expected);
  });

  it('clamps zero and negative slide counts to one slide element', () => {
    const zero = parseDeckHtml(createDeckHtml({ slides: 0 }));
    expect(zero.querySelectorAll('[data-slide-id]')).toHaveLength(1);
    const negative = parseDeckHtml(createDeckHtml({ slides: -3 }));
    expect(negative.querySelectorAll('[data-slide-id]')).toHaveLength(1);
  });

  it.each([
    { width: 0, height: 0 },
    { width: -1, height: Number.NaN },
    { width: Number.NaN, height: Number.POSITIVE_INFINITY }
  ])('falls back to 1600x900 for width: $width and height: $height', ({ width, height }) => {
    const html = createDeckHtml({ width, height });
    const doc = parseDeckHtml(html);

    for (const slide of Array.from(doc.querySelectorAll('[data-slide-id]'))) {
      expect(slide.getAttribute('data-width')).toBe('1600');
      expect(slide.getAttribute('data-height')).toBe('900');
    }
    expect(html).toContain('width: 1600px; height: 900px;');
  });

  it('truncates fractional canvas dimensions', () => {
    const html = createDeckHtml({ width: 1280.9, height: 720.9 });
    const doc = parseDeckHtml(html);

    for (const slide of Array.from(doc.querySelectorAll('[data-slide-id]'))) {
      expect(slide.getAttribute('data-width')).toBe('1280');
      expect(slide.getAttribute('data-height')).toBe('720');
    }
    expect(html).toContain('width: 1280px; height: 720px;');

    const subPixel = parseDeckHtml(createDeckHtml({ width: 0.5, height: 0.5 }));
    const subPixelSlide = subPixel.querySelector('[data-slide-id="s1"]');
    expect(subPixelSlide?.getAttribute('data-width')).toBe('1');
    expect(subPixelSlide?.getAttribute('data-height')).toBe('1');
  });

  it('hides every slide after the first until the runtime runs', () => {
    const html = createDeckHtml({ slides: 2 });

    expect(html).toContain(
      '@media screen {\n    [data-ppt-deck]:not([data-ppt-ready]) > [data-slide-id] ~ [data-slide-id] { display: none; }\n  }'
    );
    expect(html).toContain('@media print');
    expect(html).toContain('break-after: page');
    expect(html).not.toMatch(/display\s*:\s*block\s*!important/i);
  });
});

describe('validation negative rules', () => {
  const validate = (body: string) =>
    validateDeck(
      parseDeckHtml(
        `<!doctype html><html><head><title>Rules</title></head><body>${body}</body></html>`
      )
    );

  it('does not warn about application/ld+json script data', () => {
    const result = validate(
      '<section data-slide-id="s1"></section><script type="application/ld+json">{"@context":"https://schema.org"}</script>'
    );

    expect(result.warnings).not.toContainEqual(
      expect.objectContaining({ code: 'script-present' })
    );
  });

  it('does not warn about tel: or protocol-relative URLs', () => {
    const result = validate(
      '<section data-slide-id="s1"><a href="tel:+15551212">Call</a><a href="//example.com/deck">CDN</a></section>'
    );

    expect(result.warnings).not.toContainEqual(
      expect.objectContaining({ code: 'relative-asset' })
    );
  });

  it('locates a top-level non-runtime script at document scope', () => {
    const result = validate(
      '<section data-slide-id="s1"></section><script>window.x = 1;</script>'
    );

    expect(result.warnings).toContainEqual(
      expect.objectContaining({ code: 'script-present', location: 'document > script' })
    );
  });

  it('keeps a deck with warnings valid', () => {
    const result = validate(
      '<section data-slide-id="s1"></section><section data-slide-id="s2"></section>'
    );

    expect(result.warnings).toContainEqual(
      expect.objectContaining({ code: 'missing-runtime' })
    );
    expect(result.errors).toEqual([]);
    expect(result.valid).toBe(true);
  });
});
