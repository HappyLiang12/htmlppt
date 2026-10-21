import { RUNTIME_SOURCE } from '@htmlppt/runtime';

const DOCTYPE = '<!doctype html>';
const GENERATOR_COMMENT = '<!-- Edited with htmlppt. Format: htmldeck/v1. -->';

export function serializeDeck(doc: Document): string {
  return `${DOCTYPE}\n${doc.documentElement.outerHTML}`;
}

function needsRuntime(doc: Document): boolean {
  return (
    doc.querySelectorAll('[data-slide-id]').length > 1 &&
    doc.querySelector('[data-ppt-runtime="1"]') === null &&
    doc.querySelector('script') === null
  );
}

function withRuntime(doc: Document): Document {
  const clone = doc.cloneNode(true) as Document;
  const script = clone.createElement('script');
  script.setAttribute('data-ppt-runtime', '1');
  script.textContent = RUNTIME_SOURCE;
  clone.body.appendChild(script);
  return clone;
}

export function serializeExport(doc: Document): string {
  const exported = needsRuntime(doc) ? withRuntime(doc) : doc;
  return `${DOCTYPE}\n${GENERATOR_COMMENT}\n${exported.documentElement.outerHTML}`;
}
