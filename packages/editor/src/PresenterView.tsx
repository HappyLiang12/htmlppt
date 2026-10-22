import { detectSlides } from '@htmlppt/core';
import { useEffect, useMemo, useRef, useState } from 'react';
import { SlideMiniature, slideTitle } from './components/ThumbnailRail';
import { parseDeck } from './slide-doc';
import {
  isPresenterSessionId,
  parsePresenterMessage,
  presenterChannelName
} from './presenter-protocol';

type Connection = 'connecting' | 'connected' | 'disconnected';

const STATUS_LABEL: Record<Connection, string> = {
  connecting: '等待主視窗…',
  connected: '已連線',
  disconnected: '已中斷'
};

function formatElapsed(seconds: number): string {
  const minutes = Math.floor(seconds / 60)
    .toString()
    .padStart(2, '0');
  const rest = (seconds % 60).toString().padStart(2, '0');
  return `${minutes}:${rest}`;
}

function notesOf(element: Element | undefined): string {
  const aside = Array.from(element?.children ?? []).find((child) =>
    child.hasAttribute('data-ppt-notes')
  );
  return (aside?.textContent ?? '').trim();
}

/**
 * Same-origin presenter window opened by the editor during play. The main
 * window is authoritative: this view only renders the snapshot it receives and
 * forwards navigation requests through the presentation-scoped channel.
 */
export function PresenterView({ sessionId }: { sessionId: string }) {
  const [html, setHtml] = useState('');
  const [index, setIndex] = useState(0);
  const [status, setStatus] = useState<Connection>('connecting');
  const [elapsed, setElapsed] = useState(0);
  const channelRef = useRef<BroadcastChannel | null>(null);
  const lastStateRef = useRef(0);

  useEffect(() => {
    const started = Date.now();
    const timer = window.setInterval(
      () => setElapsed(Math.floor((Date.now() - started) / 1000)),
      1000
    );
    if (!isPresenterSessionId(sessionId)) {
      setStatus('disconnected');
      return () => window.clearInterval(timer);
    }

    const channel = new BroadcastChannel(presenterChannelName(sessionId));
    channelRef.current = channel;
    const request = () => channel.postMessage({ sessionId, type: 'request' });
    channel.onmessage = (event) => {
      const message = parsePresenterMessage(event.data, sessionId);
      if (!message) return;
      if (message.type === 'snapshot') {
        setHtml(message.html);
        setIndex(message.index);
        setStatus('connected');
        lastStateRef.current = Date.now();
      } else if (message.type === 'state') {
        setIndex(message.index);
        setStatus('connected');
        lastStateRef.current = Date.now();
      } else if (message.type === 'bye') {
        setStatus('disconnected');
      }
    };
    request();
    const poll = window.setInterval(request, 2_000);
    const watchdog = window.setInterval(() => {
      if (Date.now() - lastStateRef.current > 6_000) {
        setStatus('disconnected');
      }
    }, 1_000);
    const leave = () =>
      channel.postMessage({ sessionId, type: 'bye' });
    window.addEventListener('pagehide', leave);
    return () => {
      window.clearInterval(timer);
      window.clearInterval(poll);
      window.clearInterval(watchdog);
      window.removeEventListener('pagehide', leave);
      channel.close();
      channelRef.current = null;
    };
  }, [sessionId]);

  const master = useMemo(() => (html ? parseDeck(html) : null), [html]);
  const slides = useMemo(() => (master ? detectSlides(master) : []), [master]);
  const current = slides[index];
  const next = slides[index + 1];
  const connected = status === 'connected' && slides.length > 0;

  const send = (nextIndex: number) => {
    if (!connected || nextIndex < 0 || nextIndex >= slides.length) return;
    channelRef.current?.postMessage({
      sessionId,
      type: 'slide',
      index: nextIndex
    });
  };

  return (
    <main
      data-testid="presenter-view"
      className="flex min-h-screen flex-col gap-4 bg-[#0b0d12] p-6 text-zinc-100"
    >
      <header className="flex items-center justify-between border-b border-white/10 pb-3">
        <div>
          <h1 className="text-sm font-semibold tracking-wide">簡報者檢視</h1>
          <p className="text-xs text-zinc-500">
            第 {slides.length === 0 ? 0 : index + 1} / {slides.length} 頁
          </p>
        </div>
        <div className="flex items-center gap-4 text-xs">
          <span
            data-testid="presenter-status"
            role="status"
            className={
              status === 'connected' ? 'text-emerald-300' : 'text-amber-300'
            }
          >
            {STATUS_LABEL[status]}
          </span>
          <span data-testid="presenter-timer" className="tabular-nums">
            {formatElapsed(elapsed)}
          </span>
        </div>
      </header>

      <section aria-label="目前備註" className="flex flex-col gap-2">
        <h2 className="text-[11px] font-semibold uppercase tracking-[0.14em] text-zinc-500">
          備註
        </h2>
        <p
          data-testid="presenter-notes"
          className="min-h-24 whitespace-pre-wrap rounded border border-white/10 bg-white/5 p-3 text-sm leading-relaxed"
        >
          {notesOf(current?.element) || '此頁沒有備註。'}
        </p>
      </section>

      <section aria-label="下一頁" className="flex flex-col gap-2">
        <h2 className="text-[11px] font-semibold uppercase tracking-[0.14em] text-zinc-500">
          下一頁
        </h2>
        <div
          data-testid="presenter-next-preview"
          className="flex items-center gap-4 rounded border border-white/10 bg-white/5 p-3"
        >
          {next && master ? (
            <>
              <SlideMiniature
                master={master}
                slide={next}
                width={320}
                className="rounded shadow-md shadow-black/40"
              />
              <span className="text-sm text-zinc-300">
                {index + 2}. {slideTitle(next)}
              </span>
            </>
          ) : (
            <span className="text-sm text-zinc-500">（最後一頁）</span>
          )}
        </div>
      </section>

      <div className="flex gap-2">
        <button
          type="button"
          data-testid="presenter-prev"
          disabled={!connected || index <= 0}
          onClick={() => send(index - 1)}
          className="rounded border border-white/15 px-3 py-1.5 text-xs text-zinc-200 transition-colors hover:border-white/30 disabled:opacity-40"
        >
          上一頁
        </button>
        <button
          type="button"
          data-testid="presenter-next"
          disabled={!connected || index >= slides.length - 1}
          onClick={() => send(index + 1)}
          className="rounded border border-white/15 px-3 py-1.5 text-xs text-zinc-200 transition-colors hover:border-white/30 disabled:opacity-40"
        >
          下一頁
        </button>
      </div>

      {status === 'disconnected' && (
        <p role="alert" className="text-xs text-amber-300">
          未連線到主視窗。請從編輯器重新開啟簡報者檢視。
        </p>
      )}
    </main>
  );
}
