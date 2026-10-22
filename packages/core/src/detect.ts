export interface CanvasSize {
  width: number;
  height: number;
  widthValid: boolean;
  heightValid: boolean;
}

export interface SlideInfo {
  id: string;
  hasId: boolean;
  element: Element;
  index: number;
  width: number;
  height: number;
  widthValid: boolean;
  heightValid: boolean;
}

const SLIDE_SELECTORS = ['[data-slide-id]', '.slide', '.page', '.slide-page'];
const DEFAULT_WIDTH = 1600;
const DEFAULT_HEIGHT = 900;
const NUMBER = String.raw`(?:\d+(?:\.\d+)?|\.\d+)`;
const ATTRIBUTE_SIZE = new RegExp(`^${NUMBER}(?:px)?$`, 'i');

function positiveNumber(value: number): boolean {
  return Number.isFinite(value) && value > 0;
}

function readAttributeSize(value: string | null): number {
  const match = value?.trim().match(ATTRIBUTE_SIZE);
  return match ? Number.parseFloat(match[0]) : Number.NaN;
}

function readStyleSize(style: string, property: 'width' | 'height'): number {
  const pattern = new RegExp(`(?:^|;)\\s*${property}\\s*:\\s*(${NUMBER})px`, 'gi');
  const matches = Array.from(style.matchAll(pattern));
  const value = matches.at(-1)?.[1];
  return value === undefined ? Number.NaN : Number.parseFloat(value);
}

export function readCanvasSize(element: Element): CanvasSize {
  const rawWidth = element.getAttribute('data-width');
  const rawHeight = element.getAttribute('data-height');
  const attributeWidth = readAttributeSize(rawWidth);
  const attributeHeight = readAttributeSize(rawHeight);
  const inlineStyle = element.getAttribute('style') ?? '';
  const styleWidth = readStyleSize(inlineStyle, 'width');
  const styleHeight = readStyleSize(inlineStyle, 'height');

  return {
    width: positiveNumber(attributeWidth)
      ? attributeWidth
      : positiveNumber(styleWidth)
        ? styleWidth
        : DEFAULT_WIDTH,
    height: positiveNumber(attributeHeight)
      ? attributeHeight
      : positiveNumber(styleHeight)
        ? styleHeight
        : DEFAULT_HEIGHT,
    widthValid: rawWidth === null || positiveNumber(attributeWidth),
    heightValid: rawHeight === null || positiveNumber(attributeHeight)
  };
}

function toSlideInfo(element: Element, index: number): SlideInfo {
  const rawId = element.getAttribute('data-slide-id');
  const hasId = rawId !== null && rawId.trim() !== '';
  return {
    id: hasId ? rawId.trim() : `s${index + 1}`,
    hasId,
    element,
    index,
    ...readCanvasSize(element)
  };
}

export function detectSlides(doc: Document): SlideInfo[] {
  for (const selector of SLIDE_SELECTORS) {
    const matches = Array.from(doc.querySelectorAll(selector));
    if (matches.length > 0) {
      return matches.map(toSlideInfo);
    }
  }

  const sections = Array.from(doc.querySelectorAll('section'));
  if (sections.length > 0) {
    const groups = new Map<Element, Element[]>();
    for (const section of sections) {
      const parent = section.parentElement;
      if (!parent) continue;
      const group = groups.get(parent) ?? [];
      group.push(section);
      groups.set(parent, group);
    }

    let best: Element[] | undefined;
    for (const group of groups.values()) {
      if (!best || group.length > best.length) best = group;
    }
    if (best && best.length > 0) {
      return best.map(toSlideInfo);
    }
  }

  // Body sentinel: the fallback is not an explicit slide, so hasId stays false,
  // but it gets a fixed id so downstream consumers can address it.
  const body = doc.body;
  return body ? [{ ...toSlideInfo(body, 0), id: 'body' }] : [];
}
