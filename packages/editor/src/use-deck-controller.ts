import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  detectSlides,
  normalizeDeck,
  serializeDeck,
  type SlideInfo
} from '@htmlppt/core';
import {
  DeckConflictError,
  hostPersistence,
  type DeckPersistence,
  type DeckResponse
} from './api';
import { History, type HistoryEntry } from './history';
import {
  AUTOSAVE_DELAY_MS,
  createAutosave,
  decideRevision,
  remapSelections,
  type Autosave,
  type DeckRevisionEvent
} from './live-sync';
import {
  elementAtPath,
  SVG_NAMESPACE,
  topLevelObjects,
  type SelectionTarget
} from './selection';
import {
  isSvgInternal,
  isTableInternal,
  normalizeSelectionPaths
} from './component-target';
import {
  collectObjectHtml,
  deleteComponentPaths,
  deleteObjectPaths,
  pasteComponentNode,
  pasteObjectHtml,
  type PastedObjectMeasure
} from './object-ops';
import { blockedPathAncestor } from './commands/objects';
import { buildSlideSrcDoc, parseDeck } from './slide-doc';
import { clampSlideIndex } from './slide-index';
import type { MessageKey, Translator } from './i18n';
import { en } from './i18n/messages/en';

const DEFAULT_TRANSLATE: Translator = (key: MessageKey) => en[key];

export type SaveStatus =
  | 'loading'
  | 'ready'
  | 'saving'
  | 'saved'
  | 'external'
  | 'conflict'
  | 'load-error'
  | 'error';

export interface DeckConflict {
  revision: string;
  source?: string;
  /** The deck the host moved to when the conflict came from /api/open. */
  filePath?: string;
}

/**
 * A conflict that belongs to a different file than the one this tab loaded,
 * or to a file this tab cannot identify because its own path is unknown.
 * Force-writing would replace the deck another tab just opened, so the only
 * safe resolution is reload.
 */
export function isSwitchedFileConflict(
  conflict: DeckConflict | null,
  filePath: string
): boolean {
  return Boolean(
    conflict?.filePath && (!filePath || conflict.filePath !== filePath)
  );
}

export interface DeckControllerState {
  master: Document | null;
  slides: SlideInfo[];
  activeIndex: number;
  /** Primary (first) selected target, kept for single-object panels. */
  selection: SelectionTarget | null;
  /** Every selected target, in selection order (all on the active slide). */
  selections: SelectionTarget[];
  scale: number;
  status: SaveStatus;
  dirty: boolean;
  pending: boolean;
  recoveryBusy: boolean;
  documentEpoch: number;
  conflict: DeckConflict | null;
  srcDoc: string;
  filePath: string;
  error: string;
}

export type SlideCommit = (master: Document, slide: SlideInfo) => string | void;
/**
 * Returning false means the mutation discovered a no-op before writing any
 * meaningful change; the controller then skips history, dirty state and save.
 */
export type MasterCommit = (master: Document) => boolean | void;

export interface SlideMutationOptions {
  coalesceKey?: string;
}

export interface PendingEdit {
  apply(): boolean;
  discard(): void;
}

interface ClipboardComponent {
  node: Element;
  /** The node lives in the SVG namespace, including an svg root. */
  svg: boolean;
  /** SVG content inside another svg; a root is not internal. */
  internal: boolean;
}

/**
 * Result of a paste gesture. A paste that targets no valid destination never
 * commits. "kind-mismatch" and "table-cell" raise a hint: an SVG internal can
 * only land inside an SVG, while HTML and an SVG root fall back to the slide;
 * a table cell has no destination that would keep the markup valid.
 */
export type PasteOutcome =
  | 'pasted'
  | 'empty'
  | 'kind-mismatch'
  | 'refused'
  | 'table-cell';

export interface DeckControllerActions {
  changePendingEdit(owner: string, edit: PendingEdit | null): void;
  cancelPendingEdit(owner: string): void;
  settlePendingEdits(owner?: string): boolean;
  load(deck?: DeckResponse): Promise<void>;
  showSlide(index: number): void;
  select(target: SelectionTarget | null): void;
  selectTargets(targets: SelectionTarget[]): void;
  toggleSelect(target: SelectionTarget): void;
  selectAll(): void;
  clearSelection(): void;
  setScale(scale: number): void;
  applySlideMutation(
    slideIndex: number,
    mutate: (slide: Element, master: Document) => void,
    options?: SlideMutationOptions
  ): string | null;
  commit(mutate: SlideCommit): Promise<void>;
  /**
   * Mutates the master directly (inspector style and slide settings) and
   * re-renders the active slide. Text commits keep using `commit`, whose
   * iframe reconciliation would overwrite master-side inline styles.
   */
  commitMaster(mutate: MasterCommit): Promise<void>;
  saveNow(): Promise<void>;
  copySelection(): void;
  pasteObjects(): Promise<PasteOutcome>;
  duplicateSelection(): Promise<void>;
  deleteSelection(): Promise<void>;
  undo(): void;
  redo(): void;
  reload(deck?: DeckResponse): Promise<void>;
  overwrite(): Promise<void>;
  /** Restores an IndexedDB draft as a dirty deck that autosaves next. */
  restoreDraft(html: string): void;
  /** Consumes an SSE revision (or hello) signal from the host. */
  receiveRevision(event: DeckRevisionEvent): void;
  /** Best-effort keepalive write for an unloading page with unsaved edits. */
  flushBeforeUnload(): void;
}

