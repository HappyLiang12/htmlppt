import { detectSlides } from './detect.js';
import type { SlideInfo } from './detect.js';
import type { Diagnostic, ValidationResult } from './types.js';

const TRANSITIONS = new Set(['none', 'fade', 'slide']);
const RUNTIME_ATTRIBUTE = 'data-ppt-runtime';
const EDITOR_ATTRIBUTES = ['data-ppt-editing', 'data-ppt-frame-slide'];

function diagnostic(
  severity: Diagnostic['severity'],
  code: string,
  message: string,
  slideId?: string,
  location?: string
): Diagnostic {
  return {
    severity,
    code,
    message,
    ...(slideId ? { slideId } : {}),
    ...(location ? { location } : {})
  };
}

function elementLocation(slide: SlideInfo | undefined, element: Element): string {
  const tag = element.tagName.toLowerCase();
  const id = element.getAttribute('id');
  const base = `${tag}${id ? `#${id}` : ''}`;
  return slide ? `${slide.id} > ${base}` : base;
}

function slideFor(
  element: Element,
  slides: SlideInfo[]
): SlideInfo | undefined {
  let current: Element | null = element;
  while (current) {
    const match = slides.find((slide) => slide.element === current);
    if (match) return match;
    current = current.parentElement;
  }
  return undefined;
}

function owningSlideElement(
  element: Element,
  slideElements: Set<Element>
): Element | undefined {
  let current: Element | null = element;
  while (current) {
    if (slideElements.has(current)) return current;
    current = current.parentElement;
  }
  return undefined;
}

export function validateDeck(doc: Document): ValidationResult {
  const errors: Diagnostic[] = [];
  const warnings: Diagnostic[] = [];
  const info: Diagnostic[] = [];

  const bodyIsEmpty = !doc.body || doc.body.children.length === 0;

  if (bodyIsEmpty) {
    errors.push(
      diagnostic('error', 'empty-document', 'The document has no content.')
    );
  }

  if (!doc.title.trim()) {
    warnings.push(
      diagnostic('warning', 'missing-title', 'The document has no <title>.')
    );
  }

  const slides = bodyIsEmpty ? [] : detectSlides(doc);
  const slideElements = new Set(slides.map((slide) => slide.element));

  for (const slide of slides) {
    if (slide.element === doc.body) continue;

    if (!slide.widthValid) {
      errors.push(
        diagnostic(
          'error',
          'invalid-canvas-size',
          `Slide canvas width "${slide.element.getAttribute('data-width')}" is not a positive number.`,
          slide.id,
          slide.id
        )
      );
    }
    if (!slide.heightValid) {
      errors.push(
        diagnostic(
          'error',
          'invalid-canvas-size',
          `Slide canvas height "${slide.element.getAttribute('data-height')}" is not a positive number.`,
          slide.id,
          slide.id
        )
      );
    }

    const transition = slide.element.getAttribute('data-ppt-transition');
    if (transition !== null && !TRANSITIONS.has(transition.trim())) {
      errors.push(
        diagnostic(
          'error',
          'invalid-transition',
          `Transition "${transition}" is not one of none, fade, slide.`,
          slide.id,
          slide.id
        )
      );
    }

    const elements = Array.from(
      slide.element.querySelectorAll('[data-ppt-el]')
    ).filter(
      (element) => owningSlideElement(element, slideElements) === slide.element
    );
    const elementIds = new Map<string, number>();
    for (const element of elements) {
      const id = element.getAttribute('data-ppt-el')?.trim();
      if (id) elementIds.set(id, (elementIds.get(id) ?? 0) + 1);
    }
    for (const [id, count] of elementIds) {
      if (count > 1) {
        const first = elements.find(
          (element) => element.getAttribute('data-ppt-el')?.trim() === id
        );
        errors.push(
          diagnostic(
            'error',
            'duplicate-element-id',
            `Element id "${id}" is used ${count} times in slide "${slide.id}".`,
            slide.id,
            first ? elementLocation(slide, first) : slide.id
          )
        );
      }
    }
  }

  const seen = new Map<string, number>();
  for (const slide of slides) {
    if (slide.hasId) {
      seen.set(slide.id, (seen.get(slide.id) ?? 0) + 1);
    } else {
      warnings.push(
        diagnostic(
          'warning',
          'missing-slide-id',
          `Slide ${slide.index + 1} has no data-slide-id.`,
          slide.id
        )
      );
    }

    for (const chart of Array.from(slide.element.querySelectorAll('[data-ppt-chart]'))) {
      try {
        JSON.parse(chart.getAttribute('data-ppt-chart') ?? '');
      } catch {
        errors.push(
          diagnostic(
            'error',
            'invalid-chart-json',
            'Chart data is not valid JSON.',
            slide.id
          )
        );
      }
    }
  }

  for (const [id, count] of seen) {
    if (count > 1) {
      errors.push(
        diagnostic(
          'error',
          'duplicate-slide-id',
          `Slide id "${id}" is used ${count} times.`,
          id
        )
      );
    }
  }

  const markers = Array.from(doc.querySelectorAll(`[${RUNTIME_ATTRIBUTE}]`));
  let validRuntimes = 0;
  let secondRuntime: { element: Element; owner: SlideInfo | undefined } | undefined;
  for (const marker of markers) {
    const owner = slideFor(marker, slides);
    if (marker.tagName !== 'SCRIPT' || marker.getAttribute(RUNTIME_ATTRIBUTE)?.trim() !== '1') {
      errors.push(
        diagnostic(
          'error',
          'invalid-runtime-marker',
          'Runtime marker must be data-ppt-runtime="1" on a script element.',
          owner?.id,
          elementLocation(owner, marker)
        )
      );
    } else {
      validRuntimes += 1;
      if (validRuntimes === 2) {
        secondRuntime = { element: marker, owner };
      }
    }
  }
  if (secondRuntime) {
    errors.push(
      diagnostic(
        'error',
        'duplicate-runtime',
        'More than one runtime script is present.',
        secondRuntime.owner?.id,
        elementLocation(secondRuntime.owner, secondRuntime.element)
      )
    );
  }

  for (const notes of Array.from(doc.querySelectorAll('[data-ppt-notes]'))) {
    const parent = notes.parentElement;
    const owner = slideFor(notes, slides);
    if (!parent || !owner || owner.element !== parent) {
      errors.push(
        diagnostic(
          'error',
          'notes-nested-incorrectly',
          'Speaker notes must be a direct child of a slide.',
          owner?.id,
          elementLocation(owner, notes)
        )
      );
    }
  }

  for (const attribute of EDITOR_ATTRIBUTES) {
    for (const element of Array.from(doc.querySelectorAll(`[${attribute}]`))) {
      const owner = slideFor(element, slides);
      errors.push(
        diagnostic(
          'error',
          'editor-artifacts',
          `Editor-only attribute "${attribute}" is present.`,
          owner?.id,
          elementLocation(owner, element)
        )
      );
    }
  }

  info.push(
    diagnostic('info', 'slide-count', `${slides.length} slide(s) detected.`)
  );

  return { errors, warnings, info, valid: errors.length === 0 };
}
