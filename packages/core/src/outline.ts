import { detectSlides, type SlideInfo } from './detect.js';

export interface OutlineElement {
  id: string | null;
  tag: string;
  path: number[];
  text: string;
  classes: string[];
  group: boolean;
}

export interface OutlineSlide {
  id: string;
  index: number;
  width: number;
  height: number;
  transition: string | null;
  notes: string | null;
  elements: OutlineElement[];
}

export interface DeckOutline {
  title: string;
  width: number;
  height: number;
  slideCount: number;
  runtime: boolean;
  slides: OutlineSlide[];
}

export interface SlideReadModel {
  id: string;
  index: number;
  html: string;
  notes: string | null;
  transition: string | null;
  width: number;
  height: number;
}

const NON_OBJECT_TAGS = new Set(['SCRIPT', 'STYLE', 'TEMPLATE', 'LINK', 'META']);

function summarize(element: Element): string {
  const text = (element.textContent ?? '').replace(/\s+/g, ' ').trim();
  return text.length > 120 ? `${text.slice(0, 117)}...` : text;
}

function pathOf(slide: Element, element: Element): number[] {
  const path: number[] = [];
  let current: Element | null = element;
  while (current && current !== slide) {
    const parent: Element | null = current.parentElement;
    if (!parent) return [];
    path.unshift(Array.prototype.indexOf.call(parent.children, current));
    current = parent;
  }
  return current === slide ? path : [];
}

function notesOf(slide: Element): string | null {
  for (const child of Array.from(slide.children)) {
    if (child.hasAttribute('data-ppt-notes')) {
      return (child.textContent ?? '').replace(/\s+/g, ' ').trim();
    }
  }
  return null;
}

function elementsOf(slide: SlideInfo): OutlineElement[] {
  return Array.from(slide.element.children)
    .filter(
      (element) =>
        !NON_OBJECT_TAGS.has(element.tagName) && !element.hasAttribute('data-ppt-notes')
    )
    .map((element) => ({
      id: element.getAttribute('data-ppt-el')?.trim() || null,
      tag: element.tagName.toLowerCase(),
      path: pathOf(slide.element, element),
      text: summarize(element),
      classes: Array.from(element.classList),
      group: element.hasAttribute('data-ppt-group')
    }));
}

export function getOutline(doc: Document): DeckOutline {
  const slides = detectSlides(doc);
  const first = slides[0];
  return {
    title: doc.title.trim(),
    width: first?.width ?? 1600,
    height: first?.height ?? 900,
    slideCount: slides.length,
    runtime: doc.querySelector('script[data-ppt-runtime="1"]') !== null,
    slides: slides.map((slide) => ({
      id: slide.id,
      index: slide.index,
      width: slide.width,
      height: slide.height,
      transition: slide.element.getAttribute('data-ppt-transition'),
      notes: notesOf(slide.element),
      elements: elementsOf(slide)
    }))
  };
}

export function readSlide(doc: Document, slideId: string): SlideReadModel {
  const slide = detectSlides(doc).find((candidate) => candidate.id === slideId);
  if (!slide) throw new Error(`Slide "${slideId}" was not found.`);
  return {
    id: slide.id,
    index: slide.index,
    html: slide.element.outerHTML,
    notes: notesOf(slide.element),
    transition: slide.element.getAttribute('data-ppt-transition'),
    width: slide.width,
    height: slide.height
  };
}
