import type { Translator } from './i18n';

const MAX_TEXT_LENGTH = 40;

function shortText(element: Element): string {
  return (element.textContent ?? '').replace(/\s+/g, ' ').trim();
}

/**
 * Short, stable status text for the polite live region. It intentionally
 * depends only on the committed selection, never on gesture geometry.
 */
export function describeSelection(
  element: Element | null,
  count: number,
  t: Translator
): string {
  if (count <= 0 || !element) return t('app.deselected');
  if (count > 1) return t('a11y.selectedCount', { count });
  const tag = element.tagName.toLowerCase();
  const text = shortText(element);
  if (!text) return t('a11y.selectedTag', { tag });
  const summary =
    text.length > MAX_TEXT_LENGTH
      ? `${text.slice(0, MAX_TEXT_LENGTH - 1)}…`
      : text;
  return t('a11y.selectedSummary', { tag, summary });
}

export function describeSlide(
  index: number,
  total: number,
  t: Translator
): string {
  return t('a11y.slide', { index: index + 1, total });
}
