export type ShortcutAction =
  | { type: 'undo' }
  | { type: 'redo' }
  | { type: 'save' }
  | { type: 'export' }
  | { type: 'duplicate' }
  | { type: 'group' }
  | { type: 'ungroup' }
  | { type: 'zoom-in' }
  | { type: 'zoom-out' }
  | { type: 'zoom-fit' }
  | { type: 'select-all' }
  | { type: 'copy' }
  | { type: 'paste' }
  | { type: 'delete' }
  | { type: 'escape' }
  | { type: 'edit' }
  | { type: 'play' }
  | { type: 'play-from-current' }
  | { type: 'help' }
  | { type: 'nudge'; dx: number; dy: number };

/**
 * The keyboard event surface the dispatcher needs. Keeping it structural lets
 * the mapping stay pure and lets the iframe's KeyboardEvent travel through the
 * same contract as the editor document's.
 */
export interface ShortcutEventLike {
  key: string;
  ctrlKey?: boolean;
  metaKey?: boolean;
  shiftKey?: boolean;
  altKey?: boolean;
  target?: EventTarget | null;
  isComposing?: boolean;
  repeat?: boolean;
}

const ARROW_VECTORS: Record<string, readonly [number, number] | undefined> = {
  ArrowLeft: [-1, 0],
  ArrowRight: [1, 0],
  ArrowUp: [0, -1],
  ArrowDown: [0, 1]
};

const FORM_SELECTOR = 'input, textarea, select';
const CONTENT_EDITABLE_SELECTOR =
  '[contenteditable]:not([contenteditable="false"]), [data-ppt-editing]';

function elementTarget(target: EventTarget | null | undefined): Element | null {
  if (!target) return null;
  const node = target as Node;
  if (node.nodeType === 1) return node as Element;
  if (node.nodeType === 3) return node.parentElement;
  return null;
}

/**
 * True while the focused target owns the keystroke: form controls and
 * contenteditable text (including the editor's in-place text marker). Editor
 * shortcuts must never steal keys from these targets.
 */
export function isEditableShortcutTarget(
  target: EventTarget | null | undefined
): boolean {
  const element = elementTarget(target);
  if (!element) return false;
  if (element.closest(FORM_SELECTOR)) return true;
  if ((element as HTMLElement).isContentEditable) return true;
  return element.closest(CONTENT_EDITABLE_SELECTOR) !== null;
}

function primaryModifier(event: ShortcutEventLike): boolean {
  return Boolean(event.ctrlKey || event.metaKey);
}

function normalizedKey(event: ShortcutEventLike): string {
  return event.key.length === 1 ? event.key.toLowerCase() : event.key;
}

function nudge(dx: number, dy: number): ShortcutAction {
  return { type: 'nudge', dx, dy };
}

/**
 * Maps a keyboard event to an editor action. The function is pure: it never
 * reads the document, and it returns null whenever an editable target owns the
 * key or the combination is not one of the published shortcuts.
 */
export function mapShortcut(
  event: ShortcutEventLike
): ShortcutAction | null {
  if (event.isComposing) return null;
  if (isEditableShortcutTarget(event.target)) return null;

  // Alt chords belong to the pointer drill-in gesture, not to shortcuts.
  if (event.altKey) return null;

  const key = normalizedKey(event);
  const shift = Boolean(event.shiftKey);

  if (primaryModifier(event)) {
    if (shift) {
      if (key === 'z') return { type: 'redo' };
      if (key === 'e') return { type: 'export' };
      if (key === 'g') return { type: 'ungroup' };
      // A US layout reports the plus key as shift+equals.
      if (key === '=' || key === '+') return { type: 'zoom-in' };
      return null;
    }
    if (key === 'z') return { type: 'undo' };
    if (key === 'y') return { type: 'redo' };
    if (key === 's') return { type: 'save' };
    if (key === 'd') return { type: 'duplicate' };
    if (key === 'g') return { type: 'group' };
    if (key === 'a') return { type: 'select-all' };
    if (key === 'c') return { type: 'copy' };
    if (key === 'v') return { type: 'paste' };
    if (key === '=' || key === '+') return { type: 'zoom-in' };
    if (key === '-') return { type: 'zoom-out' };
    if (key === '0') return { type: 'zoom-fit' };
    return null;
  }

  if (shift) {
    const direction = ARROW_VECTORS[key];
    if (direction) return nudge(direction[0] * 10, direction[1] * 10);
    if (key === 'F5') return { type: 'play-from-current' };
    if (key === '?') return { type: 'help' };
    return null;
  }

  if (key === 'Delete' || key === 'Backspace') return { type: 'delete' };
  if (key === 'Escape') return { type: 'escape' };
  if (key === 'Enter') return { type: 'edit' };
  if (key === 'F5') return { type: 'play' };
  if (key === '?') return { type: 'help' };

  const direction = ARROW_VECTORS[key];
  if (direction) return nudge(direction[0], direction[1]);
  return null;
}

export type TextShortcutAction = {
  type: 'bold' | 'italic' | 'underline';
};

/**
 * Text commands are separate from mapShortcut: contenteditable targets own
 * normal shortcuts, but B/I/U must still reach the text command layer. The
 * caller decides whether a text target exists and whether a form field owns
 * the key.
 */
export function mapTextShortcut(
  event: ShortcutEventLike
): TextShortcutAction | null {
  if (event.isComposing || event.repeat) return null;
  if (event.altKey || event.shiftKey) return null;
  if (!primaryModifier(event)) return null;
  const key = normalizedKey(event);
  if (key === 'b') return { type: 'bold' };
  if (key === 'i') return { type: 'italic' };
  if (key === 'u') return { type: 'underline' };
  return null;
}
