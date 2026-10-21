import { describe, expect, it } from 'vitest';
import { getOutline, readSlide } from '../src/outline.js';
import { parseDeckHtml } from '../src/node.js';

const source = `<!doctype html><html><head><title> Outline deck </title></head><body>
<section data-slide-id="s1" data-width="1280" data-height="720" data-ppt-transition="fade">
  <h1 data-ppt-el="e1" class="title big">Hello
    world</h1>
  <aside data-ppt-notes hidden>Speaker note</aside>
  <div data-ppt-group data-ppt-el="e2"><span>Grouped</span></div>
</section>
<section data-slide-id="s2" data-width="1280" data-height="720"><p>Second</p></section>
<script data-ppt-runtime="1"></script>
</body></html>`;

describe('getOutline', () => {
  it('reports deck and slide metadata in document order', () => {
    const outline = getOutline(parseDeckHtml(source));

    expect(outline).toMatchObject({
      title: 'Outline deck',
      width: 1280,
      height: 720,
      slideCount: 2,
      runtime: true
    });
    expect(outline.slides[0]).toMatchObject({
      id: 's1',
      index: 0,
      transition: 'fade',
      notes: 'Speaker note'
    });
    expect(outline.slides[0].elements).toEqual([
      {
        id: 'e1',
        tag: 'h1',
        path: [0],
        text: 'Hello world',
        classes: ['title', 'big'],
        group: false
      },
      {
        id: 'e2',
        tag: 'div',
        path: [2],
        text: 'Grouped',
        classes: [],
        group: true
      }
    ]);
    expect(outline.slides[1].elements[0]).toMatchObject({
      id: null,
      tag: 'p',
      path: [0],
      text: 'Second'
    });
  });

  it('truncates long text summaries to 120 characters', () => {
    const doc = parseDeckHtml(
      `<!doctype html><html><head><title>T</title></head><body><section data-slide-id="s1"><p>${'x'.repeat(200)}</p></section></body></html>`
    );
    const text = getOutline(doc).slides[0].elements[0].text;
    expect(text).toHaveLength(120);
    expect(text.endsWith('...')).toBe(true);
  });

  it('describes the body fallback', () => {
    const doc = parseDeckHtml(
      '<!doctype html><html><head><title>T</title></head><body><h1>Body</h1></body></html>'
    );
    const outline = getOutline(doc);
    expect(outline.slides).toHaveLength(1);
    expect(outline.slides[0].id).toBe('body');
    expect(outline.slides[0].elements[0].tag).toBe('h1');
  });
});

describe('readSlide', () => {
  it('returns the slide html, notes, transition, and canvas', () => {
    const slide = readSlide(parseDeckHtml(source), 's1');

    expect(slide).toMatchObject({
      id: 's1',
      index: 0,
      notes: 'Speaker note',
      transition: 'fade',
      width: 1280,
      height: 720
    });
    expect(slide.html).toContain('data-slide-id="s1"');
    expect(slide.html).toContain('data-ppt-notes');
  });

  it('throws for an unknown slide', () => {
    expect(() => readSlide(parseDeckHtml(source), 'missing')).toThrow(
      'Slide "missing" was not found.'
    );
  });
});
