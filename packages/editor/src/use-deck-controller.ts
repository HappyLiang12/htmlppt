import { useCallback, useMemo, useRef, useState } from 'react';
import {
  detectSlides,
  normalizeDeck,
  serializeDeck,
  type SlideInfo
} from '@htmlppt/core';
import {
  fetchDeck,
  saveDeck,
  tokenFromLocation,
  type DeckResponse
} from './api';
import { History, type HistoryEntry } from './history';
import { topLevelObjects, type SelectionTarget } from './selection';
import {
  collectObjectHtml,
  deleteObjectPaths,
  pasteObjectHtml,
  type PastedObjectMeasure
} from './object-ops';
import { buildSlideSrcDoc, parseDeck } from './slide-doc';
import { clampSlideIndex } from './slide-index';

export type SaveStatus =
  | 'loading'
  | 'ready'
  | 'saving'
  | 'saved'
  | 'load-error'
  | 'error';

export interface DeckConflict {
  revision: string;
  source?: string;
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
  conflict: DeckConflict | null;
  srcDoc: string;
  filePath: string;
  error: string;
}

export type SlideCommit = (master: Document, slide: SlideInfo) => string | void;
export type MasterCommit = (master: Document) => void;

export interface SlideMutationOptions {
  coalesceKey?: string;
}

export interface DeckControllerActions {
  load(deck?: DeckResponse): Promise<void>;
  showSlide(index: number): void;
  select(target: SelectionTarget | null): void;
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
  pasteObjects(): Promise<void>;
  duplicateSelection(): Promise<void>;
  deleteSelection(): Promise<void>;
  undo(): void;
  redo(): void;
  reload(deck?: DeckResponse): Promise<void>;
  overwrite(): Promise<void>;
}

export interface DeckController {
  state: DeckControllerState;
  actions: DeckControllerActions;
}

export interface DeckControllerOptions {
  token?: string;
  /**
   * Bridges pasted-object measurement to the rendered preview. The master
   * document is inert, so class-supplied positions require live layout; when
   * absent, paste falls back to master-document geometry.
   */
  measurePastedObject?: PastedObjectMeasure;
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
  const editVersionRef = useRef(0);
  const historyRef = useRef(new History<string, number>());
  const clipboardRef = useRef<string[]>([]);
  const tokenRef = useRef(options.token ?? tokenFromLocation());
  const measurePastedRef = useRef(options.measurePastedObject);
  measurePastedRef.current = options.measurePastedObject;

  const update = useCallback((patch: Partial<DeckControllerState>) => {
    const next = { ...stateRef.current, ...patch };
    stateRef.current = next;
    setState(next);
  }, []);

  const enqueueSave = useCallback(
    (save: (revision: string) => Promise<{ revision: string }>) => {
      const generation = saveGenerationRef.current;
      const editVersion = editVersionRef.current;
      const task = saveChainRef.current.then(async () => {
        // A load or reload that happened while this save was queued owns the
        // deck now; writing would persist stale content.
        if (saveGenerationRef.current !== generation) return;
        const saved = await save(revisionRef.current);
        revisionRef.current = saved.revision;
        // Only report clean when no newer edit was recorded after this
        // snapshot was taken; otherwise that edit is still pending.
        if (editVersionRef.current === editVersion) {
          update({ status: 'saved', dirty: false, error: '', conflict: null });
        }
      });
      saveChainRef.current = task.catch(() => undefined);
      return task;
    },
    [update]
  );

