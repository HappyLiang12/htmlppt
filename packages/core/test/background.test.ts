import { describe, expect, it } from 'vitest';
import { DeckMutationError, setSlideBackground } from '../src/index.js';
import { parseDeckHtml } from '../src/node.js';

const source = `<!doctype html><html><head><title>Background deck</title></head><body>
<section data-slide-id="s1" data-width="1280" data-height="720" style="color: red; background: #ffffff; background-image: url(old.png)">
  <h1 data-ppt-el="e1">Title</h1>
</section>
<section data-slide-id="s2" data-width="1280" data-height="720"></section>
</body></html>`;

function slideOf(doc: Document, id = 's1'): HTMLElement {
  return doc.querySelector(`[data-slide-id="${id}"]`) as HTMLElement;
}

function mutationError(action: () => unknown): DeckMutationError {
  try {
    action();
  } catch (error) {
    if (error instanceof DeckMutationError) return error;
    throw error;
  }
  throw new Error('Expected a DeckMutationError.');
}

describe('setSlideBackground', () => {
  it('sets a background color and clears a previous background image', () => {
    const doc = parseDeckHtml(source);

    setSlideBackground(doc, 's1', { color: '#123456' });

    const slide = slideOf(doc);
    expect(slide.style.getPropertyValue('background')).toBe('#123456');
    expect(slide.style.getPropertyValue('background-image')).toBe('');
    expect(slide.style.getPropertyValue('color')).toBe('red');
  });

  it('sets a gradient and clears a previous background color', () => {
    const doc = parseDeckHtml(source);

    setSlideBackground(doc, 's1', {
      gradient: 'linear-gradient(135deg, #fff, #000)'
    });

    const slide = slideOf(doc);
    expect(slide.style.getPropertyValue('background')).toBe('');
    expect(slide.style.getPropertyValue('background-image')).toBe(
      'linear-gradient(135deg, #fff, #000)'
    );
  });

  it('sets an image as a quoted url and clears a previous background color', () => {
    const doc = parseDeckHtml(source);

    setSlideBackground(doc, 's1', { image: 'https://example.com/bg.png' });

    const slide = slideOf(doc);
    expect(slide.style.getPropertyValue('background')).toBe('');
    expect(slide.style.getPropertyValue('background-image')).toBe(
      'url("https://example.com/bg.png")'
    );
  });

  it('keeps an explicit url() image expression as authored', () => {
    const doc = parseDeckHtml(source);

    setSlideBackground(doc, 's1', { image: 'url(data:image/png;base64,AAAA)' });

    expect(slideOf(doc).style.getPropertyValue('background-image')).toBe(
      'url(data:image/png;base64,AAAA)'
    );
  });

  it('switches between color, gradient, and image without leaking the previous value', () => {
    const doc = parseDeckHtml(source);

    setSlideBackground(doc, 's1', { color: '#ff0000' });
    setSlideBackground(doc, 's1', { gradient: 'linear-gradient(red, blue)' });
    expect(slideOf(doc).style.getPropertyValue('background')).toBe('');
    expect(slideOf(doc).style.getPropertyValue('background-image')).toBe(
      'linear-gradient(red, blue)'
    );

    setSlideBackground(doc, 's1', { color: '#00ff00' });
    expect(slideOf(doc).style.getPropertyValue('background')).toBe('#00ff00');
    expect(slideOf(doc).style.getPropertyValue('background-image')).toBe('');
  });

  it('removes an empty style attribute after clearing inherited values', () => {
    const doc = parseDeckHtml(
      `<!doctype html><html><head><title>T</title></head><body>
<section data-slide-id="s1" style="background-image: url(old.png)"></section>
</body></html>`
    );

    setSlideBackground(doc, 's1', { color: '#000000' });

    const slide = slideOf(doc);
    expect(slide.getAttribute('style')).toBe('background:#000000');
  });

  it('rejects zero or multiple fields and empty values without changing the slide', () => {
    const doc = parseDeckHtml(source);
    const before = slideOf(doc).getAttribute('style');

    expect(mutationError(() => setSlideBackground(doc, 's1', {}))).toMatchObject({
      code: 'invalid-background'
    });
    expect(
      mutationError(() =>
        setSlideBackground(doc, 's1', {
          color: '#ffffff',
          gradient: 'linear-gradient(red, blue)'
        })
      )
    ).toMatchObject({ code: 'invalid-background' });
    expect(
      mutationError(() => setSlideBackground(doc, 's1', { color: '   ' }))
    ).toMatchObject({ code: 'invalid-background' });
    expect(
      mutationError(() =>
        setSlideBackground(doc, 's1', {
          color: '#ffffff',
          border: '1px solid red'
        } as never)
      )
    ).toMatchObject({ code: 'invalid-background' });

    expect(slideOf(doc).getAttribute('style')).toBe(before);
  });

  it('throws slide-not-found for an unknown slide', () => {
    expect(mutationError(() => setSlideBackground(parseDeckHtml(source), 'missing', { color: '#000' }))).toMatchObject(
      { code: 'slide-not-found' }
    );
  });
});
