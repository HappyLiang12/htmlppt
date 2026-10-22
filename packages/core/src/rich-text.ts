const LINK_PROTOCOLS = new Set(['http:', 'https:', 'mailto:']);
const STYLE_PROPERTY = /^-?[a-z][a-z0-9-]*$/i;

function documentOf(range: Range): Document {
  const document = range.startContainer.ownerDocument;
  if (!document) {
    throw new Error('The range is not attached to a document.');
  }
  return document;
}

function elementOf(node: Node): Element | null {
  return node.nodeType === 1
    ? (node as Element)
    : node.parentElement;
}

function selectContents(range: Range, element: Element): void {
  const document = element.ownerDocument;
  const selection = document?.getSelection();
  if (!selection) return;
  const next = document.createRange();
  next.selectNodeContents(element);
  selection.removeAllRanges();
  selection.addRange(next);
  range.setStart(next.startContainer, next.startOffset);
  range.setEnd(next.endContainer, next.endOffset);
}

function unwrap(element: Element): void {
  const parent = element.parentNode;
  if (!parent) return;
  const fragment = element.ownerDocument.createDocumentFragment();
  while (element.firstChild) {
    fragment.appendChild(element.firstChild);
  }
  parent.replaceChild(fragment, element);
}

/**
 * Applies inline CSS to exactly the selected characters. The selected
 * contents are extracted, wrapped in a styled span, and reinserted, so
 * partially selected text no longer shares formatting with its neighbours.
 */
export function applyInlineStyle(
  range: Range,
  style: Record<string, string>
): HTMLElement {
  const document = documentOf(range);
  const span = document.createElement('span');
  for (const [property, value] of Object.entries(style)) {
    if (!STYLE_PROPERTY.test(property)) continue;
    span.style.setProperty(property, value);
  }
  if (range.collapsed) {
    range.insertNode(span);
  } else {
    span.appendChild(range.extractContents());
    range.insertNode(span);
  }
  selectContents(range, span);
  return span;
}

function clearElementFormatting(element: Element): void {
  element.removeAttribute('style');
  const tag = element.tagName.toLowerCase();
  if (
    tag === 'span' ||
    tag === 'font' ||
    tag === 'b' ||
    tag === 'i' ||
    tag === 'u' ||
    tag === 's' ||
    tag === 'strike' ||
    tag === 'strong' ||
    tag === 'em' ||
    tag === 'mark'
  ) {
    unwrap(element);
  }
}

/**
 * Removes inline formatting and formatting wrappers inside the range while
 * keeping links, text, and block structure. A collapsed range clears the
 * closest element's inline styles.
 */
export function clearFormatting(range: Range): void {
  const document = documentOf(range);
  if (range.collapsed) {
    elementOf(range.startContainer)?.removeAttribute('style');
    return;
  }
  const fragment = range.extractContents();
  for (const element of Array.from(fragment.querySelectorAll('*'))) {
    clearElementFormatting(element);
  }
  const holder = document.createElement('span');
  holder.appendChild(fragment);
  range.insertNode(holder);
  const first = holder.firstChild;
  const last = holder.lastChild;
  unwrap(holder);
  if (!first || !last) return;
  const selection = document.getSelection();
  if (!selection) return;
  const next = document.createRange();
  next.setStartBefore(first);
  next.setEndAfter(last);
  selection.removeAllRanges();
  selection.addRange(next);
  range.setStart(next.startContainer, next.startOffset);
  range.setEnd(next.endContainer, next.endOffset);
}

/**
 * Converts a block into a list item or toggles it back. Removing one item
 * from a multi-item list splits the list so the paragraph stays valid.
 */
export function toggleList(
  document: Document,
  block: Element,
  type: 'ul' | 'ol'
): HTMLElement {
  const item = block.closest('li');
  const list = item?.parentElement;
  if (item && list && /^(ul|ol)$/i.test(list.tagName)) {
    if (list.tagName.toLowerCase() === type) {
      return removeListItem(document, item, list);
    }
    const replacement = document.createElement(type);
    while (list.firstChild) {
      replacement.appendChild(list.firstChild);
    }
    list.replaceWith(replacement);
    return item;
  }

  const listElement = document.createElement(type);
  const listItem = document.createElement('li');
  copyObjectAttributes(block, listItem);
  while (block.firstChild) {
    listItem.appendChild(block.firstChild);
  }
  listElement.appendChild(listItem);
  block.replaceWith(listElement);
  return listItem;
}

