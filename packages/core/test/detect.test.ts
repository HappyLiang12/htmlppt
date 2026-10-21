import { describe, expect, it } from 'vitest';
import { detectSlides, readCanvasSize } from '../src/detect.js';
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

  it('treats an empty data-slide-id as absent and generates the id', () => {
    const doc = documentFor(`
      <div data-slide-id="">empty</div>
      <div data-slide-id="explicit">explicit</div>
    `);

    const slides = detectSlides(doc);

    expect(slides.map((slide) => slide.id)).toEqual(['s1', 'explicit']);
    expect(slides.map((slide) => slide.hasId)).toEqual([false, true]);
  });

  it('treats a whitespace-only data-slide-id as absent', () => {
    const doc = documentFor(`<section class="slide" data-slide-id="   "></section>`);

    const slides = detectSlides(doc);

    expect(slides[0]).toMatchObject({ id: 's1', hasId: false });
  });

  it('prefers size attributes over inline styles', () => {
    const doc = documentFor(
      `<section class="slide" data-width="800" data-height="600" style="width:1280px;height:720px"></section>`
    );

    expect(detectSlides(doc)[0]).toMatchObject({ width: 800, height: 600 });
  });

  it('accepts a case-insensitive px suffix on size attributes', () => {
    const doc = documentFor(
      `<section class="slide" data-width="800px" data-height="600PX"></section>`
    );

    expect(detectSlides(doc)[0]).toMatchObject({ width: 800, height: 600 });
  });

  it('uses the last inline style declaration regardless of case', () => {
    const doc = documentFor(`
      <section class="slide" style="WIDTH:1280PX; width:800px"></section>
      <section class="slide" style="width:1280px; WIDTH:800PX"></section>
    `);

    expect(detectSlides(doc).map((slide) => slide.width)).toEqual([800, 800]);
  });

  it('reads uppercase inline style properties and units', () => {
    const doc = documentFor(
      `<section class="slide" style="WIDTH:1280PX;HEIGHT:720PX"></section>`
    );

    expect(detectSlides(doc)[0]).toMatchObject({ width: 1280, height: 720 });
  });

  it('falls through to style and defaults for invalid size attributes', () => {
    const doc = documentFor(`
      <section class="slide" data-width="0" style="width:1280px"></section>
      <section class="slide" data-width="abc"></section>
    `);

    const slides = detectSlides(doc);

    expect(slides[0].width).toBe(1280);
    expect(slides[1].width).toBe(1600);
  });

  it('rejects malformed numeric size attributes and inline styles', () => {
    const doc = documentFor(`
      <section class="slide" data-width="1.2.3"></section>
      <section class="slide" style="width: 10..5px"></section>
    `);

    expect(detectSlides(doc).map((slide) => slide.width)).toEqual([1600, 1600]);
  });

  it('rejects trailing-dot size forms', () => {
    const doc = documentFor(`
      <section class="slide" data-width="10."></section>
      <section class="slide" style="width: 10.px"></section>
    `);

    expect(detectSlides(doc).map((slide) => slide.width)).toEqual([1600, 1600]);
  });

  it('accepts decimal sizes with and without a px suffix', () => {
    const doc = documentFor(`
      <section class="slide" data-width="1600.5px"></section>
      <section class="slide" data-width=".5px"></section>
      <section class="slide" data-width="1600"></section>
    `);

    expect(detectSlides(doc).map((slide) => slide.width)).toEqual([1600.5, 0.5, 1600]);
  });

  it('rejects zero and negative size attributes', () => {
    const doc = documentFor(`
      <section class="slide" data-height="0"></section>
      <section class="slide" data-height="-5"></section>
    `);

    const slides = detectSlides(doc);

    expect(slides.map((slide) => slide.height)).toEqual([900, 900]);
    expect(slides.map((slide) => slide.heightValid)).toEqual([false, false]);
  });
});

describe('readCanvasSize', () => {
  const canvasFor = (attributes: string) => {
    const doc = documentFor(`<section ${attributes}></section>`);
    const element = doc.querySelector('section');
    if (!element) throw new Error('Missing section element.');
    return readCanvasSize(element);
  };

  it('reports validity for missing, valid, and malformed attributes', () => {
    expect(canvasFor('')).toEqual({
      width: 1600,
      height: 900,
      widthValid: true,
      heightValid: true
    });

    expect(canvasFor('data-width="1600.5" data-height="900"')).toEqual({
      width: 1600.5,
      height: 900,
      widthValid: true,
      heightValid: true
    });

    expect(canvasFor('data-width="1.2.3" data-height="0"')).toEqual({
      width: 1600,
      height: 900,
      widthValid: false,
      heightValid: false
    });
  });
});
