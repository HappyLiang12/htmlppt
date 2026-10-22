import { useCallback, useEffect, useRef } from 'react';
import { commitSlide, EDITING_ATTRIBUTE } from './slide-doc';
import { useDeckController, type SaveStatus } from './use-deck-controller';

const STATUS_LABEL: Record<SaveStatus, string> = {
  loading: '載入中…',
  ready: '已載入',
  saving: '儲存中…',
  saved: '已儲存',
  'load-error': '載入失敗',
  error: '儲存失敗'
};

export function App() {
  const frame = useRef<HTMLIFrameElement | null>(null);
  const canvas = useRef<HTMLElement | null>(null);
  const { state, actions } = useDeckController();
  const { slides, activeIndex, srcDoc, scale, status, error, filePath } = state;

  const activeSlide = slides[activeIndex];

  useEffect(() => {
    void actions.load();
  }, [actions]);

  useEffect(() => {
    const updateScale = () => {
      if (!canvas.current || !activeSlide) return;
      const bounds = canvas.current.getBoundingClientRect();
      const widthScale = Math.max(
        0.1,
        (bounds.width - 96) / activeSlide.width
      );
      const heightScale = Math.max(
        0.1,
        (bounds.height - 96) / activeSlide.height
      );
      actions.setScale(Math.min(widthScale, heightScale, 1));
    };
    updateScale();
    window.addEventListener('resize', updateScale);
    return () => window.removeEventListener('resize', updateScale);
  }, [activeSlide, actions]);

  const commit = useCallback(
    async (editable: HTMLElement) => {
      const frameDocument = frame.current?.contentDocument;
      if (!frameDocument) return;

      // Drop the editing marker first: removing contenteditable from the
      // focused element can fire another focusout, which must not re-commit.
      editable.removeAttribute(EDITING_ATTRIBUTE);
      editable.removeAttribute('contenteditable');
      try {
        await actions.commit((master, slide) =>
          commitSlide(master, slide.index, frameDocument)
        );
      } catch {
        // The controller already surfaced the status and message.
        editable.setAttribute('contenteditable', 'true');
        editable.setAttribute(EDITING_ATTRIBUTE, 'true');
      }
    },
    [actions]
  );

  const onFrameLoad = useCallback(() => {
    const frameDocument = frame.current?.contentDocument;
    if (!frameDocument) return;

    frameDocument.addEventListener('dblclick', (event) => {
      const target = event.target as HTMLElement | null;
      if (!target || !frameDocument.body.contains(target)) return;
      const editable = target.closest(
        'h1, h2, h3, p, li, span, td, th, blockquote, figcaption'
      ) as HTMLElement | null;
      if (!editable || !editable.textContent?.trim()) return;
      event.preventDefault();
      editable.setAttribute('contenteditable', 'true');
      editable.setAttribute(EDITING_ATTRIBUTE, 'true');
      editable.focus();
    });

    frameDocument.addEventListener('keydown', (event) => {
      if (event.key !== 'Escape') return;
      const editable = frameDocument.querySelector(
        `[${EDITING_ATTRIBUTE}]`
      ) as HTMLElement | null;
      editable?.blur();
    });

    frameDocument.addEventListener('focusout', (event) => {
      const target = event.target as HTMLElement | null;
      if (target?.hasAttribute(EDITING_ATTRIBUTE)) {
        void commit(target);
      }
    });

    frameDocument.addEventListener('click', (event) => {
      const link = (event.target as HTMLElement | null)?.closest('a');
      if (link) event.preventDefault();
    });
  }, [commit]);

  const goTo = (index: number) => {
    actions.showSlide(index);
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
                title="投影片預覽"
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
          ) : status === 'loading' ? (
            <p className="text-sm text-zinc-500">載入中…</p>
          ) : (
            <p className="text-sm text-zinc-500">找不到投影片。</p>
          )}
        </main>
      </div>
    </div>
  );
}
