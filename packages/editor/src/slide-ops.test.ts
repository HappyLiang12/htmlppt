import { detectSlides, type SlideInfo } from '@htmlppt/core';
import { describe, expect, it } from 'vitest';
import { clampSlideIndex } from './slide-index.js';
import { parseDeck } from './slide-doc.js';
import {
  addSlideAfterActive,
  deleteSlideAt,
  duplicateActiveSlide,
  reorderSlides,
  reorderedIds,
  type SlideOpsContext
} from './slide-ops.js';

const DECK_HTML = `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><title>Fixture deck</title></head>
<body>
<main data-ppt-deck>
<section class="slide" data-slide-id="s1" data-width="1600" data-height="900">
  <h1 data-ppt-el="e1">First slide</h1>
  <p class="kicker" data-ppt-el="e2" style="color: #9a6b1f; letter-spacing: 0.18em">Kicker</p>
</section>
<section class="slide" data-slide-id="s2" data-width="1600" data-height="900">
  <h1 data-ppt-el="e3">Second slide</h1>
</section>
</main>
</body>
</html>`;

const SINGLE_SLIDE_HTML = `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><title>Single deck</title></head>
<body>
<main data-ppt-deck>
<section class="slide" data-slide-id="s1" data-width="1600" data-height="900">
  <h1 data-ppt-el="e1">Only slide</h1>
</section>
</main>
</body>
</html>`;

/**
 * A test-local controller double: commit applies the mutation synchronously
 * against the master and every getter reads the current document, mirroring
 * how the real controller refreshes its slide list after a commit. Save and
 * history behaviour is controller/E2E territory and is not simulated here.
 */
class ControllerDouble implements SlideOpsContext {
  readonly master: Document;
  skipMutation = false;
  commitCount = 0;
  showCount = 0;
  private active: number;

  constructor(html: string, activeIndex = 0) {
    this.master = parseDeck(html);
    this.active = activeIndex;
  }

  get slides(): readonly SlideInfo[] {
    return detectSlides(this.master);
  }

  get activeIndex(): number {
    return this.active;
  }

  async commit(mutate: (master: Document) => void): Promise<void> {
    this.commitCount += 1;
    if (this.skipMutation) return;
    mutate(this.master);
  }

  showSlide(index: number): void {
    this.showCount += 1;
    this.active = clampSlideIndex(index, detectSlides(this.master).length);
  }
}

function slideIds(controller: ControllerDouble): string[] {
  return controller.slides.map((slide) => slide.id);
}

function masterSlideIds(controller: ControllerDouble): string[] {
  return Array.from(
    controller.master.querySelectorAll('[data-slide-id]'),
    (element) => element.getAttribute('data-slide-id') ?? ''
  );
}

function slideElementAt(controller: ControllerDouble, index: number): Element {
  const slide = controller.slides[index]?.element;
  if (!slide) throw new Error(`Slide ${index} is missing.`);
  return slide;
}

