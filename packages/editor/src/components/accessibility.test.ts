import { detectSlides } from '@htmlppt/core';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { parseDeck } from '../slide-doc.js';
import { SorterView } from './SorterView.js';
import { ThumbnailRail } from './ThumbnailRail.js';

const DECK_HTML = `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><title>Fixture deck</title></head>
<body>
<main data-ppt-deck>
<section class="slide" data-slide-id="s1" data-width="1600" data-height="900">
  <h1 data-ppt-el="e1">First slide</h1>
</section>
<section class="slide" data-slide-id="s2" data-width="1600" data-height="900">
  <h1 data-ppt-el="e2">Second slide</h1>
</section>
</main>
</body>
</html>`;

const INTERACTIVE_CONTENT = 'button, a, [role="button"]';

function fixture(activeIndex = 1) {
  const master = parseDeck(DECK_HTML);
  return { master, slides: detectSlides(master), activeIndex };
}

function parse(markup: string): Document {
  return new DOMParser().parseFromString(markup, 'text/html');
}

describe('thumbnail rail accessibility', () => {
  it('keeps every preview iframe outside the tile control', () => {
    const doc = parse(
      renderToStaticMarkup(
        createElement(ThumbnailRail, {
          ...fixture(),
          onSelect: () => undefined
        })
      )
    );
    const tiles = Array.from(
      doc.querySelectorAll('[data-testid="thumbnail"]')
    );
    expect(tiles).toHaveLength(2);

    for (const tile of tiles) {
      const iframe = tile.querySelector('iframe');
      expect(iframe).not.toBeNull();
      expect(iframe?.closest(INTERACTIVE_CONTENT)).toBeNull();
    }
  });

  it('gives every tile a named control and marks the active one', () => {
    const doc = parse(
      renderToStaticMarkup(
        createElement(ThumbnailRail, {
          ...fixture(),
          onSelect: () => undefined
        })
      )
    );
    const tiles = Array.from(
      doc.querySelectorAll('[data-testid="thumbnail"]')
    );

    for (const tile of tiles) {
      const control = tile.querySelector('button');
      expect(control).not.toBeNull();
      expect(control?.getAttribute('type')).toBe('button');
      expect(control?.getAttribute('aria-label')).toMatch(/^第 \d+ 頁：/);
    }

    expect(tiles[1]?.getAttribute('aria-current')).toBe('page');
    expect(tiles[0]?.getAttribute('aria-current')).toBeNull();
  });
});

describe('sorter accessibility', () => {
  it('exposes tiles as named options without nested controls', () => {
    const doc = parse(
      renderToStaticMarkup(
        createElement(SorterView, {
          ...fixture(),
          onSelect: () => undefined,
          onReorder: () => undefined,
          onDuplicate: () => undefined,
          onDelete: () => undefined,
          canDelete: true
        })
      )
    );

    expect(doc.querySelector('[role="listbox"]')).not.toBeNull();
    const tiles = Array.from(
      doc.querySelectorAll('[data-testid="sorter-slide"]')
    );
    expect(tiles).toHaveLength(2);

    for (const tile of tiles) {
      expect(tile.getAttribute('role')).toBe('option');
      expect(tile.getAttribute('aria-label')).toMatch(/^第 \d+ 頁：/);
      expect(tile.querySelector(INTERACTIVE_CONTENT)).toBeNull();
      expect(tile.querySelector('iframe')?.closest(INTERACTIVE_CONTENT)).toBeNull();
    }

    expect(tiles[0]?.getAttribute('aria-selected')).toBe('false');
    expect(tiles[1]?.getAttribute('aria-selected')).toBe('true');
    expect(tiles[1]?.getAttribute('aria-current')).toBe('page');
  });

  it('keeps duplicate and delete actions outside the option', () => {
    const doc = parse(
      renderToStaticMarkup(
        createElement(SorterView, {
          ...fixture(),
          onSelect: () => undefined,
          onReorder: () => undefined,
          onDuplicate: () => undefined,
          onDelete: () => undefined,
          canDelete: true
        })
      )
    );

    const duplicate = doc.querySelectorAll('[data-testid="sorter-duplicate"]');
    const remove = doc.querySelectorAll('[data-testid="sorter-delete"]');
    expect(duplicate).toHaveLength(2);
    expect(remove).toHaveLength(2);

    for (const button of Array.from(duplicate)) {
      expect(button.closest('[role="option"]')).toBeNull();
      expect(button.getAttribute('aria-label')).toMatch(/^複製第 \d+ 頁$/);
    }
    for (const button of Array.from(remove)) {
      expect(button.closest('[role="option"]')).toBeNull();
      expect(button.getAttribute('aria-label')).toMatch(/^刪除第 \d+ 頁$/);
    }
  });
});
