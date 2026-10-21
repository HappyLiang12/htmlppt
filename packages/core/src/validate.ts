import { detectSlides } from './detect.js';
import type { Diagnostic, ValidationResult } from './types.js';

function diagnostic(
  severity: Diagnostic['severity'],
  code: string,
  message: string,
  slideId?: string
): Diagnostic {
  return slideId ? { severity, code, message, slideId } : { severity, code, message };
}

export function validateDeck(doc: Document): ValidationResult {
  const errors: Diagnostic[] = [];
  const warnings: Diagnostic[] = [];
  const info: Diagnostic[] = [];

  if (!doc.body || doc.body.children.length === 0) {
    errors.push(
      diagnostic('error', 'empty-document', 'The document has no content.')
    );
  }

  if (!doc.title.trim()) {
    warnings.push(
      diagnostic('warning', 'missing-title', 'The document has no <title>.')
    );
  }

  const slides = detectSlides(doc);
  if (slides.length === 0) {
    errors.push(
      diagnostic('error', 'no-slides', 'No slides were found in the document.')
    );
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

  info.push(
    diagnostic('info', 'slide-count', `${slides.length} slide(s) detected.`)
  );

  return { errors, warnings, info, valid: errors.length === 0 };
}