export interface DeckController {
  state: DeckControllerState;
  actions: DeckControllerActions;
}

export interface DeckControllerOptions {
  /**
   * Overrides host HTTP persistence; standalone tabs supply a local adapter.
   */
  persistence?: DeckPersistence;
  /**
   * Bridges pasted-object measurement to the rendered preview. The master
   * document is inert, so class-supplied positions require live layout; when
   * absent, paste falls back to master-document geometry.
   */
  measurePastedObject?: PastedObjectMeasure;
  /**
   * Localizes controller-produced error text. The hook deliberately does not
   * call useI18n so controller tests can run without a provider; App passes t
   * and unit tests may pass a stub. Defaults to the English catalog.
   */
  translate?: Translator;
}

// Authored editor-only attributes are a contract error under the M1 host rules
// (the host rejects such a save with 400). Normalizing would strip them and
// launder the invalid deck into a successful write, so load leaves decks that
// carry them untouched for the host to reject.
const EDITOR_ARTIFACT_SELECTOR =
  '[data-ppt-editing], [data-ppt-frame-slide]';

export function hasEditorArtifacts(doc: Document): boolean {
  return doc.querySelector(EDITOR_ARTIFACT_SELECTOR) !== null;
}

function createInitialState(): DeckControllerState {
  return {
    master: null,
    slides: [],
    activeIndex: 0,
    selection: null,
    selections: [],
    scale: 1,
    status: 'loading',
    dirty: false,
    pending: false,
    recoveryBusy: false,
    documentEpoch: 0,
    conflict: null,
    srcDoc: '',
    filePath: '',
    error: ''
  };
}

function sameTarget(a: SelectionTarget, b: SelectionTarget): boolean {
  return (
    a.slideIndex === b.slideIndex &&
    a.path.length === b.path.length &&
    a.path.every((index, position) => index === b.path[position])
  );
}

function toMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

function sourceDocFor(master: Document, index: number): {
  slides: SlideInfo[];
  activeIndex: number;
  srcDoc: string;
} {
  const slides = detectSlides(master);
  const activeIndex = clampSlideIndex(index, slides.length);
  const slide = slides[activeIndex];
  return {
    slides,
    activeIndex,
    srcDoc: slide ? buildSlideSrcDoc(master, slide) : ''
  };
}

