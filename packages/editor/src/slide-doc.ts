import {
  detectSlides,
  serializeDeck,
  type SlideInfo
} from '@htmlppt/core';

export const EDITING_ATTRIBUTE = 'data-ppt-editing';
export const FRAME_SLIDE_ATTRIBUTE = 'data-ppt-frame-slide';

// One preview is rendered at a time, so a module-level token is enough. A
// fresh value per srcDoc keeps authored markup from guessing the marker.
let frameSlideToken: string | null = null;

const BASE_STYLE = `
html, body { margin: 0 !important; padding: 0 !important; overflow: hidden !important; }
[data-slide-id] { margin: 0 !important; }
[data-ppt-notes] { display: none !important; }
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

export interface SlideSrcDocOptions {
  /**
   * Adds the preview marker that editor gestures resolve the live slide by.
   * Thumbnail and sorter previews are inert and must not rotate the token the
   * main canvas frame was built with.
   */
  markFrame?: boolean;
}

export function buildSlideSrcDoc(
  doc: Document,
  slide: SlideInfo,
  options: SlideSrcDocOptions = {}
): string {
  const markFrame = options.markFrame !== false;
  let frameToken: string | null = null;
  if (markFrame) {
    frameToken = crypto.randomUUID();
    frameSlideToken = frameToken;
  }
  const bodyAttributes = doc.body ? attributesOf(doc.body) : '';
  let content: string;
  if (slide.element.tagName === 'BODY') {
    content = slide.element.innerHTML;
  } else {
    const ancestors = ancestorsOf(doc, slide.element);
    const open = ancestors.map(openTag).join('');
    const close = [...ancestors].reverse().map(closeTag).join('');
    const frameSlide = slide.element.cloneNode(true) as Element;
    if (frameToken) {
      frameSlide.setAttribute(FRAME_SLIDE_ATTRIBUTE, frameToken);
    }
    content = `${open}${frameSlide.outerHTML}${close}`;
  }
  return `<!doctype html><html><head>${doc.head.innerHTML}<style data-ppt-editor-base>${BASE_STYLE}</style></head><body${bodyAttributes}>${content}</body></html>`;
}

function findFrameSlide(
  slide: SlideInfo,
  frameDocument: Document
): Element | null {
  // A reloading iframe can expose a document before its body exists.
  const body = frameDocument.body as HTMLElement | null;
  if (!body) return null;
  if (slide.element.tagName === 'BODY') {
    return body;
  }
  if (!frameSlideToken) return null;
  const candidate = body.querySelector(
    `[${FRAME_SLIDE_ATTRIBUTE}="${frameSlideToken}"]`
  );
  return candidate?.tagName === slide.element.tagName ? candidate : null;
}

/**
 * Resolves the slide element rendered inside the preview iframe. The returned
 * element lives in the iframe realm, which is what selection and geometry
 * helpers require.
 */
export function frameSlideElement(
  slide: SlideInfo,
  frameDocument: Document
): Element | null {
  return findFrameSlide(slide, frameDocument);
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
