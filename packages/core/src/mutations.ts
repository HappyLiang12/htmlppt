import { detectSlides, type SlideInfo } from './detect.js';
import { defaultIdFactory } from './ids.js';
import { normalizeDeck } from './normalize.js';
import { DeckMutationError, resolveTarget, type ElementTarget } from './target.js';
import type { Diagnostic } from './types.js';
import { validateDeck } from './validate.js';

export { DeckMutationError, resolveTarget };
export type { ElementTarget };

const STYLE_PROPERTY = /^-?[a-zA-Z][a-zA-Z0-9-]*$/;
const NON_OBJECT_TAGS = new Set(['SCRIPT', 'STYLE', 'TEMPLATE', 'LINK', 'META']);

function fail(code: string, message: string): never {
  throw new DeckMutationError(code, message);
}

function assignElementId(slide: Element, element: Element): void {
  if (element.getAttribute('data-ppt-el')?.trim()) return;
  const used = new Set<string>();
  const slideRootId = slide.getAttribute('data-ppt-el')?.trim();
  if (slideRootId) used.add(slideRootId);
  for (const candidate of Array.from(slide.querySelectorAll('[data-ppt-el]'))) {
    const id = candidate.getAttribute('data-ppt-el')?.trim();
    if (id) used.add(id);
  }
  element.setAttribute('data-ppt-el', defaultIdFactory.elementId(used, 0));
}

export function setText(target: Element, text: string): void {
  target.textContent = text;
}

export function setStyle(
  target: Element,
  styles: Record<string, string | null>
): void {
  const htmlTarget = target as HTMLElement;
  for (const [property, value] of Object.entries(styles)) {
    if (!STYLE_PROPERTY.test(property)) {
      fail('invalid-style-property', `"${property}" is not a valid CSS property name.`);
    }
    if (value === null || value === '') htmlTarget.style.removeProperty(property);
    else htmlTarget.style.setProperty(property, value);
  }
  if (htmlTarget.getAttribute('style')?.trim() === '') {
    htmlTarget.removeAttribute('style');
  }
}

export function setElementHtml(target: Element, html: string): void {
  target.innerHTML = html;
}

export function addElement(
  slide: Element,
  html: string,
  after?: ElementTarget
): Element {
  const container = slide.ownerDocument.createElement('div');
  container.innerHTML = html;
  if (container.children.length !== 1) {
    fail('invalid-fragment', 'Element HTML must contain exactly one root element.');
  }
  const element = container.firstElementChild as Element;
  container.removeChild(element);
  const reference = after ? resolveTarget(slide, after) : null;
  if (reference === null) {
    slide.appendChild(element);
  } else {
    if (reference.parentElement !== slide) {
      fail('target-invalid', 'The insertion anchor must be a direct child of the slide.');
    }
    slide.insertBefore(element, reference.nextElementSibling);
  }
  if (!NON_OBJECT_TAGS.has(element.tagName)) assignElementId(slide, element);
  return element;
}

export function removeElement(target: Element): void {
  if (
    target === target.ownerDocument.body ||
    target.hasAttribute('data-slide-id') ||
    target.hasAttribute('data-ppt-deck')
  ) {
    fail('cannot-remove-slide', 'The slide itself cannot be removed.');
  }
  const parent = target.parentElement;
  if (!parent) fail('cannot-remove-slide', 'The slide itself cannot be removed.');
  parent.removeChild(target);
}

export function mutateDeck<T>(
  source: Document,
  mutation: (draft: Document) => T
): { document: Document; result: T } {
  const document = source.cloneNode(true) as Document;
  const result = mutation(document);
  normalizeDeck(document);
  const validation = validateDeck(document);
  if (!validation.valid) {
    throw new DeckMutationError(
      'invalid-result',
      `The mutation produced an invalid deck: ${validation.errors
        .map((error: Diagnostic) => error.code)
        .join(', ')}`,
      validation.errors
    );
  }
  return { document, result };
}

export function findSlide(doc: Document, slideId: string): SlideInfo {
  const slides = detectSlides(doc);
  const slide =
    slides.find((candidate) => candidate.id === slideId && candidate.hasId) ??
    (slideId === 'body'
      ? slides.find((candidate) => candidate.element === doc.body)
      : undefined);
  if (!slide) fail('slide-not-found', `Slide "${slideId}" was not found.`);
  return slide;
}
