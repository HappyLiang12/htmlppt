import {
  detectSlides,
  serializeDeck,
  type SlideInfo
} from '@htmlppt/core';

const BASE_STYLE = `
html, body { margin: 0 !important; padding: 0 !important; overflow: hidden !important; background: transparent !important; }
[data-slide-id] { margin: 0 !important; }
`;

export function parseDeck(html: string): Document {
  return new DOMParser().parseFromString(html, 'text/html');
}

export function buildSlideSrcDoc(doc: Document, slide: SlideInfo): string {
  const slideHtml =
    slide.element.tagName === 'BODY'
      ? slide.element.innerHTML
      : slide.element.outerHTML;
  return `<!doctype html><html><head>${doc.head.innerHTML}<style data-ppt-editor-base>${BASE_STYLE}</style></head><body>${slideHtml}</body></html>`;
}

export function commitSlide(
  doc: Document,
  slideIndex: number,
  frameDocument: Document
): string {
  // Re-detect at commit time: a previous save replaced the slide element via
  // outerHTML, so a captured SlideInfo would point at a detached node.
  const slide = detectSlides(doc)[slideIndex];
  if (!slide) {
    throw new Error(`Slide ${slideIndex + 1} is missing from the deck.`);
  }

  const frameSlide =
    slide.element.tagName === 'BODY'
      ? frameDocument.body
      : frameDocument.body.firstElementChild;
  if (!frameSlide) throw new Error('Slide is missing from the editor frame.');

  frameSlide
    .querySelectorAll('[contenteditable]')
    .forEach((element) => element.removeAttribute('contenteditable'));

  if (slide.element.tagName === 'BODY') {
    slide.element.innerHTML = frameSlide.innerHTML;
  } else {
    slide.element.outerHTML = frameSlide.outerHTML;
  }

  return serializeDeck(doc);
}
