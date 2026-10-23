import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type SyntheticEvent
} from 'react';
import type { SlideInfo, Transition } from '@htmlppt/core';
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

function viewportFit(width: number, height: number): number {
  if (!Number.isFinite(width) || !Number.isFinite(height)) return 1;
  if (width <= 0 || height <= 0) return 1;
  return Math.min(window.innerWidth / width, window.innerHeight / height);
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
  const [scale, setScale] = useState(() =>
    viewportFit(slide.width, slide.height)
  );

  useLayoutEffect(() => {
    const update = () => setScale(viewportFit(slide.width, slide.height));
    update();
    window.addEventListener('resize', update);
    return () => window.removeEventListener('resize', update);
  }, [slide.width, slide.height]);

  // Move focus out of the unmounted editor chrome so shortcuts land on the
  // play surface even when presenting was started with the mouse.
  useEffect(() => {
    regionRef.current?.focus();
  }, []);

  const handleLoad = (event: SyntheticEvent<HTMLIFrameElement>) => {
    const frameDocument = event.currentTarget.contentDocument;
    if (!frameDocument) return;
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
      <button
        type="button"
        data-testid="presenter-open"
        title={t('play.openPresenter')}
        aria-haspopup="dialog"
        onClick={onOpenPresenter}
        className="absolute right-4 top-4 z-20 rounded border border-white/40 bg-black/50 px-3 py-1.5 text-xs text-zinc-200 transition-colors hover:border-white/60"
      >
        {t('play.presenter')}
      </button>

      <div
        key={slide.id}
        data-testid="play-slide"
        data-transition={transition}
        className={`relative ${
          animate ? `play-slide--${transition}` : ''
        }`}
        style={{
          width: slide.width * scale,
          height: slide.height * scale
        }}
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
            transform: `scale(${scale})`,
            transformOrigin: 'top left'
          }}
        />
      </div>
    </div>
  );
}