  const load = useCallback(
    async (provided?: DeckResponse) => {
      // Invalidate queued saves for the outgoing deck, then let an in-flight
      // save finish before the revision is replaced by the fetched one.
      saveGenerationRef.current += 1;
      await saveChainRef.current;
      update({ status: 'loading', error: '' });
      try {
        const deck = provided ?? (await fetchDeck(tokenRef.current));
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
          filePath: deck.filePath,
          error: ''
        });
      } catch (cause) {
        update({ status: 'load-error', error: toMessage(cause) });
      }
    },
    [update]
  );

  const showSlide = useCallback(
    (index: number) => {
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
    [update]
  );

  const applySelections = useCallback(
    (targets: SelectionTarget[]) => {
      const unique: SelectionTarget[] = [];
      for (const target of targets) {
        if (!unique.some((candidate) => sameTarget(candidate, target))) {
          unique.push(target);
        }
      }
      update({ selection: unique[0] ?? null, selections: unique });
    },
    [update]
  );

  const select = useCallback(
    (target: SelectionTarget | null) => {
      applySelections(target ? [target] : []);
    },
    [applySelections]
  );

  const toggleSelect = useCallback(
    (target: SelectionTarget) => {
      const current = stateRef.current;
      const base = current.selections;
      const sameSlide = base[0]?.slideIndex === target.slideIndex;
      if (
        target.path.length !== 1 ||
        base.length === 0 ||
        !sameSlide
      ) {
        // Nested selections stay single and read-only; a target on another
        // slide starts a fresh selection rather than mixing slides.
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
    update({ selection: null, selections: [] });
  }, [update]);

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
      const master = masterRef.current;
      if (!master) return null;
      const slides = detectSlides(master);
      const slide = slides[slideIndex];
      if (!slide) return null;

      mutate(slide.element, master);
      editVersionRef.current += 1;
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
      return html;
    },
    [update]
  );

  const commit = useCallback(
    async (mutate: SlideCommit) => {
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
      historyRef.current.push(html, { meta: activeIndexRef.current });

      const slides = detectSlides(master);
      slidesRef.current = slides;
      update({ slides, dirty: true, status: 'saving' });

      const task = enqueueSave((revision) =>
        saveDeck(tokenRef.current, html, revision)
      );

      try {
        await task;
      } catch (cause) {
        update({ status: 'error', error: toMessage(cause), dirty: true });
        throw cause;
      }
    },
    [enqueueSave, update]
  );

  const commitMaster = useCallback(
    async (mutate: MasterCommit) => {
      const master = masterRef.current;
      if (!master) return;

      let html: string;
      try {
        mutate(master);
        html = serializeDeck(master);
      } catch (cause) {
        // The master may be partially mutated, but no snapshot was recorded,
        // so the dirty flag keeps its previous value.
        update({ status: 'error', error: toMessage(cause) });
        throw cause;
      }
      editVersionRef.current += 1;
      historyRef.current.push(html, { meta: activeIndexRef.current });

      const source = sourceDocFor(master, activeIndexRef.current);
      slidesRef.current = source.slides;
      activeIndexRef.current = source.activeIndex;
      update({
        slides: source.slides,
        activeIndex: source.activeIndex,
        srcDoc: source.srcDoc,
        dirty: true,
        status: 'saving'
      });

      const task = enqueueSave((revision) =>
        saveDeck(tokenRef.current, html, revision)
      );

      try {
        await task;
      } catch (cause) {
        update({ status: 'error', error: toMessage(cause), dirty: true });
        throw cause;
      }
    },
    [enqueueSave, update]
  );

  const copySelection = useCallback(() => {
    const slide = slidesRef.current[activeIndexRef.current];
    if (!slide) return;
    const html = collectObjectHtml(
      slide.element,
      stateRef.current.selections
        .filter((target) => target.slideIndex === activeIndexRef.current)
        .map((target) => target.path)
    );
    if (html.length > 0) clipboardRef.current = html;
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
        if (pasted.length > 0 && activeIndexRef.current === slideIndex) {
          applySelections(pasted);
        }
      });
    },
    [applySelections, commitMaster]
  );

  const pasteObjects = useCallback(
    () => pasteHtml(clipboardRef.current),
    [pasteHtml]
  );

  const duplicateSelection = useCallback(async () => {
    const slide = slidesRef.current[activeIndexRef.current];
    if (!slide) return;
    const html = collectObjectHtml(
      slide.element,
      stateRef.current.selections
        .filter((target) => target.slideIndex === activeIndexRef.current)
        .map((target) => target.path)
    );
    if (html.length > 0) await pasteHtml(html);
  }, [pasteHtml]);

  const deleteSelection = useCallback(async () => {
    const current = stateRef.current;
    const slideIndex = activeIndexRef.current;
    const slide = slidesRef.current[slideIndex];
    if (!slide) return;
    const objects = new Set(topLevelObjects(slide.element));
    const paths = current.selections
      .filter(
        (target) =>
          target.slideIndex === slideIndex &&
          target.path.length === 1 &&
          objects.has(slide.element.children[target.path[0] ?? -1] as Element)
      )
      .map((target) => target.path);
    if (paths.length === 0) return;

    // Clear the selection inside the mutation, before the save is awaited, so
    // a slow save cannot clear a newer selection made after a slide switch.
    await commitMaster((master) => {
      const removed = deleteObjectPaths(master, slideIndex, paths);
      if (removed > 0 && activeIndexRef.current === slideIndex) {
        applySelections([]);
      }
    });
  }, [applySelections, commitMaster]);

  const saveNow = useCallback(async () => {
    const master = masterRef.current;
    if (!master) return;
    const html = serializeDeck(master);
    update({ status: 'saving', error: '' });
    try {
      await enqueueSave((revision) =>
        saveDeck(tokenRef.current, html, revision)
      );
    } catch (cause) {
      update({ status: 'error', error: toMessage(cause), dirty: true });
      throw cause;
    }
  }, [enqueueSave, update]);

  const restore = useCallback(
    (entry: HistoryEntry<string, number>) => {
      const master = parseDeck(entry.value);
      const source = sourceDocFor(master, entry.meta);
      masterRef.current = master;
      slidesRef.current = source.slides;
      activeIndexRef.current = source.activeIndex;
      editVersionRef.current += 1;
      update({
        master,
        slides: source.slides,
        activeIndex: source.activeIndex,
        srcDoc: source.srcDoc,
        dirty: true,
        status: 'saving',
        selection: null,
        selections: [],
        error: ''
      });

      // Undo and redo are content operations; persist them like a commit so a
      // reload cannot resurrect the undone state.
      const task = enqueueSave((revision) =>
        saveDeck(tokenRef.current, entry.value, revision)
      );
      void task.catch((cause) => {
        update({ status: 'error', error: toMessage(cause), dirty: true });
      });
    },
    [enqueueSave, update]
  );

  const undo = useCallback(() => {
    const entry = historyRef.current.undo();
    if (entry !== null) restore(entry);
  }, [restore]);

  const redo = useCallback(() => {
    const entry = historyRef.current.redo();
    if (entry !== null) restore(entry);
  }, [restore]);

  const reload = useCallback(
    async (provided?: DeckResponse) => {
      await load(provided);
    },
    [load]
  );

  const overwrite = useCallback(async () => {
    const master = masterRef.current;
    if (!master) return;
    const html = serializeDeck(master);
    update({ status: 'saving', error: '' });
    try {
      await enqueueSave((revision) =>
        saveDeck(tokenRef.current, html, revision, { force: true })
      );
    } catch (cause) {
      update({ status: 'error', error: toMessage(cause), dirty: true });
    }
  }, [enqueueSave, update]);

  const actions = useMemo<DeckControllerActions>(
    () => ({
      load,
      showSlide,
      select,
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
      overwrite
    }),
    [
      load,
      showSlide,
      select,
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
      overwrite
    ]
  );

  return { state, actions };
}
