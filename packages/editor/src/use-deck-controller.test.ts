import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  type DeckPersistence,
  type DeckResponse
} from './api.js';
import { parseDeck } from './slide-doc.js';
import {
  hasEditorArtifacts,
  useDeckController,
  type DeckController
} from './use-deck-controller.js';
import type { Translator } from './i18n';

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

let container: HTMLDivElement;
let root: Root;
let controller!: DeckController;
let persistence: DeckPersistence;
let translate: Translator | undefined;
const saveCalls: Array<{ force?: boolean }> = [];

function Probe() {
  controller = useDeckController({ persistence, translate });
  return null;
}

beforeEach(async () => {
  saveCalls.length = 0;
  translate = undefined;
  persistence = {
    load: () => Promise.reject(new Error('Unexpected load.')),
    save: async (_html, _baseRevision, options) => {
      saveCalls.push(options ?? {});
      return { revision: 'saved-revision' };
    },
    flush: () => undefined
  };
  (
    globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
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

describe('useDeckController', () => {
  it('normalizes the loaded deck through core and shows the first slide', async () => {
    await act(async () => {
      await controller.actions.load(DECK);
    });

    expect(controller.state.status).toBe('ready');
    expect(controller.state.dirty).toBe(false);
    expect(controller.state.conflict).toBeNull();
    expect(controller.state.selection).toBeNull();
    expect(controller.state.scale).toBe(1);
    expect(controller.state.slides).toHaveLength(2);
    expect(controller.state.activeIndex).toBe(0);
    expect(controller.state.filePath).toBe('fixture.html');
    expect(controller.state.srcDoc).toContain('First slide');
    expect(controller.state.srcDoc).not.toContain('Second slide');

    const master = controller.state.master;
    expect(master).not.toBeNull();
    expect(
      master?.querySelector('section')?.getAttribute('data-slide-id')
    ).toBe('s1');
    expect(master?.querySelector('h1')?.getAttribute('data-ppt-el')).toBe('e1');
  });

  it('clamps showSlide to the available slides', async () => {
    await act(async () => {
      await controller.actions.load(DECK);
    });

    act(() => {
      controller.actions.showSlide(99);
    });
    expect(controller.state.activeIndex).toBe(1);
    expect(controller.state.srcDoc).toContain('Second slide');

    act(() => {
      controller.actions.showSlide(-4);
    });
    expect(controller.state.activeIndex).toBe(0);
    expect(controller.state.srcDoc).toContain('First slide');
  });

  it('stores selection and scale in controller state', async () => {
    await act(async () => {
      await controller.actions.load(DECK);
    });

    act(() => {
      controller.actions.select({ slideIndex: 0, path: [0], elementId: 'e1' });
    });
    expect(controller.state.selection).toEqual({
      slideIndex: 0,
      path: [0],
      elementId: 'e1'
    });
    expect(controller.state.selections).toEqual([
      { slideIndex: 0, path: [0], elementId: 'e1' }
    ]);

    act(() => {
      controller.actions.clearSelection();
      controller.actions.setScale(0.5);
    });
    expect(controller.state.selection).toBeNull();
    expect(controller.state.selections).toEqual([]);
    expect(controller.state.scale).toBe(0.5);
  });

  it('toggles Shift multi-select and clears it when the last target leaves', async () => {
    await act(async () => {
      await controller.actions.load(DECK);
    });

    act(() => {
      controller.actions.select({ slideIndex: 0, path: [0], elementId: 'e1' });
      controller.actions.toggleSelect({
        slideIndex: 0,
        path: [1],
        elementId: 'e2'
      });
    });
    expect(controller.state.selections.map((target) => target.path)).toEqual([
      [0],
      [1]
    ]);
    expect(controller.state.selection?.path).toEqual([0]);

    act(() => {
      controller.actions.toggleSelect({
        slideIndex: 0,
        path: [0],
        elementId: 'e1'
      });
    });
    expect(controller.state.selections.map((target) => target.path)).toEqual([
      [1]
    ]);
    expect(controller.state.selection?.path).toEqual([1]);

    act(() => {
      controller.actions.toggleSelect({
        slideIndex: 0,
        path: [1],
        elementId: 'e2'
      });
    });
    expect(controller.state.selections).toEqual([]);
    expect(controller.state.selection).toBeNull();
  });

  it('replaces a multi selection when toggling a nested or cross-slide target', async () => {
    await act(async () => {
      await controller.actions.load(DECK);
    });

    act(() => {
      controller.actions.select({ slideIndex: 0, path: [0], elementId: 'e1' });
      controller.actions.toggleSelect({
        slideIndex: 0,
        path: [1],
        elementId: 'e2'
      });
      controller.actions.toggleSelect({
        slideIndex: 0,
        path: [0, 0],
        elementId: null
      });
    });
    expect(controller.state.selections).toEqual([
      { slideIndex: 0, path: [0, 0], elementId: null }
    ]);

    act(() => {
      controller.actions.toggleSelect({
        slideIndex: 1,
        path: [0],
        elementId: 'e1'
      });
    });
    expect(controller.state.selections).toEqual([
      { slideIndex: 1, path: [0], elementId: 'e1' }
    ]);
  });

  it('selects every top-level object on the active slide', async () => {
    await act(async () => {
      await controller.actions.load(DECK);
    });

    act(() => {
      controller.actions.selectAll();
    });

    expect(controller.state.selections.map((target) => target.path)).toEqual([
      [0],
      [1]
    ]);
    expect(controller.state.selection?.path).toEqual([0]);
  });

  it('restores the active slide index with undo and redo after an add', async () => {
    await act(async () => {
      await controller.actions.load(DECK);
    });
    expect(controller.state.activeIndex).toBe(0);

    await act(async () => {
      await controller.actions.commitMaster((master) => {
        const deck = master.querySelector('[data-ppt-deck]');
        const first = master.querySelector('section');
        if (!deck || !first) throw new Error('Missing deck fixture nodes.');
        const added = first.cloneNode(true) as Element;
        added.setAttribute('data-slide-id', 's3');
        deck.appendChild(added);
      });
    });
    act(() => {
      controller.actions.showSlide(1);
    });
    expect(controller.state.activeIndex).toBe(1);
    expect(controller.state.slides).toHaveLength(3);

    await act(async () => {
      controller.actions.undo();
    });
    expect(controller.state.activeIndex).toBe(0);
    expect(controller.state.slides).toHaveLength(2);

    await act(async () => {
      controller.actions.redo();
    });
    expect(controller.state.activeIndex).toBe(1);
    expect(controller.state.slides).toHaveLength(3);
  });

  it('deletes every selected object as one history entry', async () => {
    await act(async () => {
      await controller.actions.load(DECK);
    });

    act(() => {
      controller.actions.select({ slideIndex: 0, path: [0], elementId: 'e1' });
      controller.actions.toggleSelect({
        slideIndex: 0,
        path: [1],
        elementId: 'e2'
      });
    });

    await act(async () => {
      await controller.actions.deleteSelection();
    });
    const slide = () => controller.state.slides[0]?.element;
    expect(slide()?.querySelector('h1')).toBeNull();
    expect(slide()?.querySelector('p')).toBeNull();
    expect(controller.state.selections).toEqual([]);

    await act(async () => {
      controller.actions.undo();
    });
    expect(slide()?.querySelector('h1')?.textContent).toBe('First slide');
    expect(slide()?.querySelector('p')?.textContent).toBe('Kicker');

    await act(async () => {
      controller.actions.redo();
    });
    expect(slide()?.querySelector('h1')).toBeNull();
    expect(slide()?.querySelector('p')).toBeNull();
  });

  it('pastes copied objects with fresh ids and one history entry', async () => {
    await act(async () => {
      await controller.actions.load(DECK);
    });

    act(() => {
      controller.actions.select({ slideIndex: 0, path: [0], elementId: 'e1' });
      controller.actions.copySelection();
    });

    await act(async () => {
      await controller.actions.pasteObjects();
    });
    const slide = () => controller.state.slides[0]?.element;
    const headings = slide() ? Array.from(slide()!.querySelectorAll('h1')) : [];
    expect(headings).toHaveLength(2);
    expect(headings[1]?.textContent).toBe('First slide');
    expect(headings[1]?.getAttribute('data-ppt-el')).not.toBe('e1');
    expect(controller.state.selection?.path).toEqual([2]);

    await act(async () => {
      controller.actions.undo();
    });
    expect(slide()?.querySelectorAll('h1')).toHaveLength(1);

    await act(async () => {
      controller.actions.redo();
    });
    expect(slide()?.querySelectorAll('h1')).toHaveLength(2);
  });

  it('applies slide mutations and restores them through undo and redo', async () => {
    await act(async () => {
      await controller.actions.load(DECK);
    });

    act(() => {
      controller.actions.applySlideMutation(0, (slide) => {
        const heading = slide.querySelector('h1');
        if (!heading) throw new Error('Missing heading.');
        heading.textContent = 'Changed heading';
      });
    });
    expect(controller.state.dirty).toBe(true);
    expect(controller.state.srcDoc).toContain('Changed heading');
    expect(controller.state.master?.querySelector('h1')?.textContent).toBe(
      'Changed heading'
    );

    act(() => {
      controller.actions.undo();
    });
    expect(controller.state.srcDoc).toContain('First slide');
    expect(controller.state.srcDoc).not.toContain('Changed heading');
    expect(controller.state.master?.querySelector('h1')?.textContent).toBe(
      'First slide'
    );

    act(() => {
      controller.actions.redo();
    });
    expect(controller.state.srcDoc).toContain('Changed heading');
  });

  it('surfaces master mutation failures without recording history', async () => {
    await act(async () => {
      await controller.actions.load(DECK);
    });

    await act(async () => {
      await expect(
        controller.actions.commitMaster(() => {
          throw new Error('Master mutation failed');
        })
      ).rejects.toThrow('Master mutation failed');
    });

    expect(controller.state.status).toBe('error');
    expect(controller.state.error).toBe('Master mutation failed');
    expect(controller.state.dirty).toBe(false);
    expect(controller.state.master?.querySelector('h1')?.textContent).toBe(
      'First slide'
    );
  });

  it('translates a failed pending edit through the supplied translator', async () => {
    translate = (key) => `translated:${key}`;
    await act(async () => {
      root.render(createElement(Probe, { key: 'translated-pending' }));
    });

    act(() => {
      controller.actions.changePendingEdit('text', {
        apply: () => false,
        discard: () => undefined
      });
    });
    let settled = true;
    act(() => {
      settled = controller.actions.settlePendingEdits();
    });

    expect(settled).toBe(false);
    expect(controller.state.error).toBe('translated:editor.pendingEditFailed');
  });

  it('translates a reload failure through the supplied translator', async () => {
    translate = (key) => `translated:${key}`;
    await act(async () => {
      root.render(createElement(Probe, { key: 'translated-reload' }));
    });

    await act(async () => {
      await controller.actions.reload();
    });

    expect(controller.state.status).toBe('error');
    expect(controller.state.error).toBe('translated:editor.reloadFailed');
  });

  it('keeps decks with authored data-ppt-editing markers unnormalized', async () => {
    const authored: DeckResponse = {
      revision: 'revision-authored',
      filePath: 'authored.html',
      html: `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><title>Authored deck</title></head>
<body>
<main data-ppt-deck>
<section class="slide"><h1 data-ppt-editing="true">First slide</h1><p class="kicker">Kicker</p></section>
</main>
</body>
</html>`
    };

    expect(hasEditorArtifacts(parseDeck(authored.html))).toBe(true);
    expect(hasEditorArtifacts(parseDeck(DECK.html))).toBe(false);

    await act(async () => {
      await controller.actions.load(authored);
    });

    expect(controller.state.status).toBe('ready');
    const heading = controller.state.master?.querySelector('h1');
    expect(heading?.getAttribute('data-ppt-editing')).toBe('true');
    expect(controller.state.master?.querySelector('[data-ppt-el]')).toBeNull();
    expect(controller.state.master?.querySelector('[data-slide-id]')).toBeNull();

    // A clean deck still goes through core normalization.
    await act(async () => {
      await controller.actions.load(DECK);
    });
    expect(
      controller.state.master?.querySelector('h1')?.getAttribute('data-ppt-el')
    ).toBe('e1');
  });

  it('leaves decks with authored editor artifacts unnormalized for the host to reject', async () => {
    const spoofed: DeckResponse = {
      revision: 'revision-2',
      filePath: 'spoofed.html',
      html: `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><title>Spoofed deck</title></head>
<body>
<section class="slide" data-slide-id="s1" data-ppt-frame-slide="1"><h1>First</h1></section>
</body>
</html>`
    };

    await act(async () => {
      await controller.actions.load(spoofed);
    });

    const section = controller.state.master?.querySelector('section');
    expect(section?.getAttribute('data-ppt-frame-slide')).toBe('1');
    expect(section?.querySelector('h1')?.hasAttribute('data-ppt-el')).toBe(
      false
    );
    expect(controller.state.status).toBe('ready');
  });

  it('ignores the revision it just saved', async () => {
    await act(async () => {
      await controller.actions.load(DECK);
    });

    act(() => {
      controller.actions.receiveRevision({
        type: 'revision',
        revision: DECK.revision,
        source: 'editor'
      });
    });

    expect(controller.state.conflict).toBeNull();
    expect(controller.state.status).toBe('ready');
    expect(controller.state.dirty).toBe(false);
    expect(controller.state.activeIndex).toBe(0);
  });

  it('conflicts on a dirty external revision and reload remaps by slide and element id', async () => {
    const external: DeckResponse = {
      revision: 'revision-external',
      filePath: 'fixture.html',
      html: `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><title>Fixture deck</title></head>
<body>
<main data-ppt-deck>
<section class="slide" data-slide-id="s0"><h1 data-ppt-el="e1">Inserted</h1></section>
<section class="slide" data-slide-id="s1"><h1 data-ppt-el="e1">First external</h1></section>
<section class="slide" data-slide-id="s2"><h1 data-ppt-el="e1">Second external</h1></section>
</main>
</body>
</html>`
    };

    await act(async () => {
      await controller.actions.load(DECK);
    });

    act(() => {
      controller.actions.showSlide(1);
      controller.actions.select({
        slideIndex: 1,
        path: [0],
        elementId: 'e1'
      });
      controller.actions.applySlideMutation(0, (slide) => {
        const heading = slide.querySelector('h1');
        if (!heading) throw new Error('Missing heading.');
        heading.textContent = 'Local edit';
      });
    });
    expect(controller.state.dirty).toBe(true);

    act(() => {
      controller.actions.receiveRevision({
        type: 'revision',
        revision: external.revision,
        source: 'external'
      });
    });
    expect(controller.state.conflict).toEqual({
      revision: external.revision,
      source: 'external'
    });
    expect(controller.state.status).toBe('conflict');

    // Further edits stay in conflict; they must not look like a save attempt.
    await act(async () => {
      await controller.actions.commitMaster((master) => {
        const heading = master.querySelector('h1');
        if (!heading) throw new Error('Missing heading.');
        heading.textContent = 'Local while conflicted';
      });
    });
    expect(controller.state.status).toBe('conflict');
    expect(controller.state.conflict).not.toBeNull();

    await act(async () => {
      await controller.actions.reload(external);
    });

    expect(controller.state.conflict).toBeNull();
    expect(controller.state.dirty).toBe(false);
    expect(controller.state.status).toBe('ready');
    expect(controller.state.activeIndex).toBe(2);
    expect(controller.state.selection).toEqual({
      slideIndex: 2,
      path: [0],
      elementId: 'e1'
    });
    expect(controller.state.srcDoc).toContain('Second external');
  });

  it('bumps documentEpoch when a load replaces the document', async () => {
    await act(async () => {
      await controller.actions.load(DECK);
    });
    const firstEpoch = controller.state.documentEpoch;

    await act(async () => {
      await controller.actions.load({
        ...DECK,
        revision: 'revision-2',
        filePath: 'other.html'
      });
    });

    expect(controller.state.documentEpoch).toBe(firstEpoch + 1);
    expect(controller.state.filePath).toBe('other.html');
  });

  it('refuses to overwrite a conflict raised by a deck switch', async () => {
    await act(async () => {
      await controller.actions.load(DECK);
    });
    act(() => {
      controller.actions.applySlideMutation(0, (slide) => {
        const heading = slide.querySelector('h1');
        if (!heading) throw new Error('Missing heading.');
        heading.textContent = 'Local edit';
      });
      controller.actions.receiveRevision({
        type: 'revision',
        revision: 'revision-other',
        source: 'external',
        filePath: 'other.html'
      });
    });
    expect(controller.state.conflict).toEqual({
      revision: 'revision-other',
      source: 'external',
      filePath: 'other.html'
    });
    expect(controller.state.status).toBe('conflict');

    await act(async () => {
      await controller.actions.overwrite();
    });

    expect(saveCalls).toEqual([]);
    expect(controller.state.conflict).not.toBeNull();
    expect(controller.state.dirty).toBe(true);
    expect(controller.state.error).toBe(
      '主機已切換到另一個檔案；只能重新載入。'
    );
  });

  it('keeps a switched-file conflict after a later conflict without a path', async () => {
    await act(async () => {
      await controller.actions.load(DECK);
    });
    act(() => {
      controller.actions.applySlideMutation(0, (slide) => {
        const heading = slide.querySelector('h1');
        if (!heading) throw new Error('Missing heading.');
        heading.textContent = 'Local edit';
      });
      controller.actions.receiveRevision({
        type: 'revision',
        revision: 'revision-other',
        source: 'external',
        filePath: 'other.html'
      });
    });
    expect(controller.state.conflict).toEqual({
      revision: 'revision-other',
      source: 'external',
      filePath: 'other.html'
    });

    // The new deck's next save or external sync is an ordinary revision for
    // that file, so the event carries no path. The switched marker must
    // survive until the tab reloads.
    act(() => {
      controller.actions.receiveRevision({
        type: 'revision',
        revision: 'revision-other-2',
        source: 'external'
      });
    });

    expect(controller.state.conflict).toEqual({
      revision: 'revision-other-2',
      source: 'external',
      filePath: 'other.html'
    });
    expect(controller.state.status).toBe('conflict');

    await act(async () => {
      await controller.actions.overwrite();
    });

    expect(saveCalls).toEqual([]);
    expect(controller.state.conflict).toEqual({
      revision: 'revision-other-2',
      source: 'external',
      filePath: 'other.html'
    });
    expect(controller.state.error).toBe(
      '主機已切換到另一個檔案；只能重新載入。'
    );
  });

  it('refuses to overwrite a switched conflict when the loaded path is unknown', async () => {
    // The tab does not know which file it loaded, so it cannot prove the
    // conflict belongs to the same deck. Treating it as switched is the only
    // safe choice; a force write could replace the deck the host just opened.
    await act(async () => {
      await controller.actions.load({ ...DECK, filePath: '' });
    });
    act(() => {
      controller.actions.applySlideMutation(0, (slide) => {
        const heading = slide.querySelector('h1');
        if (!heading) throw new Error('Missing heading.');
        heading.textContent = 'Local edit';
      });
      controller.actions.receiveRevision({
        type: 'revision',
        revision: 'revision-other',
        source: 'external',
        filePath: 'other.html'
      });
    });
    expect(controller.state.filePath).toBe('');
    expect(controller.state.conflict).toEqual({
      revision: 'revision-other',
      source: 'external',
      filePath: 'other.html'
    });

    await act(async () => {
      await controller.actions.overwrite();
    });

    expect(saveCalls).toEqual([]);
    expect(controller.state.conflict).toEqual({
      revision: 'revision-other',
      source: 'external',
      filePath: 'other.html'
    });
    expect(controller.state.status).toBe('conflict');
    expect(controller.state.dirty).toBe(true);
    expect(controller.state.error).toBe(
      '主機已切換到另一個檔案；只能重新載入。'
    );
  });
});
