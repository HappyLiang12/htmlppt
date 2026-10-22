import {
  addSlide,
  deleteSlide,
  detectSlides,
  duplicateSlide,
  setSlideOrder,
  type SlideInfo
} from '@htmlppt/core';
import { clampSlideIndex } from './slide-index';

/** Content created by the editor for a new, blank slide. */
export const NEW_SLIDE_HTML = '<h1>新投影片</h1>';

/**
 * The controller surface slide operations need. It is deliberately narrow so
 * the operations can run against a controller double in unit tests and the
 * real controller in the app without owning any React state themselves.
 */
export interface SlideOpsContext {
  master: Document | null;
  slides: readonly SlideInfo[];
  activeIndex: number;
  commit(mutate: (master: Document) => void): Promise<void>;
  showSlide(index: number): void;
}

function indexOfSlide(master: Document, slideId: string): number {
  return detectSlides(master).findIndex((slide) => slide.id === slideId);
}

/**
 * Sorter drag order: remove the dragged tile first, then insert it at the drop
 * target's index in the shortened list. A forward drag therefore lands after
 * the tile it was dropped on and a backward drag lands before it.
 */
export function reorderedIds(
  slides: readonly Pick<SlideInfo, 'id'>[],
  from: number,
  to: number
): string[] {
  const ids = slides.map((slide) => slide.id);
  const [moved] = ids.splice(from, 1);
  if (moved !== undefined) ids.splice(to, 0, moved);
  return ids;
}

/**
 * Runs one master-level mutation through the controller. A mutation failure
 * leaves the deck untouched and is reported as `null`; a save failure still
 * applied the mutation and its history entry, so navigation proceeds while the
 * controller surfaces the save error.
 */
async function commitAndShow(
  ctx: SlideOpsContext,
  mutate: (master: Document) => string | null
): Promise<number | null> {
  const master = ctx.master;
  if (!master) return null;

  const result: { slideId: string | null } = { slideId: null };
  let applied = false;
  try {
    await ctx.commit((draft) => {
      result.slideId = mutate(draft);
      applied = true;
    });
  } catch {
    if (!applied) return null;
  }

  const slideId = result.slideId;
  if (!slideId) return null;
  const index = indexOfSlide(master, slideId);
  if (index < 0) return null;
  ctx.showSlide(index);
  return index;
}

export async function addSlideAfterActive(
  ctx: SlideOpsContext,
  afterIndex = ctx.activeIndex,
  html: string = NEW_SLIDE_HTML
): Promise<number | null> {
  const anchor = ctx.slides[afterIndex];
  if (!ctx.master || !anchor) return null;
  return commitAndShow(ctx, (draft) =>
    addSlide(draft, { afterSlideId: anchor.id, html })
  );
}

export async function duplicateActiveSlide(
  ctx: SlideOpsContext,
  index = ctx.activeIndex
): Promise<number | null> {
  const source = ctx.slides[index];
  if (!ctx.master || !source) return null;
  return commitAndShow(ctx, (draft) => duplicateSlide(draft, source.id));
}

export async function deleteSlideAt(
  ctx: SlideOpsContext,
  index = ctx.activeIndex
): Promise<boolean> {
  const master = ctx.master;
  const slide = ctx.slides[index];
  // The last slide is never removable; core refuses it too, but rejecting
  // before commit keeps the refusal out of history and off the wire.
  if (!master || !slide || ctx.slides.length <= 1) return false;

  const activeId = ctx.slides[ctx.activeIndex]?.id ?? null;
  let applied = false;
  try {
    await ctx.commit((draft) => {
      deleteSlide(draft, slide.id);
      applied = true;
    });
  } catch {
    if (!applied) return false;
  }
  // A commit that resolves without invoking the mutator (for example a busy
  // or stale controller guard) has not changed the deck.
  if (!applied) return false;

  const slides = detectSlides(master);
  const active = activeId
    ? slides.findIndex((candidate) => candidate.id === activeId)
    : -1;
  ctx.showSlide(active >= 0 ? active : clampSlideIndex(index, slides.length));
  return true;
}

export async function reorderSlides(
  ctx: SlideOpsContext,
  slideIds: readonly string[]
): Promise<boolean> {
  const master = ctx.master;
  if (!master || slideIds.length !== ctx.slides.length) return false;

  const activeId = ctx.slides[ctx.activeIndex]?.id ?? null;
  let applied = false;
  try {
    await ctx.commit((draft) => {
      setSlideOrder(draft, [...slideIds]);
      applied = true;
    });
  } catch {
    if (!applied) return false;
  }
  if (!applied) return false;

  const slides = detectSlides(master);
  const active = activeId
    ? slides.findIndex((candidate) => candidate.id === activeId)
    : -1;
  ctx.showSlide(active >= 0 ? active : clampSlideIndex(ctx.activeIndex, slides.length));
  return true;
}
