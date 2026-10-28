import {
  isGroupElement,
  isHiddenElement,
  isLockedElement
} from './commands/objects';
import type { MessageKey } from './i18n';

export type TextEditBlock = 'not-text' | 'has-children' | 'empty';

/** Every reason the rejected-gesture hint can name. */
export type EditHintReason =
  | TextEditBlock
  | 'locked'
  | 'hidden'
  | 'group'
  | 'table-cell';

/** Guard reasons only; table-cell is a movement hint, not a guard. */
export type TopLevelBlock = 'locked' | 'hidden' | 'group';

/**
 * One catalog key per reason, typed so a new reason cannot ship without
 * localized copy in every dictionary.
 */
export const EDIT_HINT_KEYS: Record<EditHintReason, MessageKey> = {
  'not-text': 'editor.hint.not-text',
  'has-children': 'editor.hint.has-children',
  empty: 'editor.hint.empty',
  locked: 'editor.hint.locked',
  hidden: 'editor.hint.hidden',
  group: 'editor.hint.group',
  'table-cell': 'editor.hint.table-cell-move'
};

/**
 * The top-level guard refuses both an in-place text edit and container entry,
 * so neither edit path can explain itself. Locked wins over hidden, hidden
 * over group, matching the double-click handler's historical order. Null means
 * the guard does not block the gesture.
 */
export function topLevelBlockFor(top: Element | null): TopLevelBlock | null {
  if (!top) return null;
  if (isLockedElement(top)) return 'locked';
  if (isHiddenElement(top)) return 'hidden';
  if (isGroupElement(top)) return 'group';
  return null;
}

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
 * The nearest ancestor-or-self carrying a guard, with the same precedence as
 * the top-level wrapper: locked, hidden, then group. A nested authored lock,
 * hidden wrapper, or group inside an unlocked top-level object owns its
 * subtree the same way, so the text contract must not speak for it. Resolving
 * from the target upward keeps the deepest guard's own reason, which is the
 * one the gesture actually hit.
 */
function nearestGuardReason(target: Element): TopLevelBlock | null {
  for (
    let current: Element | null = target;
    current;
    current = current.parentElement
  ) {
    if (isLockedElement(current)) return 'locked';
    if (isHiddenElement(current)) return 'hidden';
    if (isGroupElement(current)) return 'group';
  }
  return null;
}

/**
 * Names why a double-click cannot start an in-place text edit, or returns
 * null when it can. A guard — locked, hidden, or group — on the target or any
 * ancestor wins over the text contract, so a nested authored guard reports
 * its own reason instead of has-children or not-text. Without a guard, the
 * target resolves to its nearest text tag: a layout div with element children
 * other than line breaks is a container, an empty semantic element has nothing
 * to edit, and anything else is outside the text tag contract.
 *
 * A container explains itself only when the user clicked the container
 * itself. A descendant such as a button, image, link, or SVG inside it is
 * not text: entering the container the gesture already sits in cannot start
 * an edit, so naming has-children would point at the wrong gesture.
 *
 * Tags are compared after upper-casing instead of with instanceof: double-
 * click targets come from the preview iframe's realm, where the parent
 * window's HTMLElement constructor does not describe them.
 */
export function textEditBlockFor(target: Element): EditHintReason | null {
  const guard = nearestGuardReason(target);
  if (guard) return guard;
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
    return target === candidate ? 'has-children' : 'not-text';
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
