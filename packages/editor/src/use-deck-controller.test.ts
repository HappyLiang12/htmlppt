import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { DeckResponse } from './api.js';
import { parseDeck } from './slide-doc.js';
import {
  hasEditorArtifacts,
  useDeckController,
  type DeckController
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

let container: HTMLDivElement;
let root: Root;
let controller!: DeckController;

function Probe() {
  controller = useDeckController({ token: '' });
  return null;
}

beforeEach(async () => {
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

    act(() => {
      controller.actions.clearSelection();
      controller.actions.setScale(0.5);
    });
    expect(controller.state.selection).toBeNull();
    expect(controller.state.scale).toBe(0.5);
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
});
