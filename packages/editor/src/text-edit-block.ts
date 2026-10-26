export type TextEditBlock = 'not-text' | 'has-children' | 'empty';

/**
 * The tags that accept an in-place text edit. App.tsx resolves double-click
 * targets with this same selector, so the text path and the rejection reason
 * cannot drift apart.
 */
export const TEXT_EDITABLE_SELECTOR =
  'h1, h2, h3, p, li, span, td, th, blockquote, figcaption, div';

const TEXT_TAGS = new Set([
  'H1',
  'H2',
  'H3',
  'P',
  'LI',
  'SPAN',
  'TD',
  'TH',
  'BLOCKQUOTE',
  'FIGCAPTION',
  'DIV'
]);

/**
 * Names why a double-click cannot start an in-place text edit, or returns
 * null when it can. Mirrors the editor's text path: the target resolves to
 * its nearest text tag; a layout div with element children other than line
 * breaks is a container, an empty semantic element has nothing to edit, and
 * anything else is outside the text tag contract.
 *
 * Tags are compared after upper-casing instead of with instanceof: double-
 * click targets come from the preview iframe's realm, where the parent
 * window's HTMLElement constructor does not describe them.
 */
export function textEditBlockFor(target: Element): TextEditBlock | null {
  const candidate = target.closest(TEXT_EDITABLE_SELECTOR);
  if (!candidate) return 'not-text';
  const tag = candidate.tagName.toUpperCase();
  if (!TEXT_TAGS.has(tag)) return 'not-text';
  if (
    tag === 'DIV' &&
    !Array.from(candidate.children).every(
      (child) => child.tagName.toUpperCase() === 'BR'
    )
  ) {
    return 'has-children';
  }
  if (
    !candidate.textContent?.trim() &&
    tag !== 'DIV' &&
    tag !== 'TD' &&
    tag !== 'TH'
  ) {
    return 'empty';
  }
  return null;
}
