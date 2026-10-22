export { detectSlides, readCanvasSize } from './detect.js';
export type { CanvasSize, SlideInfo } from './detect.js';
export { getOutline, readSlide } from './outline.js';
export type { DeckOutline, OutlineElement, OutlineSlide, SlideReadModel } from './outline.js';
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
  mutateDeck,
  removeElement,
  resolveTarget,
  setElementHtml,
  setStyle,
  setText
} from './mutations.js';
export type { ElementTarget } from './mutations.js';
