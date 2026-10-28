import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type SyntheticEvent
} from 'react';
import type { SlideInfo, Transition } from '@htmlppt/core';
import { revealPreviewSlide } from '../frame-reveal';
import { PREVIEW_SLIDE_ATTRIBUTE } from '../slide-doc';
import {
  measureSlideBox,
  readFitMode,
  sameBox,
  scaleFor,
  writeFitMode,
  type PlayFitMode,
  type SlideBox
} from '../play-fit';
import { useI18n } from '../i18n';

export type FullscreenState = 'off' | 'active' | 'unavailable';

export interface PlayViewProps {
  slide: SlideInfo;
  srcDoc: string;
  /** Authored transition of the slide currently on screen. */
  transition: Transition;
  fullscreen: FullscreenState;
  fullscreenNotice?: string;
  presenterError?: string;
  /**
   * Forwards keyboard events from the play iframe to the editor shell, which
   * owns navigation and exits presenting.
   */
  onKeyDown: (event: KeyboardEvent, activeDocument: Document) => void;
  /** Noninteractive clicks advance, matching arrow-key navigation. */
  onAdvance: () => void;
  onOpenPresenter: () => void;
}

function playStorage(): Storage | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    return null;
  }
}

function useReducedMotion(): boolean {
  const [reduced, setReduced] = useState(
    () =>
      window.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches === true
  );
  useLayoutEffect(() => {
    const query = window.matchMedia?.('(prefers-reduced-motion: reduce)');
    if (!query) return;
    const update = () => setReduced(query.matches);
    update();
    query.addEventListener?.('change', update);
    return () => query.removeEventListener?.('change', update);
  }, []);
  return reduced;
}

const INTERACTIVE_SELECTOR =
  'a,button,input,select,textarea,label,summary,details,video[controls],audio[controls],[role="button"],[role="link"],[contenteditable]:not([contenteditable="false"])';

export function isInteractiveDeckTarget(target: EventTarget | null): boolean {
  // The play deck lives in its own realm, so `instanceof Element` would reject
  // every deck target; duck-typing `closest` works across realms.
  if (!target || typeof (target as Element).closest !== 'function') {
    return false;
  }
  return (target as Element).closest(INTERACTIVE_SELECTOR) !== null;
}

/**
 * Chrome-free presentation surface. It renders only the active slide in a
 * script-free iframe, scaled to fill the viewport with letterboxing. Presenter
 * and fullscreen affordances live in the parent document, never in the deck.
 */