/**
 * Copies the attributes that define a presentation object, leaving
 * editor-only state such as contenteditable behind.
 */
function copyObjectAttributes(source: Element, target: Element): void {
  for (const attribute of Array.from(source.attributes)) {
    const { name, value } = attribute;
    if (name === 'style' || name === 'class') {
      target.setAttribute(name, value);
    } else if (name.startsWith('data-ppt-') && name !== 'data-ppt-editing') {
      target.setAttribute(name, value);
    }
  }
}

function removeListItem(
  document: Document,
  item: Element,
  list: Element
): HTMLElement {
  const parent = list.parentElement;
  if (!parent) {
    throw new Error('The list is not attached to the document.');
  }
  const children = Array.from(list.children);
  const index = children.indexOf(item);
  const before = children.slice(0, index);
  const after = children.slice(index + 1);
  const paragraph = document.createElement('p');
  copyObjectAttributes(item, paragraph);
  while (item.firstChild) {
    paragraph.appendChild(item.firstChild);
  }

  let leading: Element | null = null;
  if (before.length > 0) {
    leading = list.cloneNode(false) as Element;
    for (const child of before) leading.appendChild(child);
  }
  let trailing: Element | null = null;
  if (after.length > 0) {
    trailing = list.cloneNode(false) as Element;
    for (const child of after) trailing.appendChild(child);
  }
  parent.replaceChild(paragraph, list);
  if (leading) parent.insertBefore(leading, paragraph);
  if (trailing) parent.insertBefore(trailing, paragraph.nextSibling);
  return paragraph;
}

/** Sets text-align on a block; an empty or unknown value clears it. */
export function setBlockAlignment(
  block: HTMLElement,
  value: string
): void {
  const alignment = value.trim().toLowerCase();
  if (
    alignment !== 'left' &&
    alignment !== 'center' &&
    alignment !== 'right' &&
    alignment !== 'justify'
  ) {
    block.style.removeProperty('text-align');
    return;
  }
  block.style.textAlign = alignment;
}

/**
 * Validates a link target. Only http, https, mailto, and same-page #fragment
 * links are accepted; an empty target means "remove the link".
 */
export function normalizeLinkHref(href: string): string {
  const value = href.trim();
  if (value === '') return '';
  if (value.startsWith('#')) return value;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(
      'Enter an absolute URL such as https://example.com, a mailto: address, or a #fragment.'
    );
  }
  if (!LINK_PROTOCOLS.has(url.protocol)) {
    throw new Error(
      'Links must use http:, https:, mailto:, or a #fragment.'
    );
  }
  return value;
}

function closestAnchor(node: Node): HTMLAnchorElement | null {
  return (elementOf(node)?.closest('a') as HTMLAnchorElement | null) ?? null;
}

function unwrapAnchors(fragment: DocumentFragment): void {
  for (const anchor of Array.from(fragment.querySelectorAll('a'))) {
    unwrap(anchor);
  }
}

/**
 * Wraps the selection in a link, updates a link the selection is already
 * inside, or removes links when href is empty.
 */
export function setLink(range: Range, href: string): HTMLAnchorElement | null {
  const document = documentOf(range);
  const value = normalizeLinkHref(href);
  const startAnchor = closestAnchor(range.startContainer);
  const existing =
    startAnchor && startAnchor.contains(range.endContainer)
      ? startAnchor
      : null;

  if (value === '') {
    if (existing) {
      unwrap(existing);
      return null;
    }
    if (range.collapsed) return null;
    const fragment = range.extractContents();
    unwrapAnchors(fragment);
    range.insertNode(fragment);
    return null;
  }

  if (existing) {
    existing.setAttribute('href', value);
    return existing;
  }

  if (range.collapsed) {
    throw new Error('Select text to add a link.');
  }

  const fragment = range.extractContents();
  unwrapAnchors(fragment);
  const anchor = document.createElement('a');
  anchor.setAttribute('href', value);
  anchor.appendChild(fragment);
  range.insertNode(anchor);
  selectContents(range, anchor);
  return anchor;
}

/** Converts pasted clipboard text into plain text without markup. */
export function sanitizePastedText(text: string): string {
  const plain = text
    .replace(/\r\n?/g, '\n')
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, '')
    .replace(/<[^>]*>/g, '');
  return Array.from(plain, (character) => {
    const code = character.charCodeAt(0);
    const control =
      code <= 8 || code === 11 || code === 12 || (code >= 14 && code <= 31);
    return control ? '' : character;
  }).join('');
}
