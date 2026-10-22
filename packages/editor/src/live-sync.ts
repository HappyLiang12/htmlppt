import type { SelectionTarget } from './selection';

export type RevisionSource = 'editor' | 'external' | 'mcp';

/**
 * A revision signal from the host SSE stream. `hello` is sent once per
 * connection and carries the current revision without a source; `revision`
 * follows every accepted write.
 */
export interface DeckRevisionEvent {
  type: 'hello' | 'revision';
  revision: string;
  source?: RevisionSource;
}

export interface SyncSnapshot {
  revision: string;
  dirty: boolean;
}

export type RevisionDecision =
  | { type: 'ignore' }
  | { type: 'apply'; revision: string; source?: RevisionSource }
  | { type: 'conflict'; revision: string; source?: RevisionSource };

/**
 * Decides what a revision event means for the editor. Self writes are
 * recognized by revision equality, so a save event that overtakes its own PUT
 * response is ignored once the response lands (the controller defers events
 * while a save is in flight). Clean editors apply automatically; dirty editors
 * never lose work silently and surface a conflict instead.
 */
export function decideRevision(
  event: DeckRevisionEvent,
  snapshot: SyncSnapshot
): RevisionDecision {
  if (!event.revision || event.revision === snapshot.revision) {
    return { type: 'ignore' };
  }
  if (snapshot.dirty) {
    return {
      type: 'conflict',
      revision: event.revision,
      source: event.source
    };
  }
  return { type: 'apply', revision: event.revision, source: event.source };
}

export type ConflictResolution = 'reload' | 'overwrite';

export interface ConflictResolutionPlan {
  /** Fetch the host deck and discard local edits. */
  applyExternal: boolean;
  /** PUT the local deck with `force: true`. */
  force: boolean;
  /** Both choices resolve the conflict banner. */
  clearConflict: boolean;
}

export function planConflictResolution(
  resolution: ConflictResolution
): ConflictResolutionPlan {
  return {
    applyExternal: resolution === 'reload',
    force: resolution === 'overwrite',
    clearConflict: true
  };
}

export const AUTOSAVE_DELAY_MS = 800;

export interface Autosave {
  /** Restarts the delay; only the last schedule in a burst saves. */
  schedule(): void;
  /** Drops a pending save. */
  cancel(): void;
  /** Runs a pending save now instead of waiting for the delay. */
  flush(): void;
}

/**
 * Timer-only debounce unit. The save itself lives in the controller, so this
 * remains pure and testable with fake timers and no network.
 */
export function createAutosave(
  delayMs: number,
  run: () => void
): Autosave {
  let timer: ReturnType<typeof setTimeout> | null = null;

  const cancel = () => {
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
  };

  return {
    schedule() {
      cancel();
      timer = setTimeout(() => {
        timer = null;
        run();
      }, delayMs);
    },
    cancel,
    flush() {
      if (timer !== null) {
        cancel();
        run();
      }
    }
  };
}

export interface SlideSelectionSource {
  id: string;
  element: Element;
}

function elementPathFromSlide(
  slide: Element,
  element: Element
): number[] | null {
  const path: number[] = [];
  let current: Element | null = element;
  while (current && current !== slide) {
    const parent: Element | null = current.parentElement;
    if (!parent) return null;
    path.unshift(Array.from(parent.children).indexOf(current));
    current = parent;
  }
  return current === slide ? path : null;
}

function elementById(slide: Element, elementId: string): Element | null {
  for (const candidate of Array.from(
    slide.querySelectorAll('[data-ppt-el]')
  )) {
    if (candidate.getAttribute('data-ppt-el') === elementId) {
      return candidate;
    }
  }
  return null;
}

/**
 * Carries a selection across an external master replacement by slide id and
 * `data-ppt-el` id. Targets that no longer resolve are dropped rather than
 * retargeted to whatever now sits at their old child index.
 */
export function remapSelections(
  targets: readonly SelectionTarget[],
  previousSlides: readonly SlideSelectionSource[],
  nextSlides: readonly SlideSelectionSource[]
): SelectionTarget[] {
  const remapped: SelectionTarget[] = [];
  for (const target of targets) {
    if (!target.elementId) continue;
    const previousSlide = previousSlides[target.slideIndex];
    if (!previousSlide) continue;
    const nextIndex = nextSlides.findIndex(
      (slide) => slide.id === previousSlide.id
    );
    if (nextIndex < 0) continue;
    const nextSlide = nextSlides[nextIndex];
    if (!nextSlide) continue;
    const element = elementById(nextSlide.element, target.elementId);
    if (!element) continue;
    const path = elementPathFromSlide(nextSlide.element, element);
    if (!path) continue;
    remapped.push({
      slideIndex: nextIndex,
      path,
      elementId: target.elementId
    });
  }
  return remapped;
}
