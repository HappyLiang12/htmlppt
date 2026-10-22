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
  count: number
): string {
  if (count <= 0 || !element) return '已取消選取';
  if (count > 1) return `已選取 ${count} 個物件`;
  const tag = element.tagName.toLowerCase();
  const text = shortText(element);
  if (!text) return `已選取 ${tag}`;
  const summary =
    text.length > MAX_TEXT_LENGTH
      ? `${text.slice(0, MAX_TEXT_LENGTH - 1)}…`
      : text;
  return `已選取 ${tag}：${summary}`;
}

export function describeSlide(index: number, total: number): string {
  return `第 ${index + 1} 頁，共 ${total} 頁`;
}
