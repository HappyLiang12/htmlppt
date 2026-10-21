import {
  detectSlides,
  serializeDeck,
  type SlideInfo
} from '@htmlppt/core';

export const EDITING_ATTRIBUTE = 'data-ppt-editing';

const BASE_STYLE = `
html, body { margin: 0 !important; padding: 0 !important; overflow: hidden !important; }
[data-slide-id] { margin: 0 !important; }
`;

export function parseDeck(html: string): Document {
  return new DOMParser().parseFromString(html, 'text/html');
}

function escapeAttribute(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;');
}

function attributesOf(element: Element): string {
  return Array.from(element.attributes)
    .map((attribute) => {
      const value = escapeAttribute(attribute.value);
      return ` ${attribute.name}="${value}"`;
    })
    .join('');
}

function openTag(element: Element): string {
  return `<${element.tagName.toLowerCase()}${attributesOf(element)}>`;
}

function closeTag(element: Element): string {
  return `</${element.tagName.toLowerCase()}>`;
}

function ancestorsOf(doc: Document, element: Element): Element[] {
  const ancestors: Element[] = [];
  let current = element.parentElement;
  while (current && current !== doc.body) {
    ancestors.unshift(current);
    current = current.parentElement;
  }
  return ancestors;
}

export function buildSlideSrcDoc(doc: Document, slide: SlideInfo): string {
  const bodyAttributes = doc.body ? attributesOf(doc.body) : '';
  let content: string;
  if (slide.element.tagName === 'BODY') {
    content = slide.element.innerHTML;
  } else {
    const ancestors = ancestorsOf(doc, slide.element);
    const open = ancestors.map(openTag).join('');
    const close = [...ancestors].reverse().map(closeTag).join('');
    content = `${open}${slide.element.outerHTML}${close}`;
  }
  return `<!doctype html><html><head>${doc.head.innerHTML}<style data-ppt-editor-base>${BASE_STYLE}</style></head><body${bodyAttributes}>${content}</body></html>`;
}

function findFrameSlide(
  doc: Document,
  slide: SlideInfo,
  frameDocument: Document
): Element | null {
  if (slide.element.tagName === 'BODY') {
    return frameDocument.body;
  }
  const path = [...ancestorsOf(doc, slide.element), slide.element];
  let current: Element | null = frameDocument.body;
  for (const expected of path) {
    current = current?.firstElementChild ?? null;
    if (!current || current.tagName !== expected.tagName) {
      return null;
    }
  }
  return current;
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

  const frameSlide = findFrameSlide(doc, slide, frameDocument);
  if (!frameSlide) throw new Error('Slide is missing from the editor frame.');

  frameSlide
    .querySelectorAll(`[${EDITING_ATTRIBUTE}]`)
    .forEach((element) => {
      element.removeAttribute('contenteditable');
      element.removeAttribute(EDITING_ATTRIBUTE);
    });

  if (slide.element.tagName === 'BODY') {
    slide.element.innerHTML = frameSlide.innerHTML;
  } else {
    slide.element.outerHTML = frameSlide.outerHTML;
  }

  return serializeDeck(doc);
}