describe('slide operations', () => {
  it('adds a slide after the active slide', async () => {
    const controller = new ControllerDouble(DECK_HTML);
    const originalOrder = masterSlideIds(controller);
    expect(originalOrder).toHaveLength(2);

    expect(await addSlideAfterActive(controller)).toBe(1);

    const addedId = controller.slides[1]?.id ?? '';
    expect(slideIds(controller)).toHaveLength(3);
    expect(masterSlideIds(controller)).toEqual([
      originalOrder[0],
      addedId,
      originalOrder[1]
    ]);
    expect(controller.activeIndex).toBe(1);
    expect(controller.commitCount).toBe(1);
    const added = slideElementAt(controller, 1);
    expect(added.querySelector('h1')?.textContent).toBe('新投影片');
    expect(added.getAttribute('data-width')).toBe('1600');
  });

  it('adds a slide after a non-active sorter tile', async () => {
    const controller = new ControllerDouble(DECK_HTML);

    expect(await addSlideAfterActive(controller, 1)).toBe(2);

    expect(slideIds(controller)).toHaveLength(3);
    expect(controller.activeIndex).toBe(2);
    expect(controller.commitCount).toBe(1);
  });

  it('duplicates a slide with a fresh id and copies its content', async () => {
    const controller = new ControllerDouble(DECK_HTML);
    const original = controller.slides[0];
    if (!original) throw new Error('First slide is missing.');

    expect(await duplicateActiveSlide(controller)).toBe(1);

    expect(slideIds(controller)).toHaveLength(3);
    const clone = controller.slides[1];
    expect(clone?.id).toBeDefined();
    expect(clone?.id).not.toBe(original.id);
    expect(controller.activeIndex).toBe(1);
    expect(controller.commitCount).toBe(1);

    const cloneElement = slideElementAt(controller, 1);
    expect(cloneElement.querySelector('h1')?.textContent).toBe('First slide');
    const kicker = cloneElement.querySelector('.kicker');
    expect(kicker?.textContent).toBe('Kicker');
    expect(kicker?.getAttribute('style')).toBe(
      'color: #9a6b1f; letter-spacing: 0.18em'
    );
    expect(cloneElement.innerHTML).toBe(slideElementAt(controller, 0).innerHTML);
  });

  it('deletes the active slide and selects its neighbor', async () => {
    const controller = new ControllerDouble(DECK_HTML);

    expect(await deleteSlideAt(controller, 0)).toBe(true);

    expect(slideIds(controller)).toEqual(['s2']);
    expect(controller.activeIndex).toBe(0);
    expect(controller.commitCount).toBe(1);
    expect(controller.showCount).toBe(1);
  });

  it('keeps the active slide selected when deleting another slide', async () => {
    const controller = new ControllerDouble(DECK_HTML, 1);

    expect(await deleteSlideAt(controller, 0)).toBe(true);

    expect(slideIds(controller)).toEqual(['s2']);
    expect(controller.activeIndex).toBe(0);
    expect(controller.showCount).toBe(1);
  });

  it('refuses to delete the last slide without committing', async () => {
    const controller = new ControllerDouble(SINGLE_SLIDE_HTML);

    expect(await deleteSlideAt(controller, 0)).toBe(false);

    expect(slideIds(controller)).toEqual(['s1']);
    expect(controller.activeIndex).toBe(0);
    expect(controller.commitCount).toBe(0);
    expect(controller.showCount).toBe(0);
  });

  it('reports a delete as failed when commit never applies the mutation', async () => {
    const controller = new ControllerDouble(DECK_HTML);
    controller.skipMutation = true;

    expect(await deleteSlideAt(controller, 0)).toBe(false);

    expect(slideIds(controller)).toEqual(['s1', 's2']);
    expect(controller.commitCount).toBe(1);
    expect(controller.showCount).toBe(0);
  });

  it('reorders slides from a sorter drop and follows the active slide', async () => {
    const controller = new ControllerDouble(DECK_HTML);

    expect(await reorderSlides(controller, ['s2', 's1'])).toBe(true);

    expect(slideIds(controller)).toEqual(['s2', 's1']);
    expect(controller.activeIndex).toBe(1);
    expect(controller.commitCount).toBe(1);
  });

  it('reports a reorder as failed when commit never applies the mutation', async () => {
    const controller = new ControllerDouble(DECK_HTML);
    controller.skipMutation = true;

    expect(await reorderSlides(controller, ['s2', 's1'])).toBe(false);

    expect(slideIds(controller)).toEqual(['s1', 's2']);
    expect(controller.commitCount).toBe(1);
    expect(controller.showCount).toBe(0);
  });

  it('ignores reorder requests that do not list every slide', async () => {
    const controller = new ControllerDouble(DECK_HTML);

    expect(await reorderSlides(controller, ['s1'])).toBe(false);

    expect(slideIds(controller)).toEqual(['s1', 's2']);
    expect(controller.commitCount).toBe(0);
    expect(controller.showCount).toBe(0);
  });
});

describe('sorter drag order', () => {
  const slides = ['s1', 's2', 's3', 's4'].map((id) => ({ id }));

  it('moves a tile forward one slot', () => {
    expect(reorderedIds(slides, 0, 1)).toEqual(['s2', 's1', 's3', 's4']);
  });

  it('moves a tile backward', () => {
    expect(reorderedIds(slides, 3, 1)).toEqual(['s1', 's4', 's2', 's3']);
  });

  it('removes the tile before inserting at a non-adjacent drop index', () => {
    expect(reorderedIds(slides, 0, 2)).toEqual(['s2', 's3', 's1', 's4']);
    expect(reorderedIds(slides, 2, 0)).toEqual(['s3', 's1', 's2', 's4']);
  });
});
