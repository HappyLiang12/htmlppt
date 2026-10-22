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
export {
  alignElements,
  bringForward,
  bringToFront,
  distributeElements,
  groupElements,
  sendBackward,
  sendToBack,
  setHidden,
  setLocked,
  ungroupElement
} from './objects.js';
export {
  applyInlineStyle,
  clearFormatting,
  normalizeLinkHref,
  sanitizePastedText,
  setBlockAlignment,
  setLink,
  toggleList
} from './rich-text.js';
export { insertImage, insertShape, insertTextBox } from './insert.js';
export type {
  InsertImageOptions,
  InsertRect,
  InsertShapeOptions,
  InsertTextBoxOptions,
  ShapeKind
} from './insert.js';
export {
  CROP_ATTRIBUTE,
  imageCropOf,
  readShapeAppearance,
  replaceImageSource,
  setImageAlt,
  setImageCrop,
  setShapeAppearance,
  setShapeText
} from './appearance.js';
export type {
  ImageCrop,
  ShapeAppearance,
  ShapeAppearanceValues
} from './appearance.js';
export {
  MAX_TABLE_COLUMNS,
  MAX_TABLE_ROWS,
  TABLE_CELL_BORDER,
  TABLE_CELL_PADDING,
  deleteTableColumn,
  deleteTableRow,
  insertTable,
  insertTableColumn,
  insertTableRow,
  tableCellAt,
  tableColumnCount,
  tableHasHeaderRow,
  tableRowCount,
  toggleTableHeaderRow
} from './tables.js';
export type { InsertTableOptions } from './tables.js';
export {
  CHART_ATTRIBUTE,
  DEFAULT_CHART_COLORS,
  MAX_CHART_LABELS,
  MAX_CHART_SERIES,
  chartDataOf,
  chartSizeOf,
  insertChart,
  parseChartData,
  renderChartSvg,
  updateChart
} from './charts.js';
export type {
  ChartData,
  ChartSeries,
  ChartType,
  InsertChartOptions
} from './charts.js';
export {
  MAX_IMAGE_BYTES,
  formatBytes,
  imageDataUrlFromBytes,
  imageMimeFromFileName,
  imageSourceFromFile,
  isSupportedImageMime,
  validateImageSource
} from './images.js';