export function PlayView({
  slide,
  srcDoc,
  transition,
  fullscreen,
  fullscreenNotice,
  presenterError,
  onKeyDown,
  onAdvance,
  onOpenPresenter
}: PlayViewProps) {
  const { t } = useI18n();
  const frameRef = useRef<HTMLIFrameElement | null>(null);
  const regionRef = useRef<HTMLDivElement | null>(null);
  const onKeyDownRef = useRef(onKeyDown);
  onKeyDownRef.current = onKeyDown;
  const onAdvanceRef = useRef(onAdvance);
  onAdvanceRef.current = onAdvance;
  const reducedMotion = useReducedMotion();
  const [mode, setMode] = useState<PlayFitMode>(() =>
    readFitMode(playStorage())
  );
  const [viewport, setViewport] = useState(() => ({
    width: window.innerWidth,
    height: window.innerHeight
  }));
  const [measured, setMeasured] = useState<{
    id: string;
    box: SlideBox;
  } | null>(null);
  const observerRef = useRef<ResizeObserver | null>(null);

  const changeMode = (next: PlayFitMode) => {
    setMode(next);
    writeFitMode(next, playStorage());
  };

  useLayoutEffect(() => {
    const update = () =>
      setViewport({ width: window.innerWidth, height: window.innerHeight });
    update();
    window.addEventListener('resize', update);
    document.addEventListener('fullscreenchange', update);
    return () => {
      window.removeEventListener('resize', update);
      document.removeEventListener('fullscreenchange', update);
    };
  }, []);

  useEffect(
    () => () => {
      observerRef.current?.disconnect();
      observerRef.current = null;
    },
    []
  );

  // Move focus out of the unmounted editor chrome so shortcuts land on the
  // play surface even when presenting was started with the mouse.
  useEffect(() => {
    regionRef.current?.focus();
  }, []);

  const handleLoad = (event: SyntheticEvent<HTMLIFrameElement>) => {
    const frameDocument = event.currentTarget.contentDocument;
    if (!frameDocument) return;
    revealPreviewSlide(frameDocument);
    observerRef.current?.disconnect();
    const updateBox = () => {
      const next = measureSlideBox(frameDocument);
      setMeasured((current) =>
        current && current.id === slide.id && sameBox(current.box, next)
          ? current
          : next
            ? { id: slide.id, box: next }
            : null
      );
    };
    updateBox();
    const root =
      frameDocument.querySelector(`[${PREVIEW_SLIDE_ATTRIBUTE}]`) ??
      frameDocument.body;
    if (root && typeof ResizeObserver !== 'undefined') {
      const observer = new ResizeObserver(updateBox);
      observer.observe(root);
      observerRef.current = observer;
    }
    // Keys belong to the deck while its iframe owns focus; forward them so
    // navigation and Escape behave the same as in the parent document.
    frameDocument.addEventListener('keydown', (keyEvent) => {
      onKeyDownRef.current(keyEvent, frameDocument);
    });
    frameDocument.addEventListener('click', (clickEvent) => {
      if (isInteractiveDeckTarget(clickEvent.target)) return;
      onAdvanceRef.current();
    });
  };

  const animate = transition !== 'none' && !reducedMotion;
  const box =
    measured?.id === slide.id
      ? measured.box
      : {
          left: 0,
          top: 0,
          width: slide.width,
          height: slide.height
        };
  const scale = scaleFor(box, viewport, mode);

  return (
    <div
      ref={regionRef}
      data-testid="play-view"
      data-fullscreen={fullscreen}
      role="region"
      aria-label={t('play.label')}
      tabIndex={-1}
      className="fixed inset-0 z-50 flex items-center justify-center overflow-hidden bg-black outline-none"
      onClick={(event) => {
        if (event.target === event.currentTarget) onAdvance();
      }}
    >
      <p className="sr-only">{t('play.instructions')}</p>
      {fullscreenNotice && (
        <div
          data-testid="fullscreen-warning"
          role="status"
          className="absolute left-4 top-4 z-20 max-w-sm rounded border border-amber-400/40 bg-amber-950/80 px-3 py-2 text-xs text-amber-100"
        >
          {fullscreenNotice}
        </div>
      )}
      {presenterError && (
        <div
          data-testid="presenter-error"
          role="alert"
          className="absolute left-4 top-20 z-20 max-w-sm rounded border border-rose-400/40 bg-rose-950/80 px-3 py-2 text-xs text-rose-100"
        >
          {presenterError}
        </div>
      )}
      <div className="absolute right-4 top-4 z-20 flex items-center gap-2">
        <div
          role="group"
          aria-label={t('play.fitGroup')}
          className="flex overflow-hidden rounded border border-white/40 bg-black/50 text-xs text-zinc-200"
        >
          <button
            type="button"
            data-testid="play-fit"
            aria-pressed={mode === 'fit'}
            onClick={() => changeMode('fit')}
            className="px-2 py-1 transition-colors hover:bg-white/10 aria-pressed:bg-white/20"
          >
            {t('play.fit')}
          </button>
          <button
            type="button"
            data-testid="play-fill"
            aria-pressed={mode === 'fill'}
            onClick={() => changeMode('fill')}
            className="px-2 py-1 transition-colors hover:bg-white/10 aria-pressed:bg-white/20"
          >
            {t('play.fill')}
          </button>
        </div>
        <button
          type="button"
          data-testid="presenter-open"
          title={t('play.openPresenter')}
          aria-haspopup="dialog"
          onClick={onOpenPresenter}
          className="rounded border border-white/40 bg-black/50 px-3 py-1.5 text-xs text-zinc-200 transition-colors hover:border-white/60"
        >
          {t('play.presenter')}
        </button>
      </div>

      <div
        key={slide.id}
        data-testid="play-slide"
        data-transition={transition}
        className={`relative overflow-hidden ${
          animate ? `play-slide--${transition}` : ''
        }`}
        style={{ width: box.width * scale, height: box.height * scale }}
        onClick={(event) => {
          if (event.target === event.currentTarget) onAdvance();
        }}
      >
        <iframe
          ref={frameRef}
          data-testid="play-frame"
          title={t('play.start')}
          sandbox="allow-same-origin"
          srcDoc={srcDoc}
          onLoad={handleLoad}
          className="absolute left-0 top-0 border-0 bg-white"
          style={{
            width: slide.width,
            height: slide.height,
            transform: `translate(${-box.left * scale}px, ${-box.top * scale}px) scale(${scale})`,
            transformOrigin: 'top left'
          }}
        />
      </div>
    </div>
  );
}
