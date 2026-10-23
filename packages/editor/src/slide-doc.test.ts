import { detectSlides } from '@htmlppt/core';
import { describe, expect, it } from 'vitest';
import { buildSlideSrcDoc, frameSlideElement } from './slide-doc';

const DECK = `<!doctype html>
<html>
<body>
<main data-ppt-deck>
  <section class="slide" data-slide-id="s1" data-width="320" data-height="180">
    <h1 data-ppt-el="e1">One</h1>
  </section>
</main>
</body>
</html>`;

describe('frameSlideElement', () => {
  it('returns null while the preview document has no body yet', () => {
    const doc = new DOMParser().parseFromString(DECK, 'text/html');
    const slide = detectSlides(doc)[0]!;
    buildSlideSrcDoc(doc, slide);

    const loading = { body: null } as unknown as Document;

    expect(frameSlideElement(slide, loading)).toBeNull();
  });
});
