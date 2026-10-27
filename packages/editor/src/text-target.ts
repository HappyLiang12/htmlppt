import { isGroupElement, isHiddenElement, isLockedElement } from './commands/objects';
import { elementAtPath } from './selection';
import {
  TEXT_EDITABLE_SELECTOR,
  textEditBlockFor,
  topLevelBlockFor,
  type EditHintReason
} from './text-edit-block';

export type TextTargetResult =
  | { status: 'editable'; leaf: HTMLElement; empty: boolean }
  | { status: 'blocked'; reason: EditHintReason };

export function isLeafTextElement(element: HTMLElement): boolean {
  if (element.tagName !== 'DIV') return true;
  return Array.from(element.children).every((child) => child.tagName === 'BR');
}

function guardReasonWithin(element: Element, top: Element): EditHintReason | null {
  for (
    let current: Element | null = element;
    current;
    current = current.parentElement
  ) {
    if (isLockedElement(current)) return 'locked';
    if (isHiddenElement(current)) return 'hidden';
    if (isGroupElement(current)) return 'group';
    if (current === top) break;
  }
  return null;
}

function candidatesOf(root: Element): HTMLElement[] {
  const candidates: HTMLElement[] = [];
  if (root.matches(TEXT_EDITABLE_SELECTOR)) candidates.push(root as HTMLElement);
  candidates.push(
    ...Array.from(root.querySelectorAll<HTMLElement>(TEXT_EDITABLE_SELECTOR))
  );
  return candidates;
}

/**
 * Resolves the one leaf that Enter, the Text tab, and the selection toolbar
 * format. A wrapper object resolves its first editable descendant; guarded
 * and empty semantic candidates are skipped, while an empty DIV/TD/TH stays
 * editable so a text box can accept its first text.
 */
export function resolveSelectedTextTarget(
  slide: Element,
  path: readonly number[]
): TextTargetResult {
  const selected = elementAtPath(slide, path);
  const top = elementAtPath(slide, [path[0] ?? -1]);
  if (!selected || !top) return { status: 'blocked', reason: 'not-text' };

  const topGuard = topLevelBlockFor(top);
  if (topGuard) return { status: 'blocked', reason: topGuard };

  let lastGuard: EditHintReason | null = null;
  let sawEmpty = false;
  for (const candidate of candidatesOf(selected)) {
    if (!isLeafTextElement(candidate)) continue;
    const guard = guardReasonWithin(candidate, top);
    if (guard) {
      lastGuard = guard;
      continue;
    }
    const empty = !candidate.textContent?.trim();
    if (
      empty &&
      candidate.tagName !== 'DIV' &&
      candidate.tagName !== 'TD' &&
      candidate.tagName !== 'TH'
    ) {
      sawEmpty = true;
      continue;
    }
    return { status: 'editable', leaf: candidate, empty };
  }

  if (lastGuard) return { status: 'blocked', reason: lastGuard };
  if (sawEmpty) return { status: 'blocked', reason: 'empty' };
  return {
    status: 'blocked',
    reason: textEditBlockFor(selected) ?? 'not-text'
  };
}