export function useDeckController(
  options: DeckControllerOptions = {}
): DeckController {
  const [state, setState] = useState<DeckControllerState>(createInitialState);
  const stateRef = useRef(state);
  const masterRef = useRef<Document | null>(null);
  const slidesRef = useRef<SlideInfo[]>([]);
  const activeIndexRef = useRef(0);
  const revisionRef = useRef('');
  const saveChainRef = useRef<Promise<void>>(Promise.resolve());
  const saveGenerationRef = useRef(0);
  const saveInFlightRef = useRef(0);
  const editVersionRef = useRef(0);
  const committedVersionRef = useRef(0);
  const operationGenerationRef = useRef(0);
  const pendingEditsRef = useRef(new Map<string, PendingEdit>());
  const settlingRef = useRef(false);
  const historyRef = useRef(new History<string, number>());
  const clipboardRef = useRef<ClipboardComponent[]>([]);
  const persistenceRef = useRef<DeckPersistence>(
    options.persistence ?? hostPersistence()
  );
  const measurePastedRef = useRef(options.measurePastedObject);
  measurePastedRef.current = options.measurePastedObject;
  const translate = options.translate ?? DEFAULT_TRANSLATE;

  // Function refs break the cycle between the save queue, the autosave timer,
  // and the SSE drain: each callback is created below but may run after any
  // render.
  const autosaveActionRef = useRef<() => void>(() => undefined);
  const scheduleAutosaveRef = useRef<() => void>(() => undefined);
  const drainLiveEventsRef = useRef<() => void>(() => undefined);
  const liveEventsRef = useRef<DeckRevisionEvent[]>([]);
  const acknowledgedRevisionsRef = useRef(new Set<string>());
  const liveDrainingRef = useRef(false);
  const externalBusyRef = useRef(false);
  const autosaveRef = useRef<Autosave | null>(null);
  if (autosaveRef.current === null) {
    autosaveRef.current = createAutosave(AUTOSAVE_DELAY_MS, () => {
      autosaveActionRef.current();
    });
  }

  useEffect(() => {
    const autosave = autosaveRef.current;
    return () => autosave?.cancel();
  }, []);

  const update = useCallback((patch: Partial<DeckControllerState>) => {
    const next = { ...stateRef.current, ...patch };
    stateRef.current = next;
    setState(next);
  }, []);

  const syncPending = useCallback(() => {
    const pending = pendingEditsRef.current.size > 0;
    update({ pending });
    if (!pending && stateRef.current.dirty) scheduleAutosaveRef.current();
  }, [update]);

  const changePendingEdit = useCallback((owner: string, edit: PendingEdit | null) => {
    editVersionRef.current += 1;
    if (edit) pendingEditsRef.current.set(owner, edit);
    else pendingEditsRef.current.delete(owner);
    autosaveRef.current?.cancel();
    syncPending();
  }, [syncPending]);

  const cancelPendingEdit = useCallback((owner: string) => {
    const edit = pendingEditsRef.current.get(owner);
    pendingEditsRef.current.delete(owner);
    edit?.discard();
    syncPending();
  }, [syncPending]);

  const settlePendingEdits = useCallback((owner?: string): boolean => {
    if (settlingRef.current) return true;
    settlingRef.current = true;
    try {
      for (const [key, edit] of pendingEditsRef.current) {
        if (owner !== undefined && key !== owner) continue;
        pendingEditsRef.current.delete(key);
        if (!edit.apply()) {
          pendingEditsRef.current.set(key, edit);
          update({ error: translate('editor.pendingEditFailed') });
          return false;
        }
      }
      return true;
    } finally {
      settlingRef.current = false;
      syncPending();
    }
  }, [syncPending, translate, update]);

  const enqueueSave = useCallback(
    (
      save: (revision: string) => Promise<{ revision: string }>,
      resolvedConflict: DeckConflict | null = null
    ) => {
      const generation = saveGenerationRef.current;
      const committedVersion = committedVersionRef.current;
      saveInFlightRef.current += 1;
      const run = saveChainRef.current.then(async () => {
        // A load or reload that happened while this save was queued owns the
        // deck now; writing would persist stale content.
        if (saveGenerationRef.current !== generation) return;
        try {
          const saved = await save(revisionRef.current);
          if (saved.revision !== revisionRef.current) {
            acknowledgedRevisionsRef.current.add(saved.revision);
          }
          revisionRef.current = saved.revision;
          const conflict = stateRef.current.conflict === resolvedConflict
            ? null
            : stateRef.current.conflict;
          const dirty = committedVersionRef.current !== committedVersion;
          update({
            status: conflict ? 'conflict' : dirty ? 'saving' : 'saved',
            dirty,
            error: '',
            conflict
          });
          if (dirty) scheduleAutosaveRef.current();
        } catch (cause) {
          if (cause instanceof DeckConflictError) {
            // Never retry a conflict: the banner offers reload or overwrite.
            autosaveRef.current?.cancel();
            // A pathless 409 (for example a non-JSON proxy response) must not
            // drop a switched-deck marker recorded by an earlier event.
            const conflictFilePath =
              cause.filePath ?? stateRef.current.conflict?.filePath;
            update({
              conflict: {
                revision: cause.revision,
                ...(conflictFilePath ? { filePath: conflictFilePath } : {})
              },
              status: 'conflict',
              error: ''
            });
          } else {
            update({ status: 'error', error: toMessage(cause), dirty: true });
          }
          throw cause;
        }
      });
      saveChainRef.current = run.then(
        () => undefined,
        () => undefined
      );
      return run.finally(() => {
        saveInFlightRef.current -= 1;
        drainLiveEventsRef.current();
      });
    },
    [update]
  );

  // Commit paths only mark the deck dirty and restart the debounce; the PUT is
  // issued from here 800 ms later with the latest master.
  scheduleAutosaveRef.current = () => {
    if (!stateRef.current.conflict && !pendingEditsRef.current.size && !externalBusyRef.current) {
      autosaveRef.current?.schedule();
    }
  };

  autosaveActionRef.current = () => {
    if (stateRef.current.conflict || pendingEditsRef.current.size || externalBusyRef.current) return;
    const master = masterRef.current;
    if (!master) return;
    const html = serializeDeck(master);
    update({ status: 'saving', error: '' });
    void enqueueSave((revision) =>
      persistenceRef.current.save(html, revision)
    ).catch(() => undefined);
  };

  const load = useCallback(
    async (provided?: DeckResponse) => {
      // Invalidate queued saves for the outgoing deck, then let an in-flight
      // save finish before the revision is replaced by the fetched one.
      saveGenerationRef.current += 1;
      autosaveRef.current?.cancel();
      liveEventsRef.current = [];
      await saveChainRef.current;
      update({ status: 'loading', error: '' });
      try {
        const deck = provided ?? (await persistenceRef.current.load());
        const master = parseDeck(deck.html);
        if (!hasEditorArtifacts(master)) {
          normalizeDeck(master);
        }

        const source = sourceDocFor(master, 0);
        masterRef.current = master;
        revisionRef.current = deck.revision;
        slidesRef.current = source.slides;
        activeIndexRef.current = source.activeIndex;
        historyRef.current.clear();
        historyRef.current.push(serializeDeck(master), {
          meta: source.activeIndex
        });

        update({
          master,
          slides: source.slides,
          activeIndex: source.activeIndex,
          srcDoc: source.srcDoc,
          selection: null,
          selections: [],
          status: 'ready',
          dirty: false,
          conflict: null,
          documentEpoch: stateRef.current.documentEpoch + 1,
          filePath: deck.filePath,
          error: ''
        });
      } catch (cause) {
        update({ status: 'load-error', error: toMessage(cause) });
      }
    },
    [update]
  );

  const applyExternal = useCallback(
    async (deck: DeckResponse, editVersion: number, generation: number, source?: string) => {
      await saveChainRef.current;
      if (operationGenerationRef.current !== generation) return;
      if (editVersionRef.current !== editVersion) {
        autosaveRef.current?.cancel();
        update({
          conflict: {
            revision: deck.revision,
            source,
            filePath: deck.filePath
          },
          status: 'conflict',
          error: ''
        });
        return;
      }
      autosaveRef.current?.cancel();
      for (const edit of pendingEditsRef.current.values()) edit.discard();
      pendingEditsRef.current.clear();

      const master = parseDeck(deck.html);
      if (!hasEditorArtifacts(master)) {
        normalizeDeck(master);
      }
      const nextSlides = detectSlides(master);
      const previousSlides = slidesRef.current;
      const previousActiveId =
        previousSlides[activeIndexRef.current]?.id ?? null;
      let nextActive = activeIndexRef.current;
      if (previousActiveId) {
        const found = nextSlides.findIndex(
          (slide) => slide.id === previousActiveId
        );
        if (found >= 0) nextActive = found;
      }
      const activeIndex = clampSlideIndex(nextActive, nextSlides.length);
      const selections = remapSelections(
        stateRef.current.selections,
        previousSlides,
        nextSlides
      );

      masterRef.current = master;
      revisionRef.current = deck.revision;
      slidesRef.current = nextSlides;
      activeIndexRef.current = activeIndex;
      historyRef.current.clear();
      historyRef.current.push(serializeDeck(master), { meta: activeIndex });
      const slide = nextSlides[activeIndex];
      update({
        master,
        slides: nextSlides,
        activeIndex,
        srcDoc: slide ? buildSlideSrcDoc(master, slide) : '',
        selection: selections[0] ?? null,
        selections,
        status: 'ready',
        dirty: false,
        pending: false,
        documentEpoch: stateRef.current.documentEpoch + 1,
        conflict: null,
        filePath: deck.filePath,
        error: ''
      });
    },
    [update]
  );

  const drainLiveEvents = useCallback(async () => {
    if (liveDrainingRef.current) return;
    liveDrainingRef.current = true;
    try {
      while (liveEventsRef.current.length > 0) {
        // A pending or in-flight save owns the revision for now, and a reload
        // in progress must finish before events are compared against it.
        // Re-evaluate the event after it settles so our own write is
        // recognized.
        if (saveInFlightRef.current > 0 || externalBusyRef.current) return;
        if (!revisionRef.current) {
          liveEventsRef.current = [];
          break;
        }
        const acknowledgedIndex = liveEventsRef.current.findIndex((event) =>
          acknowledgedRevisionsRef.current.has(event.revision)
        );
        if (acknowledgedIndex >= 0) {
          for (const event of liveEventsRef.current.splice(0, acknowledgedIndex + 1)) {
            acknowledgedRevisionsRef.current.delete(event.revision);
          }
          continue;
        }
        const event = liveEventsRef.current.shift();
        if (!event) break;
        const decision = decideRevision(event, {
          revision: revisionRef.current,
          dirty:
            stateRef.current.dirty ||
            stateRef.current.pending ||
            stateRef.current.conflict !== null,
          filePath: stateRef.current.filePath
        });
        if (decision.type === 'ignore') continue;
        if (decision.type === 'conflict') {
          // The pending autosave would write stale content; drop it. The
          // banner is the only recovery path.
          autosaveRef.current?.cancel();
          // A switched-deck conflict is sticky: later events for that deck
          // (an ordinary save or external sync) may omit the path, and only a
          // load, reload, or applied external revision may clear the marker.
          const conflictFilePath =
            decision.filePath ?? stateRef.current.conflict?.filePath;
          update({
            conflict: {
              revision: decision.revision,
              source: decision.source,
              ...(conflictFilePath ? { filePath: conflictFilePath } : {})
            },
            status: 'conflict',
            error: ''
          });
          continue;
        }

        update({ status: 'external', error: '' });
        const editVersion = editVersionRef.current;
        const generation = operationGenerationRef.current;
        try {
          const deck = await persistenceRef.current.load();
          if (operationGenerationRef.current !== generation) continue;
          if (
            deck.revision === revisionRef.current &&
            deck.filePath === stateRef.current.filePath &&
            editVersionRef.current === editVersion
          ) {
            update({ status: 'ready' });
            continue;
          }
          await applyExternal(deck, editVersion, generation, decision.source);
        } catch (cause) {
          if (operationGenerationRef.current === generation) {
            update({ status: 'error', error: toMessage(cause) });
          }
        }
      }
    } finally {
      liveDrainingRef.current = false;
    }
  }, [applyExternal, update]);

  const receiveRevision = useCallback((event: DeckRevisionEvent) => {
    if (!revisionRef.current) return;
    liveEventsRef.current.push(event);
    drainLiveEventsRef.current();
  }, []);

  drainLiveEventsRef.current = () => {
    void drainLiveEvents();
  };

  const showSlide = useCallback(
    (index: number) => {
      if (!settlePendingEdits()) return;
      const master = masterRef.current;
      if (!master) return;
      const source = sourceDocFor(master, index);
      slidesRef.current = source.slides;
      activeIndexRef.current = source.activeIndex;
      // Navigating after an operation (for example showing a freshly added
      // slide) makes that the active context redo should return to.
      historyRef.current.updateCurrentMeta(source.activeIndex);
      update({
        slides: source.slides,
        activeIndex: source.activeIndex,
        srcDoc: source.srcDoc,
        selection: null,
        selections: []
      });
    },
    [settlePendingEdits, update]
  );

  const applySelections = useCallback(
    (targets: SelectionTarget[]) => {
      if (!settlePendingEdits()) return;
      const unique: SelectionTarget[] = [];
      for (const target of targets) {
        if (!unique.some((candidate) => sameTarget(candidate, target))) {
          unique.push(target);
        }
      }
      // Ancestor/descendant pairs collapse to the highest selected node, so a
      // cross-depth multi-selection never moves the same subtree twice.
      const uniquePaths = normalizeSelectionPaths(
        unique.map((target) => target.path)
      );
      const normalized = uniquePaths
        .map((path) =>
          unique.find((target) => target.path.join('.') === path.join('.'))
        )
        .filter((target): target is SelectionTarget => target !== undefined);
      update({ selection: normalized[0] ?? null, selections: normalized });
    },
    [settlePendingEdits, update]
  );

  const select = useCallback(
    (target: SelectionTarget | null) => {
      applySelections(target ? [target] : []);
    },
    [applySelections]
  );

  const selectTargets = useCallback(
    (targets: SelectionTarget[]) => {
      applySelections(targets);
    },
    [applySelections]
  );

  const toggleSelect = useCallback(
    (target: SelectionTarget) => {
      const current = stateRef.current;
      const base = current.selections;
      const sameSlide = base[0]?.slideIndex === target.slideIndex;
      if (!sameSlide) {
        // A target on another slide starts a fresh selection rather than
        // mixing slides.
        applySelections([target]);
        return;
      }
      const existing = base.some((candidate) => sameTarget(candidate, target));
      applySelections(
        existing
          ? base.filter((candidate) => !sameTarget(candidate, target))
          : [...base, target]
      );
    },
    [applySelections]
  );

  const selectAll = useCallback(() => {
    const slide = slidesRef.current[activeIndexRef.current];
    if (!slide) return;
    const targets = topLevelObjects(slide.element).map((element) => ({
      slideIndex: activeIndexRef.current,
      path: [Array.from(slide.element.children).indexOf(element)],
      elementId: element.getAttribute('data-ppt-el')?.trim() || null
    }));
    applySelections(targets);
  }, [applySelections]);

  const clearSelection = useCallback(() => {
    if (!settlePendingEdits()) return;
    update({ selection: null, selections: [] });
  }, [settlePendingEdits, update]);

  const setScale = useCallback(
    (scale: number) => {
      update({ scale: Number.isFinite(scale) && scale > 0 ? scale : 1 });
    },
    [update]
  );

  const applySlideMutation = useCallback(
    (
      slideIndex: number,
      mutate: (slide: Element, master: Document) => void,
      mutationOptions: SlideMutationOptions = {}
    ): string | null => {
      if (!settlePendingEdits()) return null;
      const master = masterRef.current;
      if (!master) return null;
      const slides = detectSlides(master);
      const slide = slides[slideIndex];
      if (!slide) return null;

      mutate(slide.element, master);
      editVersionRef.current += 1;
      committedVersionRef.current += 1;
      const html = serializeDeck(master);
      historyRef.current.push(html, {
        coalesceKey: mutationOptions.coalesceKey,
        meta: activeIndexRef.current
      });

      const source = sourceDocFor(master, activeIndexRef.current);
      slidesRef.current = source.slides;
      activeIndexRef.current = source.activeIndex;
      update({
        slides: source.slides,
        activeIndex: source.activeIndex,
        srcDoc: source.srcDoc,
        dirty: true
      });
      scheduleAutosaveRef.current();
      return html;
    },
    [settlePendingEdits, update]
  );

  const commit = useCallback(
    async (mutate: SlideCommit) => {
      if (!settlePendingEdits()) return;
      const master = masterRef.current;
      const slide = slidesRef.current[activeIndexRef.current];
      if (!master || !slide) return;

      let html: string;
      try {
        const result = mutate(master, slide);
        html = typeof result === 'string' ? result : serializeDeck(master);
      } catch (cause) {
        // The mutation threw before touching the master, so dirty is unchanged.
        update({
          status: 'error',
          error: toMessage(cause)
        });
        throw cause;
      }
      editVersionRef.current += 1;
      committedVersionRef.current += 1;
      historyRef.current.push(html, { meta: activeIndexRef.current });

      const slides = detectSlides(master);
      slidesRef.current = slides;
      update({
        slides,
        dirty: true,
        status: stateRef.current.conflict ? 'conflict' : 'saving'
      });
      scheduleAutosaveRef.current();
    },
    [settlePendingEdits, update]
  );

  const commitMaster = useCallback(
    async (mutate: MasterCommit) => {
      if (!settlePendingEdits()) return;
      const master = masterRef.current;
      if (!master) return;

      let html: string;
      try {
        const changed = mutate(master);
        if (changed === false) return;
        html = serializeDeck(master);
      } catch (cause) {
        // The master may be partially mutated, but no snapshot was recorded,
        // so the dirty flag keeps its previous value.
        update({ status: 'error', error: toMessage(cause) });
        throw cause;
      }
      editVersionRef.current += 1;
      committedVersionRef.current += 1;
      historyRef.current.push(html, { meta: activeIndexRef.current });

      const source = sourceDocFor(master, activeIndexRef.current);
      slidesRef.current = source.slides;
      activeIndexRef.current = source.activeIndex;
      update({
        slides: source.slides,
        activeIndex: source.activeIndex,
        srcDoc: source.srcDoc,
        dirty: true,
        status: stateRef.current.conflict ? 'conflict' : 'saving'
      });
      scheduleAutosaveRef.current();
    },
    [settlePendingEdits, update]
  );

  const copySelection = useCallback(() => {
    const targets = stateRef.current.selections.filter(
      (target) => target.slideIndex === activeIndexRef.current
    );
    if (targets.length === 0) return;
    const slide = slidesRef.current[activeIndexRef.current];
    if (!slide) return;
    const components: ClipboardComponent[] = [];
    for (const target of targets) {
      const element = elementAtPath(slide.element, target.path);
      if (!element || isTableInternal(element)) continue;
      const svg = element.namespaceURI === SVG_NAMESPACE;
      components.push({
        node: element.cloneNode(true) as Element,
        svg,
        internal: svg && isSvgInternal(element)
      });
    }
    if (components.length > 0) clipboardRef.current = components;
  }, []);

  const pasteHtml = useCallback(
    async (html: readonly string[]) => {
      const slideIndex = activeIndexRef.current;
      if (html.length === 0 || !masterRef.current) return;
      if (!slidesRef.current[slideIndex]) return;

      // Select the pasted objects inside the mutation, before the save is
      // awaited. Reconciling after a slow save would retarget the selection
      // when the user switched slides or selected something else meanwhile.
      await commitMaster((master) => {
        const pasted = pasteObjectHtml(
          master,
          slideIndex,
          html,
          measurePastedRef.current
        );
        // A paste that produced no target must not add history, dirty the
        // deck, or schedule an autosave.
        if (pasted.length === 0) return false;
        if (activeIndexRef.current === slideIndex) {
          applySelections(pasted);
        }
      });
    },
    [applySelections, commitMaster]
  );

  const pasteObjects = useCallback(async (): Promise<PasteOutcome> => {
    const components = clipboardRef.current;
    if (components.length === 0) return 'empty';
    const slide = slidesRef.current[activeIndexRef.current];
    if (!slide) return 'empty';
    const selected = stateRef.current.selections.filter(
      (target) => target.slideIndex === activeIndexRef.current
    );
    // A table cell owns no valid insertion point: a component between cells or
    // rows would produce markup the table cannot represent, so the gesture
    // explains itself before any destination is resolved.
    if (selected.length === 1) {
      const target = selected[0];
      const element =
        target && target.path.length > 1
          ? elementAtPath(slide.element, target.path)
          : null;
      if (element && isTableInternal(element)) return 'table-cell';
    }
    // A multi-selection is a slide-level paste only while every target is a
    // slide child; a nested path in the mix has no unambiguous destination.
    if (
      selected.length > 1 &&
      selected.some((target) => target.path.length > 1)
    ) {
      return 'refused';
    }
    const anchor = selected.length === 1 ? selected[0] : null;
    const anchorPath = anchor?.path ?? null;
    const parentPath =
      anchorPath !== null && anchorPath.length > 1
        ? anchorPath.slice(0, -1)
        : null;
    // A guarded subtree owns its children, so a paste into it is refused even
    // when the kinds would match.
    if (
      parentPath !== null &&
      anchorPath !== null &&
      blockedPathAncestor(slide.element, anchorPath) !== null
    ) {
      return 'refused';
    }
    // A nested anchor offers one insertion point. A clipboard with several
    // components would fan out multiple siblings under a component, which the
    // nested structural rule refuses as a whole.
    if (parentPath !== null && components.length > 1) {
      return 'refused';
    }

    let kindMismatch = false;
    let pastedCount = 0;
    await commitMaster((master) => {
      const targets: SelectionTarget[] = [];
      const parent =
        parentPath !== null ? elementAtPath(slide.element, parentPath) : null;
      for (const component of components) {
        if (parentPath !== null && anchorPath !== null && parent !== null) {
          // Kind, not tag, decides a nested destination: HTML content lands
          // in HTML and SVG content lands in SVG.
          const kindsMatch =
            component.svg === (parent.namespaceURI === SVG_NAMESPACE);
          if (kindsMatch) {
            const pasted = pasteComponentNode(
              master,
              activeIndexRef.current,
              component.node,
              parentPath,
              anchorPath,
              measurePastedRef.current
            );
            if (pasted) targets.push(pasted);
            continue;
          }
          // An SVG internal has no slide-level destination; HTML content and
          // an svg root keep the historical slide-level fallback.
          if (component.internal) {
            kindMismatch = true;
            continue;
          }
        } else if (component.internal) {
          kindMismatch = true;
          continue;
        }
        const pasted = pasteComponentNode(
          master,
          activeIndexRef.current,
          component.node,
          [],
          null,
          measurePastedRef.current
        );
        if (pasted) targets.push(pasted);
      }
      // A paste that pasted nothing must not commit: no history entry, no
      // dirty flag, and no autosave for a refused or skipped gesture.
      if (targets.length === 0) return false;
      pastedCount = targets.length;
      applySelections(targets);
    });
    // An SVG internal that found no SVG destination must surface even when the
    // rest of a mixed clipboard pasted: the hint explains the missing half.
    if (kindMismatch) return 'kind-mismatch';
    if (pastedCount > 0) return 'pasted';
    return 'empty';
  }, [applySelections, commitMaster]);

  const duplicateSelection = useCallback(async () => {
    const current = stateRef.current;
    const slide = slidesRef.current[activeIndexRef.current];
    if (!slide) return;
    const targets = current.selections.filter(
      (target) => target.slideIndex === activeIndexRef.current
    );
    if (targets.length === 0) return;
    // A multi-selection that includes a nested target has no unambiguous
    // structural duplicate, so the whole gesture is refused.
    if (
      targets.length > 1 &&
      targets.some((target) => target.path.length > 1)
    ) {
      return;
    }
    if (targets.length !== 1 || targets[0].path.length < 2) {
      // Top-level single and all-top-level multi-selections keep the string
      // path.
      const html = collectObjectHtml(
        slide.element,
        targets.map((target) => target.path)
      );
      if (html.length > 0) await pasteHtml(html);
      return;
    }
    const target = targets[0];
    const element = elementAtPath(slide.element, target.path);
    if (!element || !element.parentElement || isTableInternal(element)) return;
    if (blockedPathAncestor(slide.element, target.path) !== null) return;
    await commitMaster((master) => {
      const pasted = pasteComponentNode(
        master,
        activeIndexRef.current,
        element,
        target.path.slice(0, -1),
        target.path,
        measurePastedRef.current
      );
      if (!pasted) return false;
      applySelections([pasted]);
    });
  }, [applySelections, commitMaster, pasteHtml]);

  const deleteSelection = useCallback(async () => {
    const current = stateRef.current;
    const slideIndex = activeIndexRef.current;
    const slide = slidesRef.current[slideIndex];
    if (!slide) return;
    const targets = current.selections.filter(
      (target) => target.slideIndex === slideIndex
    );
    if (targets.length === 0) return;
    const nested = targets.some((target) => target.path.length > 1);
    if (targets.length > 1 && nested) return;
    if (targets.length === 1 && targets[0].path.length > 1) {
      const element = elementAtPath(slide.element, targets[0].path);
      if (!element || isTableInternal(element) || blockedPathAncestor(slide.element, targets[0].path)) return;
    }
    await commitMaster((master) => {
      const removed = nested
        ? deleteComponentPaths(master, slideIndex, targets.map((target) => target.path))
        : deleteObjectPaths(master, slideIndex, targets.map((target) => target.path));
      if (removed > 0 && activeIndexRef.current === slideIndex) {
        applySelections([]);
      }
    });
  }, [applySelections, commitMaster]);

  const saveNow = useCallback(async () => {
    if (externalBusyRef.current || !settlePendingEdits()) return;
    const master = masterRef.current;
    if (!master) return;
    // A conflict needs an explicit banner choice; Ctrl+S must not silently
    // retry a save that will be rejected again.
    if (stateRef.current.conflict) return;
    const html = serializeDeck(master);
    autosaveRef.current?.cancel();
    update({ status: 'saving', error: '' });
    await enqueueSave((revision) =>
      persistenceRef.current.save(html, revision)
    );
  }, [enqueueSave, settlePendingEdits, update]);

  const restoreDraft = useCallback(
    (html: string) => {
      // A recovered draft is newer than whatever the host currently holds, so
      // it replaces the document but keeps the loaded revision as the base for
      // the next save.
      saveGenerationRef.current += 1;
      autosaveRef.current?.cancel();
      for (const edit of pendingEditsRef.current.values()) edit.discard();
      pendingEditsRef.current.clear();
      const master = parseDeck(html);
      if (!hasEditorArtifacts(master)) {
        normalizeDeck(master);
      }
      const previousSlides = slidesRef.current;
      const previousActiveId =
        previousSlides[activeIndexRef.current]?.id ?? null;
      const source = sourceDocFor(master, 0);
      let nextActive = 0;
      if (previousActiveId) {
        const found = source.slides.findIndex(
          (slide) => slide.id === previousActiveId
        );
        if (found >= 0) nextActive = found;
      }
      const activeIndex = clampSlideIndex(nextActive, source.slides.length);
      const slide = source.slides[activeIndex];
      masterRef.current = master;
      slidesRef.current = source.slides;
      activeIndexRef.current = activeIndex;
      historyRef.current.clear();
      historyRef.current.push(serializeDeck(master), { meta: activeIndex });
      update({
        master,
        slides: source.slides,
        activeIndex,
        srcDoc: slide ? buildSlideSrcDoc(master, slide) : '',
        selection: null,
        selections: [],
        dirty: true,
        pending: false,
        status: 'saving',
        conflict: null,
        documentEpoch: stateRef.current.documentEpoch + 1,
        error: ''
      });
      scheduleAutosaveRef.current();
    },
    [update]
  );

  const restore = useCallback(
    (entry: HistoryEntry<string, number>) => {
      const master = parseDeck(entry.value);
      const source = sourceDocFor(master, entry.meta);
      masterRef.current = master;
      slidesRef.current = source.slides;
      activeIndexRef.current = source.activeIndex;
      editVersionRef.current += 1;
      committedVersionRef.current += 1;
      update({
        master,
        slides: source.slides,
        activeIndex: source.activeIndex,
        srcDoc: source.srcDoc,
        dirty: true,
        status: stateRef.current.conflict ? 'conflict' : 'saving',
        selection: null,
        selections: [],
        error: ''
      });

      // Undo and redo are content operations; persist them like a commit so a
      // reload cannot resurrect the undone state.
      scheduleAutosaveRef.current();
    },
    [update]
  );

  const undo = useCallback(() => {
    if (!settlePendingEdits()) return;
    const entry = historyRef.current.undo();
    if (entry !== null) restore(entry);
  }, [restore, settlePendingEdits]);

  const redo = useCallback(() => {
    if (!settlePendingEdits()) return;
    const entry = historyRef.current.redo();
    if (entry !== null) restore(entry);
  }, [restore, settlePendingEdits]);

  const reload = useCallback(
    async (provided?: DeckResponse) => {
      if (externalBusyRef.current) return;
      const editVersion = editVersionRef.current;
      const generation = ++operationGenerationRef.current;
      saveGenerationRef.current += 1;
      autosaveRef.current?.cancel();
      externalBusyRef.current = true;
      update({ status: 'loading', recoveryBusy: true, error: '' });
      try {
        await saveChainRef.current;
        const deck = provided ?? (await persistenceRef.current.load());
        await applyExternal(deck, editVersion, generation);
      } catch {
        update({ status: 'error', error: translate('editor.reloadFailed') });
      } finally {
        externalBusyRef.current = false;
        update({ recoveryBusy: false });
        if (stateRef.current.dirty) scheduleAutosaveRef.current();
        drainLiveEventsRef.current();
      }
    },
    [applyExternal, translate, update]
  );

  const overwrite = useCallback(async () => {
    if (
      isSwitchedFileConflict(
        stateRef.current.conflict,
        stateRef.current.filePath
      )
    ) {
      // Force-writing here would replace the deck another tab just opened.
      update({
        status: 'conflict',
        error: translate('conflict.switched')
      });
      return;
    }
    const master = masterRef.current;
    if (!master || externalBusyRef.current) return;
    if (pendingEditsRef.current.size) {
      update({ error: translate('editor.pendingEditInstruction') });
      return;
    }
    operationGenerationRef.current += 1;
    externalBusyRef.current = true;
    const html = serializeDeck(master);
    autosaveRef.current?.cancel();
    update({ status: 'saving', recoveryBusy: true, error: '' });
    try {
      await enqueueSave(
        (revision) =>
          persistenceRef.current.save(html, revision, { force: true }),
        stateRef.current.conflict
      );
    } catch {
      // enqueueSave already set the error or conflict state; keep the banner.
    } finally {
      externalBusyRef.current = false;
      update({ recoveryBusy: false });
      drainLiveEventsRef.current();
      if (stateRef.current.dirty) scheduleAutosaveRef.current();
    }
  }, [enqueueSave, translate, update]);

  const flushBeforeUnload = useCallback(() => {
    const master = masterRef.current;
    if (!master || !stateRef.current.dirty || stateRef.current.pending || stateRef.current.conflict || externalBusyRef.current) return;
    persistenceRef.current.flush(serializeDeck(master), revisionRef.current);
  }, []);

  const actions = useMemo<DeckControllerActions>(
    () => ({
      changePendingEdit,
      cancelPendingEdit,
      settlePendingEdits,
      load,
      showSlide,
      select,
      selectTargets,
      toggleSelect,
      selectAll,
      clearSelection,
      setScale,
      applySlideMutation,
      commit,
      commitMaster,
      saveNow,
      copySelection,
      pasteObjects,
      duplicateSelection,
      deleteSelection,
      undo,
      redo,
      reload,
      overwrite,
      restoreDraft,
      receiveRevision,
      flushBeforeUnload
    }),
    [
      changePendingEdit,
      cancelPendingEdit,
      settlePendingEdits,
      load,
      showSlide,
      select,
      selectTargets,
      toggleSelect,
      selectAll,
      clearSelection,
      setScale,
      applySlideMutation,
      commit,
      commitMaster,
      saveNow,
      copySelection,
      pasteObjects,
      duplicateSelection,
      deleteSelection,
      undo,
      redo,
      reload,
      overwrite,
      restoreDraft,
      receiveRevision,
      flushBeforeUnload
    ]
  );

  return { state, actions };
}
