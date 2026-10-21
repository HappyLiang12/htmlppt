const DOCTYPE = '<!doctype html>';
const GENERATOR_COMMENT = '<!-- Edited with htmlppt. Format: htmldeck/v1. -->';

export function serializeDeck(doc: Document): string {
  return `${DOCTYPE}\n${doc.documentElement.outerHTML}`;
}

export function serializeExport(doc: Document): string {
  return `${DOCTYPE}\n${GENERATOR_COMMENT}\n${doc.documentElement.outerHTML}`;
}
