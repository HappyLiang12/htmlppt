import { detectSlides, type SlideInfo } from './detect.js';
import { DeckMutationError } from './target.js';

/**
 * Resolves a slide by its data-slide-id, with the legacy body fallback.
 * Read models and mutations share this so both report slide-not-found the
 * same way without reading depending on the mutation module.
 */
export function findSlide(doc: Document, slideId: string): SlideInfo {
  const slides = detectSlides(doc);
  const slide =
    slides.find((candidate) => candidate.id === slideId && candidate.hasId) ??
    (slideId === 'body'
      ? slides.find((candidate) => candidate.element === doc.body)
      : undefined);
  if (!slide) {
    throw new DeckMutationError(
      'slide-not-found',
      `Slide "${slideId}" was not found.`
    );
  }
  return slide;
}
