import { detectSlides } from '@htmlppt/core';
import { describe, expect, it } from 'vitest';
import {
  buildSlideSrcDoc,
  commitSlide,
  frameSlideElement,
  PREVIEW_SLIDE_ATTRIBUTE
} from './slide-doc';

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

const TWO_SLIDES = `<!doctype html>
<html><head><style>
.slide { display: none; }
.slide.active { display: flex; }
</style></head>
<body>
<main data-ppt-deck>
  <section class="slide active" data-slide-id="s1" data-width="320" data-height="180">
    <h1>One</h1>
  </section>
  <section class="slide" data-slide-id="s2" data-width="320" data-height="180" data-authored="keep">
    <h1>Two</h1>
  </section>
</main>
</body></html>`;

describe('preview marker', () => {
  it('marks the cloned slide even when markFrame is false', () => {
    const doc = new DOMParser().parseFromString(TWO_SLIDES, 'text/html');
    const slide = detectSlides(doc)[1]!;
    const html = buildSlideSrcDoc(doc, slide, { markFrame: false });
    const preview = new DOMParser().parseFromString(html, 'text/html');

    expect(
      preview.querySelector(`[${PREVIEW_SLIDE_ATTRIBUTE}]`)?.textContent
    ).toContain('Two');
  });

  it('marks the body fallback', () => {
    const doc = new DOMParser().parseFromString(
      '<!doctype html><html><body><h1>Only</h1></body></html>',
      'text/html'
    );
    const slide = detectSlides(doc)[0]!;
    const html = buildSlideSrcDoc(doc, slide);
    expect(html).toMatch(/<body[^>]*data-ppt-preview-slide/);
  });
});

describe('commit isolation', () => {
  it('drops reveal mutations and keeps authored root attributes', () => {
    const doc = new DOMParser().parseFromString(TWO_SLIDES, 'text/html');
    const slide = detectSlides(doc)[1]!;
    const html = buildSlideSrcDoc(doc, slide);
    const preview = new DOMParser().parseFromString(html, 'text/html');
    const cloned = preview.querySelector(
      `[${PREVIEW_SLIDE_ATTRIBUTE}]`
    ) as HTMLElement;
    cloned.classList.add('active');
    cloned.setAttribute('style', 'display:flex !important;opacity:1 !important');
    cloned.querySelector('h1')!.textContent = 'Two edited';

    const saved = commitSlide(doc, 1, preview);
    const savedDoc = new DOMParser().parseFromString(saved, 'text/html');
    const savedSlide = savedDoc.querySelector(
      'section[data-slide-id="s2"]'
    ) as HTMLElement;

    expect(savedSlide.className).toBe('slide');
    expect(savedSlide.getAttribute('style')).toBeNull();
    expect(savedSlide.hasAttribute(PREVIEW_SLIDE_ATTRIBUTE)).toBe(false);
    expect(savedSlide.getAttribute('data-authored')).toBe('keep');
    expect(savedSlide.textContent).toContain('Two edited');
    expect(
      savedDoc.querySelector('section[data-slide-id="s1"]')?.className
    ).toBe('slide active');
  });
});
