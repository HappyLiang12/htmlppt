export { detectSlides, readCanvasSize } from './detect.js';
export type { CanvasSize, SlideInfo } from './detect.js';
export { getElement, getOutline, readSlide } from './outline.js';
export type {
  DeckOutline,
  ElementReadModel,
  OutlineElement,
  OutlineSlide,
  SlideReadModel
} from './outline.js';
export { validateDeck } from './validate.js';
export type { Diagnostic, DiagnosticSeverity, ValidationResult } from './types.js';
export { serializeDeck, serializeExport } from './serialize.js';
export { createDeckHtml } from './template.js';
export type { CreateDeckOptions } from './template.js';
export { normalizeDeck } from './normalize.js';
export type { NormalizeOptions, NormalizeResult, NormalizedSlide } from './normalize.js';
export { defaultIdFactory } from './ids.js';
export type { IdFactory } from './ids.js';
export {
  DeckMutationError,
  addElement,
  addSlide,
  deleteSlide,
  duplicateSlide,
  moveSlide,
  mutateDeck,
  removeElement,
  resolveTarget,
  setElementHtml,
  setNotes,
  setSlideBackground,
  setSlideOrder,
  setStyle,
  setText,
  setTransition,
  updateSlideHtml
} from './mutations.js';
// Consumed by the MCP package and shared with read models/mutations internally.
export { findSlide } from './slides.js';
export type {
  AddSlideOptions,
  ElementTarget,
  SlideBackground,
  Transition
} from './mutations.js';
