import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { serializeDeck } from '@htmlppt/core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { DeckResponse } from './api.js';
import {
  addSlideAfterActive,
  deleteSlideAt,
  duplicateActiveSlide,
  moveSlideTo,
  reorderSlides,
  NEW_SLIDE_HTML,
  type SlideOpsContext
} from './slide-ops.js';
import {
  useDeckController,
  type DeckController,
  type DeckSaver
} from './use-deck-controller.js';

const DECK: DeckResponse = {
  revision: 'revision-1',
  filePath: 'fixture.html',
  html: `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><title>Fixture deck</title></head>
<body>
<main data-ppt-deck>
<section class="slide"><h1>First slide</h1><p class="kicker">Kicker</p></section>
<section class="slide"><h1>Second slide</h1></section>
</main>
</body>
</html>`
};

const SINGLE_SLIDE_DECK: DeckResponse = {
  revision: 'revision-single',
  filePath: 'single.html',
  html: `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><title>Single deck</title></head>
<body>
<main data-ppt-deck>
<section class="slide"><h1>Only slide</h1></section>
</main>
</body>
</html>`
};

interface SavedDeck {
  html: string;
  baseRevision: string;
}

let container: HTMLDivElement;
let root: Root;
let controller!: DeckController;
let saves: SavedDeck[] = [];

const save: DeckSaver = async (_token, html, baseRevision) => {
  saves.push({ html, baseRevision });
  return { revision: `revision-${saves.length + 1}` };
};

function Probe() {
  controller = useDeckController({ token: '', save });
  return null;
}

function context(): SlideOpsContext {
  return {
    master: controller.state.master,
    slides: controller.state.slides,
    activeIndex: controller.state.activeIndex,
    commit: controller.actions.commit,
    showSlide: controller.actions.showSlide
  };
}

function slideIds(): string[] {
  return controller.state.slides.map((slide) => slide.id);
}

function masterSlideIds(): string[] {
  const master = controller.state.master;
  if (!master) throw new Error('Master document is missing.');
  return Array.from(master.querySelectorAll('[data-slide-id]')).map(
    (element) => element.getAttribute('data-slide-id') ?? ''
  );
}

async function loadDeck(deck: DeckResponse = DECK): Promise<void> {
  await act(async () => {
    await controller.actions.load(deck);
  });
}

beforeEach(async () => {
  (
    globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
  saves = [];
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root.render(createElement(Probe));
  });
});

afterEach(async () => {
  await act(async () => {
    root.unmount();
  });
  container.remove();
});

