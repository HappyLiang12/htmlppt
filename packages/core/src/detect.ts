export interface SlideInfo {
  id: string;
  hasId: boolean;
  element: Element;
  index: number;
  width: number;
  height: number;
}

const SLIDE_SELECTORS = ['[data-slide-id]', '.slide', '.page', '.slide-page'];
const DEFAULT_WIDTH = 1600;
const DEFAULT_HEIGHT = 900;

function positiveNumber(value: number): boolean {
  return Number.isFinite(value) && value > 0;
}

function readSize(element: Element): { width: number; height: number } {
  const attributeWidth = Number(element.getAttribute('data-width'));
  const attributeHeight = Number(element.getAttribute('data-height'));
  const inlineStyle = element.getAttribute('style') ?? '';
  const styleWidth = Number.parseFloat(
    /(?:^|;)\s*width\s*:\s*([\d.]+)px/.exec(inlineStyle)?.[1] ?? ''
  );
  const styleHeight = Number.parseFloat(
    /(?:^|;)\s*height\s*:\s*([\d.]+)px/.exec(inlineStyle)?.[1] ?? ''
  );

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
        : DEFAULT_HEIGHT
  };
}

function toSlideInfo(element: Element, index: number): SlideInfo {
  const rawId = element.getAttribute('data-slide-id');
  return {
    id: rawId ?? `s${index + 1}`,
    hasId: Boolean(rawId),
    element,
    index,
    ...readSize(element)
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

  const body = doc.body;
  return body ? [{ ...toSlideInfo(body, 0), id: 'body' }] : [];
}
