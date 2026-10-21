import { serializeDeck, type SlideInfo } from '@htmlppt/core';

const BASE_STYLE = `
html, body { margin: 0 !important; padding: 0 !important; overflow: hidden !important; background: transparent !important; }
[data-slide-id] { margin: 0 !important; }
`;

export function parseDeck(html: string): Document {
  return new DOMParser().parseFromString(html, 'text/html');
}

export function buildSlideSrcDoc(doc: Document, slide: SlideInfo): string {
  return `<!doctype html><html><head>${doc.head.innerHTML}<style data-ppt-editor-base>${BASE_STYLE}</style></head><body>${slide.element.outerHTML}</body></html>`;
}

export function commitSlide(
  doc: Document,
  slideId: string,
  frameDocument: Document
): string {
  const current = frameDocument.querySelector('[data-slide-id]');
  if (!current) throw new Error('Slide is missing from the editor frame.');

  current
    .querySelectorAll('[contenteditable]')
    .forEach((element) => element.removeAttribute('contenteditable'));

  const target = doc.querySelector(
    `[data-slide-id="${CSS.escape(slideId)}"]`
  );
  if (!target) throw new Error(`Slide ${slideId} is missing from the deck.`);

  target.outerHTML = current.outerHTML;
  return serializeDeck(doc);
}
