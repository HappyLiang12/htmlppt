import {
  detectSlides,
  serializeDeck,
  type SlideInfo
} from '@htmlppt/core';

export const EDITING_ATTRIBUTE = 'data-ppt-editing';
export const FRAME_SLIDE_ATTRIBUTE = 'data-ppt-frame-slide';

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
    const frameSlide = slide.element.cloneNode(true) as Element;
    frameSlide.setAttribute(FRAME_SLIDE_ATTRIBUTE, '1');
    content = `${open}${frameSlide.outerHTML}${close}`;
  }
  return `<!doctype html><html><head>${doc.head.innerHTML}<style data-ppt-editor-base>${BASE_STYLE}</style></head><body${bodyAttributes}>${content}</body></html>`;
}

function findFrameSlide(
  slide: SlideInfo,
  frameDocument: Document
): Element | null {
  if (slide.element.tagName === 'BODY') {
    return frameDocument.body;
  }
  return frameDocument.querySelector(`[${FRAME_SLIDE_ATTRIBUTE}="1"]`);
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

  const frameSlide = findFrameSlide(slide, frameDocument);
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
    // Strip the preview marker from the serialized clone so the live frame
    // keeps it for queued follow-up commits.
    const serialized = frameSlide.cloneNode(true) as Element;
    serialized.removeAttribute(FRAME_SLIDE_ATTRIBUTE);
    slide.element.outerHTML = serialized.outerHTML;
  }

  return serializeDeck(doc);
}
