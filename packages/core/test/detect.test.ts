import { describe, expect, it } from 'vitest';
import { detectSlides } from '../src/detect.js';
import { parseDeckHtml } from '../src/node.js';

const documentFor = (body: string) =>
  parseDeckHtml(
    `<!doctype html><html><head><title>Deck</title></head><body>${body}</body></html>`
  );

describe('detectSlides', () => {
  it('prefers elements with data-slide-id and reads canvas attributes', () => {
    const doc = documentFor(`
      <div data-slide-id="intro" data-width="800" data-height="600"></div>
      <div data-slide-id="details"></div>
      <section class="slide"></section>
    `);

    const slides = detectSlides(doc);

    expect(slides.map((slide) => slide.id)).toEqual(['intro', 'details']);
    expect(slides[0]).toMatchObject({ hasId: true, width: 800, height: 600, index: 0 });
    expect(slides[1]).toMatchObject({ hasId: true, width: 1600, height: 900, index: 1 });
  });

  it('falls back to .slide elements and generates stable ids', () => {
    const doc = documentFor(`<div class="slide">one</div><div class="slide">two</div>`);

    const slides = detectSlides(doc);

    expect(slides.map((slide) => slide.id)).toEqual(['s1', 's2']);
    expect(slides.every((slide) => !slide.hasId)).toBe(true);
  });

  it('uses the largest sibling group of sections', () => {
    const doc = documentFor(`
      <div><section>lonely</section></div>
      <main><section>one</section><section>two</section></main>
    `);

    const slides = detectSlides(doc);

    expect(slides).toHaveLength(2);
    expect(slides.map((slide) => slide.element.textContent)).toEqual(['one', 'two']);
  });

  it('falls back to the body as a single slide', () => {
    const doc = documentFor(`<h1>Only page</h1>`);

    const slides = detectSlides(doc);

    expect(slides).toHaveLength(1);
    expect(slides[0]).toMatchObject({
      id: 'body',
      hasId: false,
      index: 0,
      width: 1600,
      height: 900
    });
  });

  it('reads canvas size from inline styles', () => {
    const doc = documentFor(
      `<section class="slide" data-slide-id="sized" style="width:1280px;height:720px"></section>`
    );

    expect(detectSlides(doc)[0]).toMatchObject({ width: 1280, height: 720 });
  });
});
