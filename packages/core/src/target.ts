export type ElementTarget =
  | { elementId: string }
  | { selector: string }
  | { path: number[] };

export class DeckMutationError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly details?: unknown
  ) {
    super(message);
    this.name = 'DeckMutationError';
  }
}

function fail(code: string, message: string): never {
  throw new DeckMutationError(code, message);
}

export function resolveTarget(slide: Element, target: ElementTarget): Element {
  if ('elementId' in target) {
    const id = target.elementId.trim();
    const matches = Array.from(slide.querySelectorAll('[data-ppt-el]')).filter(
      (element) => element.getAttribute('data-ppt-el')?.trim() === id
    );
    if (matches.length === 0) fail('target-not-found', `Element "${id}" was not found.`);
    if (matches.length > 1) fail('target-ambiguous', `Element "${id}" matches more than one node.`);
    return matches[0];
  }

  if ('selector' in target) {
    let matches: Element[];
    try {
      matches = Array.from(slide.querySelectorAll(target.selector));
    } catch {
      fail('target-invalid', `Selector "${target.selector}" is not valid.`);
    }
    if (matches.length === 0) {
      fail('target-not-found', `Selector "${target.selector}" matched nothing.`);
    }
    if (matches.length > 1) {
      fail('target-ambiguous', `Selector "${target.selector}" matched ${matches.length} nodes.`);
    }
    return matches[0];
  }

  if (target.path.length === 0) fail('target-invalid', 'Target path must not be empty.');
  let current: Element = slide;
  for (const index of target.path) {
    if (!Number.isInteger(index) || index < 0) {
      fail('target-invalid', 'Target path must contain non-negative integers.');
    }
    const child = current.children[index];
    if (!child) fail('target-not-found', 'Target path does not resolve inside the slide.');
    current = child;
  }
  return current;
}
