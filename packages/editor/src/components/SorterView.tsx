import {
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent
} from 'react';
import type { SlideInfo } from '@htmlppt/core';
import { useI18n } from '../i18n';
import { reorderedIds } from '../slide-ops';
import { SlideMiniature, slideTitle } from './ThumbnailRail';

export interface SorterViewProps {
  master: Document | null;
  slides: SlideInfo[];
  activeIndex: number;
  onSelect: (index: number) => void;
  onReorder: (slideIds: string[]) => void;
  onDuplicate: (index: number) => void;
  onDelete: (index: number) => void;
  canDelete: boolean;
}

interface DragSession {
  pointerId: number;
  from: number;
  startX: number;
  startY: number;
  moved: boolean;
  target: number | null;
}

const DRAG_THRESHOLD_SCREEN_PX = 4;
const SORTER_PREVIEW_WIDTH = 320;

export function SorterView({
  master,
  slides,
  activeIndex,
  onSelect,
  onReorder,
  onDuplicate,
  onDelete,
  canDelete
}: SorterViewProps) {
  const { t } = useI18n();
  const dragRef = useRef<DragSession | null>(null);
  const [dragging, setDragging] = useState<number | null>(null);
  const [dropIndex, setDropIndex] = useState<number | null>(null);

  const finishDrag = () => {
    dragRef.current = null;
    setDragging(null);
    setDropIndex(null);
  };

  const handlePointerDown = (
    event: ReactPointerEvent<HTMLDivElement>,
    index: number
  ) => {
    if (event.button !== 0) return;
    const target = event.target as Element;
    // Action buttons keep their own click behaviour.
    if (target.closest('button')) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    dragRef.current = {
      pointerId: event.pointerId,
      from: index,
      startX: event.clientX,
      startY: event.clientY,
      moved: false,
      target: index
    };
  };

  const handlePointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;

    if (!drag.moved) {
      const distance = Math.hypot(
        event.clientX - drag.startX,
        event.clientY - drag.startY
      );
      if (distance < DRAG_THRESHOLD_SCREEN_PX) return;
      drag.moved = true;
      setDragging(drag.from);
    }

    event.preventDefault();
    const under = document.elementFromPoint(event.clientX, event.clientY);
    const tile = under?.closest('[data-sorter-index]');
    const index = tile
      ? Number(tile.getAttribute('data-sorter-index'))
      : Number.NaN;
    const target = Number.isInteger(index) ? index : null;
    drag.target = target;
    setDropIndex(target);
  };

  const handlePointerUp = (event: ReactPointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    const { from, moved, target } = drag;
    finishDrag();

    if (!moved) {
      onSelect(from);
      return;
    }
    if (target !== null && target !== from) {
      onReorder(reorderedIds(slides, from, target));
    }
  };

  const handleKeyDown = (
    event: ReactKeyboardEvent<HTMLDivElement>,
    index: number
  ) => {
    if (event.target !== event.currentTarget) return;
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      onSelect(index);
    }
  };

  return (
    <main
      data-testid="sorter-view"
      className="min-h-0 flex-1 overflow-auto bg-[#0a0c10] p-6"
    >
      <div className="mb-4 flex items-baseline justify-between">
        <h2 className="text-sm font-semibold text-zinc-200">
          {t('sorter.title')}
        </h2>
        <p className="text-xs text-zinc-400">{t('sorter.hint')}</p>
      </div>
      <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-4">
        {slides.map((slide, index) => {
          const active = index === activeIndex;
          const title = slideTitle(slide, t('rail.untitled'));
          const isDropTarget =
            dragging !== null && dropIndex === index && dropIndex !== dragging;
          return (
            <div
              key={slide.id}
              data-sorter-index={index}
              onPointerDown={(event) => handlePointerDown(event, index)}
              onPointerMove={handlePointerMove}
              onPointerUp={handlePointerUp}
              onPointerCancel={finishDrag}
              className={`relative flex cursor-grab flex-col gap-2 rounded-lg border p-2 transition-colors ${
                active
                  ? 'border-amber-400/70 bg-amber-400/10'
                  : 'border-white/10 bg-white/[0.02] hover:border-white/25'
              } ${dragging === index ? 'opacity-50' : ''} ${
                isDropTarget ? 'ring-2 ring-amber-400' : ''
              }`}
            >
              {/* One single-option listbox per tile keeps its action row
                  outside the listbox while staying attached to the card. */}
              <div
                role="listbox"
                aria-label={t('sorter.page', { index: index + 1 })}
                className="rounded"
              >
                <div
                  role="option"
                  tabIndex={0}
                  aria-selected={active}
                  aria-current={active ? 'page' : undefined}
                  aria-label={t('sorter.pageTitle', {
                    index: index + 1,
                    title
                  })}
                  data-testid="sorter-slide"
                  data-slide-id={slide.id}
                  data-slide-title={title}
                  onKeyDown={(event) => handleKeyDown(event, index)}
                  className="relative flex flex-col gap-2 rounded focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-amber-400"
                >
                  <span className="absolute left-1 top-1 z-10 rounded bg-black/70 px-1.5 py-0.5 text-[11px] tabular-nums text-zinc-200">
                    {index + 1}
                  </span>
                  {active && (
                    <span
                      data-testid="sorter-active-marker"
                      aria-hidden="true"
                      className="absolute right-1 top-1 z-10 rounded bg-amber-400 px-1.5 py-0.5 text-[10px] font-semibold text-zinc-950"
                    >
                      {t('sorter.current')}
                    </span>
                  )}
                  <SlideMiniature
                    master={master}
                    slide={slide}
                    width={SORTER_PREVIEW_WIDTH}
                    className="rounded-[3px] shadow-md shadow-black/40"
                  />
                  <span
                    className={`truncate px-1 text-xs ${
                      active ? 'text-amber-200' : 'text-zinc-300'
                    }`}
                  >
                    {title}
                  </span>
                </div>
              </div>
              <div className="flex justify-end gap-1">
                <button
                  type="button"
                  data-testid="sorter-duplicate"
                  aria-label={t('sorter.copyLabel', { index: index + 1 })}
                  onClick={(event) => {
                    if (event.detail <= 1) onDuplicate(index);
                  }}
                  className="rounded border border-white/40 px-2 py-1 text-[11px] text-zinc-300 hover:border-white/60"
                >
                  {t('sorter.copy')}
                </button>
                <button
                  type="button"
                  data-testid="sorter-delete"
                  aria-label={t('sorter.deleteLabel', { index: index + 1 })}
                  onClick={(event) => {
                    if (event.detail <= 1) onDelete(index);
                  }}
                  disabled={!canDelete}
                  className="rounded border border-white/40 px-2 py-1 text-[11px] text-zinc-300 hover:border-white/60 disabled:opacity-40"
                >
                  {t('sorter.delete')}
                </button>
              </div>
            </div>
          );
        })}
      </div>
    </main>
  );
}