describe('slide operations', () => {
  it('adds a slide after the active slide and keeps it as one history entry', async () => {
    await loadDeck();
    const originalOrder = masterSlideIds();
    expect(originalOrder).toHaveLength(2);

    let inserted: number | null = null;
    await act(async () => {
      inserted = await addSlideAfterActive(context());
    });

    expect(inserted).toBe(1);
    const addedId = controller.state.slides[1]?.id ?? '';
    expect(slideIds()).toHaveLength(3);
    expect(masterSlideIds()).toEqual([
      originalOrder[0],
      addedId,
      originalOrder[1]
    ]);
    expect(controller.state.activeIndex).toBe(1);
    expect(controller.state.srcDoc).toContain('新投影片');
    expect(saves).toHaveLength(1);
    expect(saves[0]?.html).toContain('新投影片');
    expect(saves[0]?.html).toMatch(/<h1[^>]*>新投影片<\/h1>/);
    expect(NEW_SLIDE_HTML).toContain('新投影片');

    act(() => {
      controller.actions.undo();
    });
    expect(slideIds()).toEqual(originalOrder);
    expect(controller.state.master?.querySelectorAll('[data-slide-id]')).toHaveLength(2);
    expect(controller.state.srcDoc).not.toContain('新投影片');
  });

  it('adds a slide after a non-active sorter tile', async () => {
    await loadDeck();

    await act(async () => {
      await addSlideAfterActive(context(), 1);
    });

    expect(slideIds()).toHaveLength(3);
    expect(controller.state.activeIndex).toBe(2);
    expect(controller.state.srcDoc).toContain('新投影片');
  });

  it('duplicates a slide with a fresh id and identical content', async () => {
    await loadDeck();
    const original = controller.state.slides[0];
    if (!original) throw new Error('First slide is missing.');
    const originalHeading = controller.state.master
      ?.querySelector('[data-slide-id="s1"] h1')
      ?.textContent;

    let duplicated: number | null = null;
    await act(async () => {
      duplicated = await duplicateActiveSlide(context());
    });

    expect(duplicated).toBe(1);
    expect(slideIds()).toHaveLength(3);
    const clone = controller.state.slides[1];
    expect(clone?.id).toBeDefined();
    expect(clone?.id).not.toBe(original.id);
    expect(controller.state.activeIndex).toBe(1);
    expect(controller.state.srcDoc).toContain(originalHeading ?? 'First slide');
    expect(saves).toHaveLength(1);

    act(() => {
      controller.actions.undo();
    });
    expect(controller.state.slides).toHaveLength(2);
    expect(slideIds()).toEqual(['s1', 's2']);
  });

  it('deletes the active slide and undo restores the exact deck', async () => {
    await loadDeck();
    const before = serializeDeck(controller.state.master as Document);

    let deleted = false;
    await act(async () => {
      deleted = await deleteSlideAt(context(), 0);
    });

    expect(deleted).toBe(true);
    expect(slideIds()).toHaveLength(1);
    expect(slideIds()).toEqual(['s2']);
    expect(controller.state.srcDoc).toContain('Second slide');
    expect(controller.state.srcDoc).not.toContain('First slide');
    expect(saves).toHaveLength(1);

    act(() => {
      controller.actions.undo();
    });
    expect(controller.state.slides).toHaveLength(2);
    expect(slideIds()).toEqual(['s1', 's2']);
    expect(serializeDeck(controller.state.master as Document)).toBe(before);
    expect(controller.state.srcDoc).toContain('First slide');
  });

  it('keeps the active slide selected when deleting another slide', async () => {
    await loadDeck();
    act(() => {
      controller.actions.showSlide(1);
    });
    expect(controller.state.activeIndex).toBe(1);

    let deleted = false;
    await act(async () => {
      deleted = await deleteSlideAt(context(), 0);
    });

    expect(deleted).toBe(true);
    expect(slideIds()).toEqual(['s2']);
    expect(controller.state.activeIndex).toBe(0);
    expect(controller.state.srcDoc).toContain('Second slide');
  });

  it('refuses to delete the last slide without saving or recording history', async () => {
    await loadDeck(SINGLE_SLIDE_DECK);
    const before = serializeDeck(controller.state.master as Document);

    let deleted = true;
    await act(async () => {
      deleted = await deleteSlideAt(context(), 0);
    });

    expect(deleted).toBe(false);
    expect(controller.state.slides).toHaveLength(1);
    expect(controller.state.activeIndex).toBe(0);
    expect(saves).toHaveLength(0);
    expect(serializeDeck(controller.state.master as Document)).toBe(before);

    act(() => {
      controller.actions.undo();
    });
    expect(serializeDeck(controller.state.master as Document)).toBe(before);
  });

  it('moves a slide to an index and follows it with the active slide', async () => {
    await loadDeck();
    const before = serializeDeck(controller.state.master as Document);

    let movedTo: number | null = null;
    await act(async () => {
      movedTo = await moveSlideTo(context(), 0, 1);
    });

    expect(movedTo).toBe(1);
    expect(slideIds()).toEqual(['s2', 's1']);
    expect(controller.state.activeIndex).toBe(1);
    expect(controller.state.srcDoc).toContain('First slide');
    expect(saves).toHaveLength(1);

    act(() => {
      controller.actions.undo();
    });
    expect(slideIds()).toEqual(['s1', 's2']);
    expect(serializeDeck(controller.state.master as Document)).toBe(before);
  });

  it('reorders slides from a sorter drop and follows the active slide', async () => {
    await loadDeck();

    let reordered = false;
    await act(async () => {
      reordered = await reorderSlides(context(), ['s2', 's1']);
    });

    expect(reordered).toBe(true);
    expect(slideIds()).toEqual(['s2', 's1']);
    expect(controller.state.activeIndex).toBe(1);
    expect(controller.state.srcDoc).toContain('First slide');
    expect(saves).toHaveLength(1);

    act(() => {
      controller.actions.undo();
    });
    expect(slideIds()).toEqual(['s1', 's2']);
  });

  it('ignores reorder requests that do not list every slide', async () => {
    await loadDeck();

    let reordered = true;
    await act(async () => {
      reordered = await reorderSlides(context(), ['s1']);
    });

    expect(reordered).toBe(false);
    expect(slideIds()).toEqual(['s1', 's2']);
    expect(saves).toHaveLength(0);
  });
});
