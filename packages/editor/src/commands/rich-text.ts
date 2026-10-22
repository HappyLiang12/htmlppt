import {
  applyInlineStyle,
  clearFormatting,
  setBlockAlignment,
  setLink,
  toggleList
} from '@htmlppt/core';

const BLOCK_TAGS = new Set([
  'P',
  'H1',
  'H2',
  'H3',
  'H4',
  'H5',
  'H6',
  'LI',
  'BLOCKQUOTE',
  'DIV',
  'TD',
  'TH',
  'FIGCAPTION',
  'PRE'
]);

export interface TextToolbarState {
  bold: boolean;
  italic: boolean;
  underline: boolean;
  strike: boolean;
  color: string;
  highlight: string;
  fontFamily: string;
  fontSize: number;
  lineHeight: string;
  align: 'left' | 'center' | 'right' | 'justify';
  list: 'ul' | 'ol' | null;
  link: string | null;
}

export type TextCommand =
  | { type: 'bold' }
  | { type: 'italic' }
  | { type: 'underline' }
  | { type: 'strike' }
  | { type: 'color'; value: string }
  | { type: 'highlight'; value: string }
  | { type: 'fontFamily'; value: string }
  | { type: 'fontSize'; value: string }
  | { type: 'lineHeight'; value: string }
  | { type: 'align'; value: TextToolbarState['align'] }
  | { type: 'list'; value: 'ul' | 'ol' }
  | { type: 'link'; value: string }
  | { type: 'clear' };

function elementOf(node: Node | null | undefined): HTMLElement | null {
  if (!node) return null;
  return (
    node.nodeType === Node.ELEMENT_NODE
      ? (node as Element)
      : node.parentElement
  ) as HTMLElement | null;
}

export function textBlockOf(editable: HTMLElement): HTMLElement {
  let current: HTMLElement | null = editable;
  while (current && !BLOCK_TAGS.has(current.tagName)) {
    current = current.parentElement;
  }
  return current ?? editable;
}

export function currentTextRange(document: Document): Range | null {
  const selection = document.getSelection();
  if (!selection || selection.rangeCount === 0) return null;
  return selection.getRangeAt(0);
}

/** Falls back to the whole block when the live selection is gone. */
export function commandRange(
  document: Document,
  editable: HTMLElement,
  fallback: Range | null
): Range {
  const live = currentTextRange(document);
  if (live && editable.contains(live.commonAncestorContainer)) {
    return live;
  }
  if (fallback && editable.contains(fallback.commonAncestorContainer)) {
    return fallback;
  }
  const range = document.createRange();
  range.selectNodeContents(editable);
  return range;
}

function rgbToHex(value: string): string {
  const match = value.match(
    /^rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/
  );
  if (!match) {
    return value.startsWith('#') ? value : '';
  }
  const hex = match
    .slice(1, 4)
    .map((part) => Number(part).toString(16).padStart(2, '0'))
    .join('');
  return `#${hex}`;
}

