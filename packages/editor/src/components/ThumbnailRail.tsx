import { useEffect, useMemo, useRef } from 'react';
import type { SlideInfo } from '@htmlppt/core';
import { useI18n } from '../i18n';
import { buildSlideSrcDoc } from '../slide-doc';

/** Slides without a heading still need a readable label in editor chrome. */
export function slideTitle(
  slide: SlideInfo,
  untitled = '未命名投影片'
): string {
  const heading = slide.element.querySelector('h1, h2, h3, [data-ppt-title]');
  const text = heading?.textContent?.replace(/\s+/g, ' ').trim();
  return text || untitled;
}

export interface SlideMiniatureProps {
  master: Document | null;
  slide: SlideInfo;
  width: number;
  className?: string;
}

/**
 * A scaled, script-free preview of one slide. The preview deliberately omits
 * the canvas frame marker so it cannot disturb the main preview session.
 */
export function SlideMiniature({
  master,
  slide,
  width,
  className = ''
}: SlideMiniatureProps) {
  const { t } = useI18n();
  const srcDoc = useMemo(
    () =>
      master ? buildSlideSrcDoc(master, slide, { markFrame: false }) : '',
    [master, slide]
  );
  const scale = width / slide.width;
  const height = Math.round(slide.height * scale);

  return (
    <div
      className={`relative overflow-hidden bg-white ${className}`}
      style={{ width, height }}
      aria-hidden="true"
    >
      {srcDoc && (
        <iframe
          title={t('rail.thumbnail')}
          sandbox="allow-same-origin"
          srcDoc={srcDoc}
          tabIndex={-1}
          className="pointer-events-none absolute left-0 top-0 border-0"
          style={{
            width: slide.width,
            height: slide.height,
            transform: `scale(${scale})`,
            transformOrigin: 'top left'
          }}
        />
      )}
    </div>
  );
}

export interface ThumbnailRailProps {
  master: Document | null;
  slides: SlideInfo[];
  activeIndex: number;
  onSelect: (index: number) => void;
}

const THUMBNAIL_WIDTH = 152;

export function ThumbnailRail({
  master,
  slides,
  activeIndex,
  onSelect
}: ThumbnailRailProps) {
  const { t } = useI18n();
  const activeRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    activeRef.current?.scrollIntoView({ block: 'nearest' });
  }, [activeIndex, slides.length]);

  return (
    <aside
      data-testid="thumbnail-rail"
      aria-label={t('rail.thumbnail')}
      className="flex w-48 shrink-0 flex-col gap-2 overflow-y-auto border-r border-white/10 p-3"
    >
      {slides.map((slide, index) => {
        const active = index === activeIndex;
        const title = slideTitle(slide, t('rail.untitled'));
        return (
          <div
            key={slide.id}
            ref={active ? activeRef : undefined}
            data-testid="thumbnail"
            data-slide-id={slide.id}
            data-slide-title={title}
            aria-current={active ? 'page' : undefined}
            className={`relative flex flex-col gap-1 rounded border p-1 transition-colors ${
              active
                ? 'border-amber-400/70 bg-amber-400/10'
                : 'border-white/10 hover:border-white/25'
            }`}
          >
            <SlideMiniature
              master={master}
              slide={slide}
              width={THUMBNAIL_WIDTH}
              className="rounded-[2px] shadow-md shadow-black/40"
            />
            {active && (
              <span
                data-testid="thumbnail-active-marker"
                aria-hidden="true"
                title={t('rail.current')}
                className="absolute right-1 top-1 rounded bg-amber-400 px-1 py-0.5 text-[10px] font-semibold text-zinc-950"
              >
                ✓
              </span>
            )}
            <span
              className={`flex items-center gap-1 px-1 pb-0.5 text-[11px] ${
                active ? 'text-amber-200' : 'text-zinc-400'
              }`}
            >
              <span className="tabular-nums">{index + 1}</span>
              <span className="truncate">{title}</span>
            </span>
            <button
              type="button"
              aria-label={t('rail.pageTitle', {
                index: index + 1,
                title
              })}
              aria-current={active ? 'page' : undefined}
              onClick={() => onSelect(index)}
              className="absolute inset-0 rounded focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-amber-400"
            />
          </div>
        );
      })}
    </aside>
  );
}
