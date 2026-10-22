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

  it('omits non-object tags from the element list', () => {
    const doc = parseDeckHtml(`<!doctype html><html><head><title>T</title></head><body>
<section data-slide-id="s1">
  <script>window.hidden = true;</script>
  <style>.hidden { color: red; }</style>
  <template><p>Template copy</p></template>
  <link rel="stylesheet" href="https://example.com/deck.css">
  <meta name="author" content="Hidden">
  <p data-ppt-el="e1">Kept</p>
</section>
</body></html>`);

    expect(getOutline(doc).slides[0].elements.map((element) => element.tag)).toEqual(['p']);
  });

  it('summarizes only text outside nested script, style, and template elements', () => {
    const doc = parseDeckHtml(`<!doctype html><html><head><title>T</title></head><body>
<section data-slide-id="s1">
  <div data-ppt-el="e1">Visible<script>hiddenScript()</script><style>.secret {}</style><template>Hidden template</template> copy</div>
</section>
</body></html>`);

    expect(getOutline(doc).slides[0].elements[0].text).toBe('Visible copy');
  });

  it('requires a script with a trimmed runtime marker value', () => {
    const invalid = parseDeckHtml(
      '<!doctype html><html><head><title>T</title></head><body><section data-slide-id="s1"></section><div data-ppt-runtime="1"></div></body></html>'
    );
    expect(getOutline(invalid).runtime).toBe(false);

    const padded = parseDeckHtml(
      '<!doctype html><html><head><title>T</title></head><body><section data-slide-id="s1"></section><script data-ppt-runtime=" 1 "></script></body></html>'
    );
    expect(getOutline(padded).runtime).toBe(true);
  });

  it('collapses notes whitespace and returns null for empty notes', () => {
    const doc = parseDeckHtml(`<!doctype html><html><head><title>T</title></head><body>
<section data-slide-id="s1"><aside data-ppt-notes hidden>  Speaker
  notes   here  </aside></section>
<section data-slide-id="s2"><aside data-ppt-notes hidden>   </aside></section>
</body></html>`);

    const outline = getOutline(doc);
    expect(outline.slides[0].notes).toBe('Speaker notes here');
    expect(outline.slides[1].notes).toBeNull();
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

  it('throws for an unknown slide with the exact message', () => {
    expect(() => readSlide(parseDeckHtml(source), 'missing')).toThrowError(
      new Error('Slide "missing" was not found.')
    );
  });

  it('resolves duplicate slide ids to the first slide', () => {
    const duplicate = parseDeckHtml(`<!doctype html><html><head><title>T</title></head><body>
<section data-slide-id="dup"><p>First</p></section>
<section data-slide-id="dup"><p>Second</p></section>
</body></html>`);

    const slide = readSlide(duplicate, 'dup');
    expect(slide.index).toBe(0);
    expect(slide.html).toContain('First');
    expect(slide.html).not.toContain('Second');
  });
});
