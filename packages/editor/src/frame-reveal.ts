import { PREVIEW_SLIDE_ATTRIBUTE } from './slide-doc';

interface RemovedDisplay {
  style: CSSStyleDeclaration;
  value: string;
  priority: string;
}

function viewOf(document: Document): Window | null {
  return document.defaultView;
}

function computedStyle(
  document: Document,
  element: Element
): CSSStyleDeclaration | null {
  return viewOf(document)?.getComputedStyle(element) ?? null;
}

function computedDisplay(document: Document, element: Element): string {
  return computedStyle(document, element)?.display ?? '';
}

function removeInlineHiding(element: Element): void {
  const style = (element as HTMLElement).style;
  if (!style) return;
  if (style.display === 'none') style.removeProperty('display');
  if (style.visibility === 'hidden' || style.visibility === 'collapse') {
    style.removeProperty('visibility');
  }
  if (style.opacity === '0') style.removeProperty('opacity');
  if (style.getPropertyValue('content-visibility') === 'hidden') {
    style.removeProperty('content-visibility');
  }
}

function removeMatchingDisplayNone(
  document: Document,
  element: Element
): RemovedDisplay[] {
  const removed: RemovedDisplay[] = [];

  const visit = (rules: CSSRuleList): void => {
    for (const rule of Array.from(rules)) {
      if ('selectorText' in rule && 'style' in rule) {
        const css = rule as CSSStyleRule;
        try {
          if (
            element.matches(css.selectorText) &&
            css.style.getPropertyValue('display') === 'none'
          ) {
            removed.push({
              style: css.style,
              value: 'none',
              priority: css.style.getPropertyPriority('display')
            });
            css.style.removeProperty('display');
          }
        } catch {
          // Invalid or unsupported selector; leave it alone.
        }
      }
      if ('cssRules' in rule) {
        try {
          visit((rule as CSSGroupingRule).cssRules);
        } catch {
          // Cross-origin sheet; its rules are opaque.
        }
      }
    }
  };

  for (const sheet of Array.from(document.styleSheets)) {
    try {
      visit(sheet.cssRules);
    } catch {
      // Cross-origin sheet.
    }
  }
  return removed;
}

function forceDisplay(document: Document, element: Element): void {
  if (computedDisplay(document, element) !== 'none') return;
  const removed = removeMatchingDisplayNone(document, element);
  const display = computedDisplay(document, element);
  for (const entry of removed) {
    entry.style.setProperty('display', entry.value, entry.priority);
  }
  (element as HTMLElement).style.setProperty(
    'display',
    display === 'none' ? 'block' : display,
    'important'
  );
}

function forceVisible(document: Document, element: Element): void {
  const style = computedStyle(document, element);
  if (!style) return;
  const target = (element as HTMLElement).style;
  if (style.visibility !== 'visible') {
    target.setProperty('visibility', 'visible', 'important');
  }
  if (style.opacity === '0') {
    target.setProperty('opacity', '1', 'important');
  }
  if (style.getPropertyValue('content-visibility') === 'hidden') {
    target.setProperty('content-visibility', 'visible', 'important');
  }
}

/**
 * Mirrors the renderer reveal pass inside a script-free preview iframe. Only
 * the cloned slide root and its ancestors are touched; authored hiding inside
 * the slide is preserved.
 */
export function revealPreviewSlide(frameDocument: Document): Element | null {
  if (!frameDocument.body) return null;
  const root =
    frameDocument.querySelector(`[${PREVIEW_SLIDE_ATTRIBUTE}]`) ??
    frameDocument.body;
  const chain: Element[] = [];
  for (
    let current: Element | null = root;
    current;
    current = current.parentElement
  ) {
    chain.push(current);
  }

  const wasHidden =
    root.hasAttribute('hidden') ||
    computedDisplay(frameDocument, root) === 'none';
  for (const element of chain) {
    element.removeAttribute('hidden');
    removeInlineHiding(element);
  }
  if (wasHidden) root.classList.add('active');
  for (const element of chain) {
    forceDisplay(frameDocument, element);
    forceVisible(frameDocument, element);
  }
  return root;
}
