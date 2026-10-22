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
import { History } from './history';
import type { SelectionTarget } from './selection';
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
  selection: SelectionTarget | null;
  scale: number;
  status: SaveStatus;
  dirty: boolean;
  conflict: DeckConflict | null;
  srcDoc: string;
  filePath: string;
  error: string;
}

export type SlideCommit = (master: Document, slide: SlideInfo) => string | void;

export interface SlideMutationOptions {
  coalesceKey?: string;
}

export interface DeckControllerActions {
  load(deck?: DeckResponse): Promise<void>;
  showSlide(index: number): void;
  select(target: SelectionTarget | null): void;
  clearSelection(): void;
  setScale(scale: number): void;
  applySlideMutation(
    slideIndex: number,
    mutate: (slide: Element, master: Document) => void,
    options?: SlideMutationOptions
  ): string | null;
  commit(mutate: SlideCommit): Promise<void>;
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
    scale: 1,
    status: 'loading',
    dirty: false,
    conflict: null,
    srcDoc: '',
    filePath: '',
    error: ''
  };
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
  const historyRef = useRef(new History<string>());
  const tokenRef = useRef(options.token ?? tokenFromLocation());

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
        historyRef.current.push(serializeDeck(master));

        update({
          master,
          slides: source.slides,
          activeIndex: source.activeIndex,
          srcDoc: source.srcDoc,
          selection: null,
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
      update({
        slides: source.slides,
        activeIndex: source.activeIndex,
        srcDoc: source.srcDoc,
        selection: null
      });
    },
    [update]
  );

  const select = useCallback(
    (target: SelectionTarget | null) => {
      update({ selection: target });
    },
    [update]
  );

  const clearSelection = useCallback(() => {
    update({ selection: null });
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
        coalesceKey: mutationOptions.coalesceKey
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
      historyRef.current.push(html);

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

  const restore = useCallback(
    (html: string) => {
      const master = parseDeck(html);
      const source = sourceDocFor(master, activeIndexRef.current);
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
        selection: null,
        error: ''
      });
    },
    [update]
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
      clearSelection,
      setScale,
      applySlideMutation,
      commit,
      undo,
      redo,
      reload,
      overwrite
    }),
    [
      load,
      showSlide,
      select,
      clearSelection,
      setScale,
      applySlideMutation,
      commit,
      undo,
      redo,
      reload,
      overwrite
    ]
  );

  return { state, actions };
}