function firstFamily(value: string): string {
  return (value.split(',')[0] ?? '').trim().replace(/^["']|["']$/g, '');
}

export function readTextToolbarState(
  document: Document,
  editable: HTMLElement,
  range: Range | null = currentTextRange(document)
): TextToolbarState {
  const rangeAnchor = elementOf(range?.startContainer);
  const anchor =
    rangeAnchor && editable.contains(rangeAnchor) ? rangeAnchor : editable;
  const style = document.defaultView?.getComputedStyle(anchor);
  const weightText = style?.fontWeight ?? '400';
  const weight =
    weightText === 'bold'
      ? 700
      : weightText === 'normal'
        ? 400
        : Number.parseInt(weightText, 10);
  const decoration = style?.textDecorationLine ?? 'none';
  const textAlign = style?.textAlign ?? 'left';
  const background = style?.backgroundColor ?? '';
  const item = anchor.closest('li');
  const list = item?.parentElement;
  const anchorLink = anchor.closest('a');
  const fontSize = Number.parseFloat(style?.fontSize ?? '16');

  return {
    bold: Number.isFinite(weight) ? weight >= 600 : false,
    italic: style?.fontStyle === 'italic',
    underline: decoration.includes('underline'),
    strike: decoration.includes('line-through'),
    color: rgbToHex(style?.color ?? ''),
    highlight:
      background === '' ||
      background === 'transparent' ||
      /rgba\(.*,\s*0\)$/.test(background)
        ? ''
        : rgbToHex(background),
    fontFamily: firstFamily(style?.fontFamily ?? ''),
    fontSize: Number.isFinite(fontSize) ? Math.round(fontSize) : 16,
    lineHeight:
      style?.lineHeight && style.lineHeight !== 'normal'
        ? style.lineHeight
        : '',
    align:
      textAlign === 'center' ||
      textAlign === 'right' ||
      textAlign === 'justify'
        ? textAlign
        : 'left',
    list:
      list && /^(UL|OL)$/.test(list.tagName)
        ? (list.tagName.toLowerCase() as 'ul' | 'ol')
        : null,
    link: anchorLink?.getAttribute('href') ?? null
  };
}

function explicitStyle(
  node: Node,
  editable: HTMLElement,
  property: string
): string {
  let current = elementOf(node);
  while (current) {
    const value = current.style?.getPropertyValue(property) ?? '';
    if (value) return value;
    if (current === editable) return '';
    current = current.parentElement;
  }
  return '';
}

function rangeHasExplicitStyle(
  range: Range,
  editable: HTMLElement,
  properties: string[],
  matches: (value: string) => boolean
): boolean {
  if (
    properties.some((property) =>
      matches(explicitStyle(range.startContainer, editable, property))
    )
  ) {
    return true;
  }
  if (range.collapsed) return false;
  const root = elementOf(range.commonAncestorContainer) ?? editable;
  const candidates = [
    root,
    ...Array.from(root.querySelectorAll<HTMLElement>('[style]'))
  ];
  return candidates.some((element) =>
    properties.some((property) =>
      matches(element.style?.getPropertyValue(property) ?? '')
    )
  );
}

function boldValue(value: string): boolean {
  return value === 'bold' || Number.parseInt(value, 10) >= 600;
}

function decorationValue(kind: 'underline' | 'line-through') {
  return (value: string) => value.includes(kind);
}

function applyStyle(
  range: Range,
  block: HTMLElement,
  style: Record<string, string>
): void {
  if (range.collapsed) {
    range.selectNodeContents(block);
    if (range.collapsed) {
      const document = block.ownerDocument;
      const span = document.createElement('span');
      for (const [property, value] of Object.entries(style)) {
        span.style.setProperty(property, value);
      }
      const caret = document.createRange();
      caret.selectNodeContents(block);
      caret.collapse(false);
      caret.insertNode(span);
      const next = document.createRange();
      next.selectNodeContents(span);
      next.collapse(false);
      const selection = document.getSelection();
      selection?.removeAllRanges();
      selection?.addRange(next);
      return;
    }
  }
  applyInlineStyle(range, style);
}

export function applyTextCommand(
  document: Document,
  editable: HTMLElement,
  command: TextCommand,
  fallbackRange: Range | null = null
): void {
  const range = commandRange(document, editable, fallbackRange);
  const block = textBlockOf(editable);

  switch (command.type) {
    case 'bold':
      applyStyle(range, block, {
        'font-weight': rangeHasExplicitStyle(
          range,
          editable,
          ['font-weight'],
          boldValue
        )
          ? 'normal'
          : 'bold'
      });
      return;
    case 'italic':
      applyStyle(range, block, {
        'font-style': rangeHasExplicitStyle(
          range,
          editable,
          ['font-style'],
          (value) => value === 'italic'
        )
          ? 'normal'
          : 'italic'
      });
      return;
    case 'underline':
      applyStyle(range, block, {
        'text-decoration-line': rangeHasExplicitStyle(
          range,
          editable,
          ['text-decoration-line', 'text-decoration'],
          decorationValue('underline')
        )
          ? 'none'
          : 'underline'
      });
      return;
    case 'strike':
      applyStyle(range, block, {
        'text-decoration-line': rangeHasExplicitStyle(
          range,
          editable,
          ['text-decoration-line', 'text-decoration'],
          decorationValue('line-through')
        )
          ? 'none'
          : 'line-through'
      });
      return;
    case 'color':
      applyStyle(range, block, { color: command.value });
      return;
    case 'highlight':
      applyStyle(range, block, {
        'background-color': command.value
      });
      return;
    case 'fontFamily':
      applyStyle(range, block, {
        'font-family': command.value
      });
      return;
    case 'fontSize':
      applyStyle(range, block, {
        'font-size': command.value
      });
      return;
    case 'lineHeight':
      block.style.lineHeight = command.value;
      return;
    case 'align':
      setBlockAlignment(block, command.value);
      return;
    case 'list':
      toggleList(document, block, command.value);
      return;
    case 'link':
      setLink(range, command.value);
      return;
    case 'clear': {
      const clearRange = range;
      if (clearRange.collapsed) {
        clearRange.selectNodeContents(block);
      }
      clearFormatting(clearRange);
      return;
    }
  }
}
