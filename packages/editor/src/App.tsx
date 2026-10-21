import { useCallback, useEffect, useRef, useState } from 'react';
import { detectSlides, type SlideInfo } from '@htmlppt/core';
import { fetchDeck, saveDeck, tokenFromLocation } from './api';
import { buildSlideSrcDoc, commitSlide, parseDeck } from './slide-doc';

type SaveStatus = 'loading' | 'ready' | 'saving' | 'saved' | 'error';

const STATUS_LABEL: Record<SaveStatus, string> = {
  loading: '載入中…',
  ready: '已載入',
  saving: '儲存中…',
  saved: '已儲存',
  error: '儲存失敗'
};

export function App() {
  const token = useRef(tokenFromLocation());
  const master = useRef<Document | null>(null);
  const revision = useRef('');
  const frame = useRef<HTMLIFrameElement | null>(null);
  const canvas = useRef<HTMLElement | null>(null);

  const [slides, setSlides] = useState<SlideInfo[]>([]);
  const [activeIndex, setActiveIndex] = useState(0);
  const [srcDoc, setSrcDoc] = useState('');
  const [scale, setScale] = useState(1);
  const [status, setStatus] = useState<SaveStatus>('loading');
  const [error, setError] = useState('');
  const [filePath, setFilePath] = useState('');

  const activeSlide = slides[activeIndex];

  const showSlide = useCallback((doc: Document, index: number) => {
    const list = detectSlides(doc);
    const clamped = Math.max(0, Math.min(index, list.length - 1));
    setSlides(list);
    setActiveIndex(clamped);
    const slide = list[clamped];
    setSrcDoc(slide ? buildSlideSrcDoc(doc, slide) : '');
  }, []);

  useEffect(() => {
    void (async () => {
      try {
        const deck = await fetchDeck(token.current);
        const doc = parseDeck(deck.html);
        master.current = doc;
        revision.current = deck.revision;
        setFilePath(deck.filePath);
        setStatus('ready');
        showSlide(doc, 0);
      } catch (cause) {
        setStatus('error');
        setError(cause instanceof Error ? cause.message : String(cause));
      }
    })();
  }, [showSlide]);

  useEffect(() => {
    const updateScale = () => {
      if (!canvas.current || !activeSlide) return;
      const bounds = canvas.current.getBoundingClientRect();
      setScale(
        Math.min(
          (bounds.width - 96) / activeSlide.width,
          (bounds.height - 96) / activeSlide.height,
          1
        )
      );
    };
    updateScale();
    window.addEventListener('resize', updateScale);
    return () => window.removeEventListener('resize', updateScale);
  }, [activeSlide]);

  const commit = useCallback(
    async (editable: HTMLElement) => {
      const doc = master.current;
      const slide = slides[activeIndex];
      const frameDocument = frame.current?.contentDocument;
      if (!doc || !slide || !frameDocument) return;

      editable.removeAttribute('contenteditable');
      try {
        const html = commitSlide(doc, slide.id, frameDocument);
        setStatus('saving');
        const result = await saveDeck(token.current, html, revision.current);
        revision.current = result.revision;
        setSlides(detectSlides(doc));
        setStatus('saved');
        setError('');
      } catch (cause) {
        editable.setAttribute('contenteditable', 'true');
        setStatus('error');
        setError(cause instanceof Error ? cause.message : String(cause));
      }
    },
    [activeIndex, slides]
  );

  const onFrameLoad = useCallback(() => {
    const frameDocument = frame.current?.contentDocument;
    if (!frameDocument) return;

    frameDocument.addEventListener('dblclick', (event) => {
      const target = event.target as HTMLElement | null;
      if (!target || !target.closest('[data-slide-id]')) return;
      const editable = target.closest(
        'h1, h2, h3, p, li, span, td, th, blockquote, figcaption'
      ) as HTMLElement | null;
      if (!editable || !editable.textContent?.trim()) return;
      event.preventDefault();
      editable.setAttribute('contenteditable', 'true');
      editable.focus();
    });

    frameDocument.addEventListener('keydown', (event) => {
      if (event.key !== 'Escape') return;
      const editable = frameDocument.querySelector(
        '[contenteditable]'
      ) as HTMLElement | null;
      editable?.blur();
    });

    frameDocument.addEventListener('focusout', (event) => {
      const target = event.target as HTMLElement | null;
      if (target?.hasAttribute('contenteditable')) {
        void commit(target);
      }
    });

    frameDocument.addEventListener('click', (event) => {
      const link = (event.target as HTMLElement | null)?.closest('a');
      if (link) event.preventDefault();
    });
  }, [commit]);

  const goTo = (index: number) => {
    if (!master.current) return;
    showSlide(master.current, index);
  };

  return (
    <div className="flex h-screen flex-col bg-[#0f1115] text-zinc-100">
      <header className="flex items-center justify-between border-b border-white/10 px-5 py-3">
        <div className="flex min-w-0 items-center gap-3">
          <span className="text-sm font-semibold tracking-wide">htmlppt</span>
          <span className="truncate text-xs text-zinc-400">{filePath}</span>
        </div>
        <div className="flex items-center gap-4 text-xs">
          <span
            data-testid="save-status"
            className={status === 'error' ? 'text-red-400' : 'text-zinc-400'}
          >
            {STATUS_LABEL[status]}
          </span>
          <button
            type="button"
            className="rounded border border-white/15 px-2 py-1 disabled:opacity-40"
            onClick={() => goTo(activeIndex - 1)}
            disabled={activeIndex <= 0}
          >
            上一頁
          </button>
          <span className="tabular-nums text-zinc-400">
            {slides.length === 0 ? 0 : activeIndex + 1} / {slides.length}
          </span>
          <button
            type="button"
            className="rounded border border-white/15 px-2 py-1 disabled:opacity-40"
            onClick={() => goTo(activeIndex + 1)}
            disabled={activeIndex >= slides.length - 1}
          >
            下一頁
          </button>
        </div>
      </header>

      <div className="flex min-h-0 flex-1">
        <aside className="w-44 shrink-0 border-r border-white/10 p-3">
          <div className="flex flex-col gap-2">
            {slides.map((slide, index) => (
              <button
                key={slide.id}
                type="button"
                onClick={() => goTo(index)}
                className={`rounded border px-3 py-2 text-left text-xs ${
                  index === activeIndex
                    ? 'border-amber-400/70 bg-amber-400/10 text-amber-200'
                    : 'border-white/10 text-zinc-400 hover:border-white/25'
                }`}
              >
                第 {index + 1} 頁
              </button>
            ))}
          </div>
        </aside>

        <main
          ref={canvas}
          className="relative flex min-w-0 flex-1 items-center justify-center overflow-hidden bg-[#0a0c10] p-12"
        >
          {error && (
            <div className="absolute left-4 top-4 max-w-lg rounded border border-red-500/40 bg-red-950/80 px-3 py-2 text-xs text-red-200">
              {error}
            </div>
          )}

          {activeSlide ? (
            <div
              className="relative shadow-2xl shadow-black/60"
              style={{
                width: activeSlide.width * scale,
                height: activeSlide.height * scale
              }}
            >
              <iframe
                ref={frame}
                title="Slide preview"
                sandbox="allow-same-origin"
                srcDoc={srcDoc}
                onLoad={onFrameLoad}
                className="absolute left-0 top-0 border-0 bg-white"
                style={{
                  width: activeSlide.width,
                  height: activeSlide.height,
                  transform: `scale(${scale})`,
                  transformOrigin: 'top left'
                }}
              />
            </div>
          ) : (
            <p className="text-sm text-zinc-500">No slides found.</p>
          )}
        </main>
      </div>
    </div>
  );
}
