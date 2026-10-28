# Component dragging implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make every visible slide component — text boxes, cards, chips, tabs, steps, icons, chart figures, SVG shapes and arrows, tables — selectable and draggable at its own level, with a visible hover target and a hotkey-free way into SVG internals.

**Architecture:** A pure `component-target.ts` resolver turns a pointer target into the innermost visible component (deepest non-inline box, stopping at atomic widgets and guarded subtrees). The editor uses it for slide-level clicks, hover, and double-click entry; entered contexts keep the existing direct-child drill-in rules. A second geometry mode writes SVG `transform` translations for shapes inside an `<svg>`; HTML targets keep the existing pin-to-absolute gesture. Nested and SVG selections gain delete/duplicate/copy-paste through node-based clipboard operations.

**Tech Stack:** TypeScript, React 19, Vitest + jsdom, Playwright, npm workspaces, tsup/Vite.

**Spec:** `docs/superpowers/specs/2026-10-28-component-dragging-design.md`

## Global Constraints

- Never commit or push on `main`; work on `feat/component-dragging` and open a PR. The user performs merges.
- Every phase starts with a RED test and ends with full `npm run verify` on the final HEAD. Build and verify never run concurrently. Hosted CI on the newest pushed SHA is authoritative; a red matrix is not merged.
- Never skip, delete, or loosen a test to reach green. Expectations that encoded the superseded slide-level click rule are rewritten to the new contract, not removed.
- No deck-format change: no new persisted attributes, no selection state in the file, no `data-width`/`data-height` rewrite. Only inline `style` and SVG `transform` attributes may be written by edits.
- No MCP target, validation, normalization, outline, play, presenter, or export contract change.
- UI copy lives in the typed locale catalog (`en`, `zh-Hant`, `zh-Hans`). Files, comments, and docs stay in English; replies to the user are Traditional Chinese with English technical terms.
- The per-process token and cookie auth boundary must not change.
- Screenshot-visible behavior can only be claimed after real E2E or manual QA; report only verification that actually ran, with the command and commit.

---

## Phase 1 — Component selection and hover

### Task 1: Component resolver and SVG object filtering

**Files:**
- Create: `packages/editor/src/component-target.ts`
- Create: `packages/editor/src/component-target.test.ts`
- Modify: `packages/editor/src/selection.ts`
- Modify: `packages/editor/src/selection.test.ts`

**Interfaces:**
- Produces:
  - `interface ComputedComponentStyle { display: string; position: string }`
  - `type ComponentStyleReader = (element: Element) => ComputedComponentStyle`
  - `function resolveComponent(slide: Element, target: Element, options?: { getStyle?: ComponentStyleReader }): Element | null`
  - `function componentPath(slide: Element, element: Element): number[] | null`
  - `function componentLabel(element: Element): string`
  - `function isSvgInternal(element: Element): boolean`
  - `function isTableInternal(element: Element): boolean`
  - `function normalizeSelectionPaths(paths: readonly (readonly number[])[]): number[][]`
- Consumes: `elementAtPath`, `isGuardedElement` (newly exported), `isObjectElement` (newly exported) from `selection.ts`.

- [ ] **Step 1: Write the failing unit tests**

Create `packages/editor/src/component-target.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import {
  componentLabel,
  componentPath,
  isSvgInternal,
  isTableInternal,
  normalizeSelectionPaths,
  resolveComponent,
  type ComponentStyleReader
} from './component-target.js';

const SVG_NS = 'http://www.w3.org/2000/svg';

function styleOf(
  map: Record<string, { display?: string; position?: string }>
): ComponentStyleReader {
  return (element) => {
    const key =
      element.id ||
      element.tagName.toLowerCase();
    return {
      display: map[key]?.display ?? 'block',
      position: map[key]?.position ?? 'static'
    };
  };
}

function slideOf(html: string): Element {
  const slide = document.createElement('section');
  slide.innerHTML = html;
  return slide;
}

describe('resolveComponent', () => {
  it('folds an inline span into its block text box', () => {
    const slide = slideOf('<p id="lead">Hello <span id="word">world</span></p>');
    const target = slide.querySelector('#word')!;
    expect(resolveComponent(slide, target, { getStyle: styleOf({ word: { display: 'inline' } }) })).toBe(
      slide.querySelector('#lead')
    );
  });

  it('returns the block target itself', () => {
    const slide = slideOf('<h1 id="head">Title</h1>');
    expect(resolveComponent(slide, slide.querySelector('#head')!, { getStyle: styleOf({}) })).toBe(
      slide.querySelector('#head')
    );
  });

  it('skips display:contents wrappers', () => {
    const slide = slideOf(
      '<div id="contents"><p id="body">Body</p></div>'
    );
    expect(
      resolveComponent(slide, slide.querySelector('#body')!, {
        getStyle: styleOf({ contents: { display: 'contents' } })
      })
    ).toBe(slide.querySelector('#body'));
  });

  it('treats a positioned inline element as its own component', () => {
    const slide = slideOf('<p id="lead">a <span id="dot">b</span></p>');
    expect(
      resolveComponent(slide, slide.querySelector('#dot')!, {
        getStyle: styleOf({ dot: { display: 'inline', position: 'absolute' } })
      })
    ).toBe(slide.querySelector('#dot'));
  });

  it('stops at an atomic svg even when a path is the target', () => {
    const slide = slideOf('<svg id="chart"><path id="bar" d="M0 0h10"/></svg>');
    expect(
      resolveComponent(slide, slide.querySelector('#bar')!, {
        getStyle: styleOf({ bar: { display: 'inline' } })
      })
    ).toBe(slide.querySelector('#chart'));
  });

  it('stops at an atomic chart figure', () => {
    const slide = slideOf(
      '<figure id="chart" data-ppt-chart="{}"><svg id="plot"><rect id="bar"/></svg></figure>'
    );
    expect(
      resolveComponent(slide, slide.querySelector('#bar')!, {
        getStyle: styleOf({ bar: { display: 'inline' } })
      })
    ).toBe(slide.querySelector('#chart'));
  });

  it('stops at img, canvas, video and iframe', () => {
    const tags = ['img', 'canvas', 'video', 'iframe'];
    for (const tag of tags) {
      const slide = slideOf(`<div id="wrap"><${tag} id="atom"></${tag}></div>`);
      expect(
        resolveComponent(slide, slide.querySelector('#atom')!, {
          getStyle: styleOf({ atom: { display: 'inline' } })
        })
      ).toBe(slide.querySelector('#atom'));
    }
  });

  it('returns a guarded wrapper instead of a block descendant', () => {
    const slide = slideOf(
      '<div id="group" data-ppt-group="true"><div id="inner"><p id="body">x</p></div></div>'
    );
    expect(
      resolveComponent(slide, slide.querySelector('#body')!, { getStyle: styleOf({}) })
    ).toBe(slide.querySelector('#group'));
  });

  it('returns null for the slide root and foreign targets', () => {
    const slide = slideOf('<p id="body">x</p>');
    expect(resolveComponent(slide, slide, { getStyle: styleOf({}) })).toBeNull();
    const other = document.createElement('p');
    expect(resolveComponent(slide, other, { getStyle: styleOf({}) })).toBeNull();
  });

  it('excludes descendants of a notes aside', () => {
    const slide = slideOf('<aside data-ppt-notes="1"><p id="note">n</p></aside>');
    expect(
      resolveComponent(slide, slide.querySelector('#note')!, { getStyle: styleOf({}) })
    ).toBeNull();
  });
});

describe('componentPath', () => {
  it('returns the raw child-index path from the slide', () => {
    const slide = slideOf('<div id="pad"><h1 id="head">T</h1></div>');
    expect(componentPath(slide, slide.querySelector('#head')!)).toEqual([0, 0]);
  });
});

describe('componentLabel', () => {
  it('uses the lowercase tag and the first class', () => {
    const slide = slideOf('<h1 id="head" class="cover-title  big">T</h1>');
    expect(componentLabel(slide.querySelector('#head')!)).toBe('h1.cover-title');
    expect(componentLabel(slide.querySelector('#head')!.cloneNode() as Element)).toBe(
      'h1.cover-title'
    );
  });

  it('falls back to the tag alone', () => {
    const slide = slideOf('<svg id="arrow"></svg>');
    expect(componentLabel(slide.querySelector('#arrow')!)).toBe('svg');
  });
});

describe('isSvgInternal and isTableInternal', () => {
  it('separates the svg root from its shapes', () => {
    const svg = document.createElementNS(SVG_NS, 'svg');
    const group = document.createElementNS(SVG_NS, 'g');
    svg.appendChild(group);
    expect(isSvgInternal(svg)).toBe(false);
    expect(isSvgInternal(group)).toBe(true);
    const html = document.createElement('div');
    expect(isSvgInternal(html)).toBe(false);
  });

  it('separates a table from its cells', () => {
    const slide = slideOf('<table id="table"><tbody><tr><td id="cell">x</td></tr></tbody></table>');
    expect(isTableInternal(slide.querySelector('#table')!)).toBe(false);
    expect(isTableInternal(slide.querySelector('#cell')!)).toBe(true);
  });
});

describe('normalizeSelectionPaths', () => {
  it('drops a descendant when its ancestor is selected', () => {
    expect(normalizeSelectionPaths([[0], [0, 1], [2]])).toEqual([[0], [2]]);
  });

  it('replaces descendants when an ancestor is added later', () => {
    expect(normalizeSelectionPaths([[0, 1], [0]])).toEqual([[0]]);
  });

  it('keeps unrelated paths and drops duplicates', () => {
    expect(normalizeSelectionPaths([[0, 1], [0, 2], [0, 1]])).toEqual([
      [0, 1],
      [0, 2]
    ]);
  });
});
```

Add to `packages/editor/src/selection.test.ts`:

```ts
import { topLevelObjects } from './selection.js';

it('excludes non-rendered SVG elements from objects', () => {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  const defs = document.createElementNS('http://www.w3.org/2000/svg', 'defs');
  const title = document.createElementNS('http://www.w3.org/2000/svg', 'title');
  const group = document.createElementNS('http://www.w3.org/2000/svg', 'g');
  svg.append(defs, title, group);
  expect(topLevelObjects(svg)).toEqual([group]);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm run test -w @htmlppt/editor -- src/component-target.test.ts src/selection.test.ts`

Expected: FAIL — `component-target.js` does not exist and `topLevelObjects(svg)` lists `defs`/`title`.

- [ ] **Step 3: Export the path and guard helpers from selection.ts**

In `packages/editor/src/selection.ts`:

```ts
export const SVG_NAMESPACE = 'http://www.w3.org/2000/svg';

const SVG_NON_OBJECT_TAGS = new Set([
  'DEFS',
  'TITLE',
  'DESC',
  'METADATA',
  'SYMBOL',
  'CLIPPATH',
  'MASK',
  'PATTERN',
  'MARKER',
  'LINEARGRADIENT',
  'RADIALGRADIENT',
  'FILTER',
  'TSPAN',
  'TEXTPATH'
]);

export function isObjectElement(element: Element): boolean {
  if (NON_OBJECT_TAGS.has(element.tagName.toUpperCase())) return false;
  if (element.closest('[data-ppt-notes]')) return false;
  if (
    element.namespaceURI === SVG_NAMESPACE &&
    SVG_NON_OBJECT_TAGS.has(element.tagName.toUpperCase())
  ) {
    return false;
  }
  return true;
}

export function isGuardedElement(element: Element): boolean {
  return (
    element.hasAttribute('data-ppt-group') ||
    element.getAttribute('data-ppt-locked') === 'true' ||
    (element as HTMLElement).style?.display === 'none'
  );
}

export function pathTo(element: Element, root: Element): number[] | null {
  // existing body, now exported
}
```

- [ ] **Step 4: Implement component-target.ts**

```ts
import {
  isGuardedElement,
  isObjectElement,
  pathTo,
  SVG_NAMESPACE
} from './selection.js';

export interface ComputedComponentStyle {
  display: string;
  position: string;
}

export type ComponentStyleReader = (element: Element) => ComputedComponentStyle;

export interface ResolveComponentOptions {
  getStyle?: ComponentStyleReader;
}

const ATOMIC_TAGS = new Set(['SVG', 'IMG', 'CANVAS', 'VIDEO', 'IFRAME']);

function isChartFigure(element: Element): boolean {
  return (
    element.tagName.toUpperCase() === 'FIGURE' &&
    element.hasAttribute('data-ppt-chart')
  );
}

export function readComputedStyle(element: Element): ComputedComponentStyle {
  const view = element.ownerDocument.defaultView;
  const style = view?.getComputedStyle(element);
  return {
    display: style?.display ?? 'block',
    position: style?.position ?? 'static'
  };
}

/** True for a shape inside an svg, false for the svg root and HTML content. */
export function isSvgInternal(element: Element): boolean {
  if (element.namespaceURI !== SVG_NAMESPACE) return false;
  return element.closest('svg') !== element;
}

/** True for a cell or row inside a table, false for the table itself. */
export function isTableInternal(element: Element): boolean {
  const table = element.closest('table');
  return table !== null && table !== element;
}

function guardedAncestor(slide: Element, target: Element): Element | null {
  for (
    let current: Element | null = target;
    current && current !== slide;
    current = current.parentElement
  ) {
    if (isGuardedElement(current)) return current;
  }
  return null;
}

export function resolveComponent(
  slide: Element,
  target: Element,
  options: ResolveComponentOptions = {}
): Element | null {
  if (target === slide || !slide.contains(target)) return null;
  if (!isObjectElement(target)) return null;
  const guard = guardedAncestor(slide, target);
  if (guard) return guard;
  const getStyle = options.getStyle ?? readComputedStyle;
  for (
    let current: Element | null = target;
    current && current !== slide;
    current = current.parentElement
  ) {
    const tag = current.tagName.toUpperCase();
    if (ATOMIC_TAGS.has(tag) || isChartFigure(current)) return current;
    const style = getStyle(current);
    if (style.display !== 'inline' && style.display !== 'contents') {
      return current;
    }
    if (style.position === 'absolute' || style.position === 'fixed') {
      return current;
    }
  }
  return null;
}

export function componentPath(
  slide: Element,
  element: Element
): number[] | null {
  return pathTo(element, slide);
}

export function componentLabel(element: Element): string {
  const tag = element.tagName.toLowerCase();
  const first = element.getAttribute('class')?.trim().split(/\s+/)[0];
  return first ? `${tag}.${first}` : tag;
}

function isPrefix(
  prefix: readonly number[],
  path: readonly number[]
): boolean {
  return (
    prefix.length < path.length &&
    prefix.every((value, index) => value === path[index])
  );
}

export function normalizeSelectionPaths(
  paths: readonly (readonly number[])[]
): number[][] {
  const kept: number[][] = [];
  for (const path of paths) {
    const key = path.join('.');
    if (kept.some((candidate) => candidate.join('.') === key)) continue;
    for (let index = kept.length - 1; index >= 0; index -= 1) {
      const candidate = kept[index];
      if (candidate && isPrefix(path, candidate)) kept.splice(index, 1);
    }
    if (kept.some((candidate) => isPrefix(candidate, path))) continue;
    kept.push([...path]);
  }
  return kept;
}
```

The final duplicate guard is awkward; simplify to:

```ts
if (kept.some((candidate) => candidate.join('.') === path.join('.'))) continue;
kept.push([...path]);
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npm run test -w @htmlppt/editor -- src/component-target.test.ts src/selection.test.ts`

Expected: PASS. Then run the whole editor unit suite: `npm run test -w @htmlppt/editor`. Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/editor/src/component-target.ts packages/editor/src/component-target.test.ts packages/editor/src/selection.ts packages/editor/src/selection.test.ts
git commit -m "feat(editor): resolve the innermost component under the pointer"
```

---

### Task 2: Component-first click, double-click, and Enter

**Files:**
- Modify: `packages/editor/src/App.tsx`
- Modify: `packages/editor/src/use-deck-controller.ts`
- Create: `test-utils/fixtures/component.deck.html`
- Create: `e2e/component-dragging.spec.ts`

**Interfaces:**
- Consumes: `resolveComponent`, `componentPath`, `normalizeSelectionPaths` from Task 1.
- Produces: selection behavior used by every later task; `data-testid="selection-outline"` paths now address the innermost component at slide level.

- [ ] **Step 1: Create the fixture**

Create `test-utils/fixtures/component.deck.html` with one declared 1600x900 slide:

```html
<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>Component deck</title>
<style>
  html, body { margin: 0; padding: 0; background: #fff; }
  .slide { display: none; width: 1600px; height: 900px; background: #f7f5ef; color: #17181c; font: 20px/1.4 sans-serif; }
  .slide.active { display: block; }
  .pad { position: absolute; left: 0; top: 0; width: 1600px; height: 900px; padding: 60px; box-sizing: border-box; }
  .headline { position: absolute; left: 80px; top: 80px; margin: 0; font-size: 64px; }
  .lead { position: absolute; left: 80px; top: 180px; margin: 0; width: 700px; }
  .chips { position: absolute; left: 80px; top: 260px; display: flex; gap: 12px; }
  .chip { border: 1px solid #333; border-radius: 999px; padding: 8px 16px; }
  .card { position: absolute; left: 80px; top: 340px; width: 400px; padding: 24px; border: 1px solid #333; }
  .card .icon { width: 48px; height: 48px; display: grid; place-items: center; }
  .flow { position: absolute; left: 520px; top: 340px; display: flex; gap: 16px; }
  .step { width: 140px; padding: 12px; border: 1px solid #333; }
  .chart-card { position: absolute; left: 520px; top: 80px; width: 500px; margin: 0; }
  .chart-card svg { display: block; width: 100%; height: 220px; }
  .arrow { position: absolute; right: 60px; top: 520px; width: 240px; }
  .table-wrap { position: absolute; left: 80px; top: 620px; }
  table { border-collapse: collapse; width: 500px; }
  td, th { border: 1px solid #333; padding: 8px; }
  .group { position: absolute; left: 1100px; top: 620px; padding: 12px; border: 1px solid #333; }
  .locked { position: absolute; left: 1300px; top: 620px; padding: 12px; border: 1px solid #333; }
  .decor { position: absolute; left: 1100px; top: 80px; width: 160px; height: 160px; border-radius: 50%; background: #ddd; }
  .contents { display: contents; }
</style></head>
<body>
<main data-ppt-deck>
  <section class="slide active" data-slide-id="s1" data-width="1600" data-height="900">
    <div class="pad" id="pad">
      <h1 class="headline" id="headline" data-ppt-el="headline">Component motion <span id="inline-word">now</span></h1>
      <p class="lead" id="lead">Drag any component.</p>
      <div class="chips" id="chips">
        <span class="chip" id="chip-one" data-ppt-el="chip-one">One</span>
        <span class="chip" id="chip-two">Two</span>
      </div>
      <article class="card" id="card" data-ppt-el="card">
        <div class="icon" id="icon" data-ppt-el="icon"><svg id="icon-svg" data-ppt-el="icon-svg" width="24" height="24" viewBox="0 0 24 24"><path id="icon-path" d="M4 4h16v16H4z"/></svg></div>
        <h3 id="card-title" data-ppt-el="card-title">Card title</h3>
        <p id="card-body">Card body</p>
      </article>
      <figure class="chart-card" id="chart" data-ppt-el="chart" data-ppt-chart='{"type":"bar","title":"Chart","labels":["Q1","Q2"],"series":[{"name":"S","values":[10,20]}],"colors":["#4f7cff"],"legend":false,"valueLabels":true}'>
        <figcaption id="chart-caption">Chart</figcaption>
        <svg id="chart-svg" viewBox="0 0 200 100"><g id="bars"><rect id="bar" x="10" y="40" width="20" height="50"/></g><circle id="dot" cx="150" cy="40" r="6"/></svg>
      </figure>
      <div class="flow" id="flow">
        <div class="step" id="step-one">Step one</div>
        <div class="step" id="step-two" data-ppt-el="step-two">Step two</div>
      </div>
      <div class="table-wrap"><table id="table"><tbody><tr><td id="cell-a">A1</td><td id="cell-b">B1</td></tr></tbody></table></div>
      <div class="group" id="group" data-ppt-el="group" data-ppt-group="true"><p id="group-child">Group child</p></div>
      <div class="locked" id="locked" data-ppt-el="locked" data-ppt-locked="true"><p id="locked-child">Locked child</p></div>
      <div class="contents"><p id="contents-child" data-ppt-el="contents-child">Contents child</p></div>
      <div class="decor" id="decor"></div>
    </div>
    <svg class="arrow" id="arrow" viewBox="0 0 100 50" data-ppt-el="arrow"><path id="arrow-path" d="M0 25h80"/></svg>
    <aside data-ppt-notes="notes"></aside>
  </section>
</main>
</body></html>
```

- [ ] **Step 2: Write the failing E2E**

Create `e2e/component-dragging.spec.ts` modeled on `editor-canvas-fit.spec.ts` (`openDeck` copies the fixture into a temp dir, starts `startCliHost(cliPath, directory, 'component.deck.html')`, and waits for `save-status` = `已同步`). Add these tests:

```ts
test('selects and drags the heading, not the wrapper', { tag: '@feature:component-dragging' }, async ({ page }) => {
  const deck = await openDeck(page);
  try {
    const heading = deck.frame.locator('#headline');
    const padBoxBefore = await deck.frame.locator('#pad').boundingBox();
    await heading.click();
    const outline = page.getByTestId('selection-outline');
    await expect(outline).toHaveAttribute('data-selected-id', 'headline');
    const headingBox = await heading.boundingBox();
    const outlineBox = await boxOfLocator(outline);
    expect(deviation(outlineBox, headingBox!)).toBeLessThanOrEqual(1);

    const before = headingBox!;
    await page.mouse.move(before.x + before.width / 2, before.y + before.height / 2);
    await page.mouse.down();
    await page.mouse.move(before.x + before.width / 2 + 60, before.y + before.height / 2 + 30, { steps: 6 });
    await page.mouse.up();

    const after = await heading.boundingBox();
    expect(Math.abs(after!.x - before.x - 60)).toBeLessThanOrEqual(2);
    expect(Math.abs(after!.y - before.y - 30)).toBeLessThanOrEqual(2);
    expect(deviation(await deck.frame.locator('#pad').boundingBox() ?? before, padBoxBefore!)).toBeLessThanOrEqual(1);
    await expect(page.getByTestId('save-status')).toHaveText('已同步');
    const html = await readFile(deck.path, 'utf8');
    expect(html).toContain('id="headline"');
    expect(html).toMatch(/<h1[^>]*style="[^"]*position:\s*absolute/);
    expect(html).not.toMatch(/id="pad"[^>]*style="[^"]*(left|top):/);
    expect(html).not.toContain('data-ppt-hover');
    expect(html).not.toContain('data-ppt-preview-slide');
  } finally {
    await deck.close();
  }
});
```

Add sibling tests in the same file:

```ts
test('selects chips, steps, icons, cards, chart figures and the outer arrow', { tag: '@feature:component-dragging' }, async ({ page }) => {
  const deck = await openDeck(page);
  try {
    const outline = page.getByTestId('selection-outline');
    const cases: Array<[string, string, string, { x: number; y: number }?]> = [
      ['#chip-one', 'chip-one', '#chip-one'],
      ['#step-two', 'step-two', '#step-two'],
      ['#icon-svg', 'icon-svg', '#icon-svg'],
      ['#icon', 'icon', '#icon', { x: 4, y: 4 }],
      ['#card-title', 'card-title', '#card-title'],
      ['#card', 'card', '#card', { x: 4, y: 4 }],
      ['#chart-svg', 'chart', '#chart'],
      ['#arrow-path', 'arrow', '#arrow'],
      ['#dot', 'chart', '#chart']
    ];
    for (const [selector, id, expectedSelector, position] of cases) {
      await deck.frame.locator(selector).click(position ? { position } : undefined);
      await expect(outline).toHaveAttribute('data-selected-id', id);
      const expected = await deck.frame.locator(expectedSelector).boundingBox();
      expect(deviation(await boxOfLocator(outline), expected!)).toBeLessThanOrEqual(1);
    }
  } finally {
    await deck.close();
  }
});

test('folds inline spans into the text box and skips display:contents wrappers', { tag: '@feature:component-dragging' }, async ({ page }) => {
  const deck = await openDeck(page);
  try {
    const outline = page.getByTestId('selection-outline');
    await deck.frame.locator('#inline-word').click();
    await expect(outline).toHaveAttribute('data-selected-id', 'headline');
    await deck.frame.locator('#contents-child').click();
    await expect(outline).toHaveAttribute('data-selected-id', 'contents-child');
  } finally {
    await deck.close();
  }
});

test('guarded subtrees resolve to their wrapper', { tag: '@feature:component-dragging' }, async ({ page }) => {
  const deck = await openDeck(page);
  try {
    const outline = page.getByTestId('selection-outline');
    await deck.frame.locator('#group-child').click();
    await expect(outline).toHaveAttribute('data-selected-id', 'group');
    await deck.frame.locator('#locked-child').click();
    await expect(outline).toHaveAttribute('data-selected-id', 'locked');
    await expect(page.locator('[data-testid^="handle-"]')).toHaveCount(0);
  } finally {
    await deck.close();
  }
});

test('double-click enters a card and Enter enters a deep selected card', { tag: '@feature:component-dragging' }, async ({ page }) => {
  const deck = await openDeck(page);
  try {
    await deck.frame.locator('#card').dblclick({ position: { x: 4, y: 4 } });
    await expect(page.getByTestId('edit-context')).toContainText('card');
    const rows = page.getByTestId('object-row');
    await expect(rows.filter({ hasText: 'icon' })).toBeVisible();
    await expect(rows.filter({ hasText: 'h3' })).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.getByTestId('edit-context')).toHaveCount(0);

    await deck.frame.locator('#card').click({ position: { x: 4, y: 4 } });
    await page.keyboard.press('Enter');
    await expect(page.getByTestId('edit-context')).toContainText('card');
  } finally {
    await deck.close();
  }
});

test('shift-click builds a multi-selection across depths', { tag: '@feature:component-dragging' }, async ({ page }) => {
  const deck = await openDeck(page);
  try {
    await deck.frame.locator('#headline').click();
    await deck.frame.locator('#chip-one').click({ modifiers: ['Shift'] });
    await expect(page.getByTestId('selection-outline')).toHaveCount(2);
    const headline = await deck.frame.locator('#headline').boundingBox();
    const chip = await deck.frame.locator('#chip-one').boundingBox();
    await page.mouse.move(headline!.x + headline!.width / 2, headline!.y + headline!.height / 2);
    await page.mouse.down();
    await page.mouse.move(headline!.x + headline!.width / 2 + 40, headline!.y + headline!.height / 2, { steps: 5 });
    await page.mouse.up();
    const movedChip = await deck.frame.locator('#chip-one').boundingBox();
    expect(Math.abs(movedChip!.x - chip!.x - 40)).toBeLessThanOrEqual(2);
  } finally {
    await deck.close();
  }
});
```

- [ ] **Step 3: Run the E2E to verify it fails**

Run: `npm run build && npx playwright test e2e/component-dragging.spec.ts --project=chromium`

Expected: FAIL — the heading click selects the whole `.pad` (`data-selected-id` is null or `pad`), and the chart click selects the SVG instead of the figure.

- [ ] **Step 4: Implement the click resolver in App.tsx**

Add a helper inside the component:

```ts
const componentSelection = useCallback(
  (target: Element, slide: Element, altKey: boolean): SelectionTarget | null => {
    const current = stateRef.current;
    const containerPath = containerPathRef.current;
    if (containerPath.length > 0) {
      return selectionFromEvent(target, slide, {
        slideIndex: current.activeIndex,
        altKey,
        containerPath
      });
    }
    if (altKey) {
      return selectionFromEvent(target, slide, {
        slideIndex: current.activeIndex,
        altKey: true
      });
    }
    const component = resolveComponent(slide, target);
    const path = component ? componentPath(slide, component) : null;
    if (!component || !path) return null;
    return {
      slideIndex: current.activeIndex,
      path,
      elementId: component.getAttribute('data-ppt-el')?.trim() || null
    };
  },
  []
);
```

Replace the `selectionFromEvent(...)` call in `handleFramePointerDown` with `componentSelection(target, frameSlide, event.altKey)` and add `componentSelection` to the dependency list.

Rename the `clickedTop` check to `clicked` (the selection may be nested) and keep the same predicates:

```ts
const clicked = elementAtPath(frameSlide, selected.path);
if (!clicked || isLockedElement(clicked) || isHiddenElement(clicked) || blockedPathAncestor(frameSlide, selected.path) !== null) {
  if (clicked) event.preventDefault();
  return;
}
```

- [ ] **Step 5: Implement double-click entry through the resolver**

In the `dblclick` handler, replace the `contextEntry` call with:

```ts
const next =
  containerPathRef.current.length > 0
    ? contextEntry(frameSlide, target, containerPathRef.current)
    : (() => {
        const component = resolveComponent(frameSlide, target);
        if (!component || !isEnterableContainer(component)) return null;
        return componentPath(frameSlide, component);
      })();
```

Import `resolveComponent`, `componentPath` from `./component-target.js`. The existing hint path stays.

- [ ] **Step 6: Relax Enter and allow multi-depth selection**

In `handleContextKeyDown`, delete the direct-child guard:

```ts
// remove this block
if (
  selected.path.length !== path.length + 1 ||
  !path.every((index, depth) => selected.path[depth] === index)
) {
  return;
}
```

In `use-deck-controller.ts`, import `normalizeSelectionPaths` and normalize inside `applySelections` after dedupe:

```ts
const uniquePaths = normalizeSelectionPaths(unique.map((target) => target.path));
const normalized = uniquePaths
  .map((path) => unique.find((target) => target.path.join('.') === path.join('.')))
  .filter((target): target is SelectionTarget => target !== undefined);
update({ selection: normalized[0] ?? null, selections: normalized });
```

In `toggleSelect`, remove the top-level restriction:

```ts
if (!sameSlide) {
  applySelections([target]);
  return;
}
const existing = base.some((candidate) => sameTarget(candidate, target));
applySelections(
  existing
    ? base.filter((candidate) => !sameTarget(candidate, target))
    : [...base, target]
);
```

- [ ] **Step 7: Run the new E2E and the affected suites**

Run: `npm run build && npx playwright test e2e/component-dragging.spec.ts e2e/skeleton.spec.ts e2e/editor.spec.ts e2e/drill-in.spec.ts e2e/charts.spec.ts e2e/tables.spec.ts e2e/text-entry.spec.ts --project=chromium`

Expected: the new spec passes. Existing failures are limited to tests that encoded the old slide-level rule. Rewrite those expectations to the new contract:
- a click on a text leaf asserts that leaf's path/box, not the top-level wrapper (e.g. `editor.spec.ts`: "clicking inside the heading selects its top-level object with eight handles" becomes "clicking inside the heading selects the heading with eight handles", path to the heading, id `headline`);
- a double-click on an SVG enters it instead of showing a "not text" hint;
- a plain click on a table cell selects the cell (Alt-click still works and stays covered).

Do not change any other assertion, and do not skip a case. Then run the full editor unit suite: `npm run test -w @htmlppt/editor`.

- [ ] **Step 8: Commit**

```bash
git add packages/editor/src/App.tsx packages/editor/src/use-deck-controller.ts e2e/component-dragging.spec.ts test-utils/fixtures/component.deck.html e2e/editor.spec.ts e2e/skeleton.spec.ts
git commit -m "feat(editor): select the innermost component at slide level"
```

---

### Task 3: Hover preview and move cursor

**Files:**
- Modify: `packages/editor/src/App.tsx`
- Modify: `packages/editor/src/components/CanvasOverlay.tsx`
- Modify: `e2e/component-dragging.spec.ts`

**Interfaces:**
- Consumes: Task 2's `componentSelection`, `resolveComponent`, `componentLabel`.
- Produces: `data-testid="hover-outline"` and `data-testid="hover-label"`; an editor-only `data-ppt-hover` attribute on the frame `<html>`.

- [ ] **Step 1: Write the failing E2E**

Add to `e2e/component-dragging.spec.ts`:

```ts
test('hover previews the component a click will select', { tag: '@feature:component-dragging' }, async ({ page }) => {
  const deck = await openDeck(page);
  try {
    await deck.frame.locator('#headline').hover();
    const outline = page.getByTestId('hover-outline');
    await expect(outline).toBeVisible();
    await expect(page.getByTestId('hover-label')).toHaveText('h1.headline');
    const headingBox = await deck.frame.locator('#headline').boundingBox();
    expect(deviation(await boxOfLocator(outline), headingBox!)).toBeLessThanOrEqual(1);
    expect(await deck.frame.locator('#headline').evaluate((el) => getComputedStyle(el).cursor)).toBe('move');

    await deck.frame.locator('#pad').hover({ position: { x: 12, y: 500 } });
    await expect(outline).toBeVisible();
    await expect(page.getByTestId('hover-label')).toHaveText('div.pad');

    await deck.frame.locator('#cell-a').hover();
    await expect(page.getByTestId('hover-label')).toHaveText('td');
    expect(await deck.frame.locator('#cell-a').evaluate((el) => getComputedStyle(el).cursor)).toBe('default');
  } finally {
    await deck.close();
  }
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npm run build && npx playwright test e2e/component-dragging.spec.ts -g "hover previews" --project=chromium`

Expected: FAIL — no hover outline exists.

- [ ] **Step 3: Add hover state and the pointer listener**

In `App.tsx`:

```ts
const [hoverTarget, setHoverTarget] = useState<{
  path: number[];
  rect: Rect;
  label: string;
  draggable: boolean;
} | null>(null);
const hoverKeyRef = useRef('');
```

In `onFrameLoad`, after the existing listeners, inject the editor-only cursor style and add the hover listener:

```ts
const editorStyle = frameDocument.createElement('style');
editorStyle.setAttribute('data-ppt-editor-style', '');
editorStyle.textContent =
  'html[data-ppt-hover="move"], html[data-ppt-hover="move"] * { cursor: move !important; }' +
  'html[data-ppt-hover="blocked"], html[data-ppt-hover="blocked"] * { cursor: default !important; }';
frameDocument.head.appendChild(editorStyle);

let hoverFrame = 0;
const updateHover = (event: PointerEvent) => {
  const point = { x: event.clientX, y: event.clientY };
  if (hoverFrame) return;
  hoverFrame = window.requestAnimationFrame(() => {
    hoverFrame = 0;
    const current = stateRef.current;
    if (sessionRef.current || editingElementRef.current) {
      setHoverTarget(null);
      frameDocument.documentElement.removeAttribute('data-ppt-hover');
      return;
    }
    const slideInfo = current.slides[current.activeIndex];
    const target = frameDocument.elementFromPoint(point.x, point.y);
    const frameSlide = slideInfo
      ? frameSlideElement(slideInfo, frameDocument)
      : null;
    if (!slideInfo || !frameSlide || !target || !frameSlide.contains(target)) {
      setHoverTarget(null);
      frameDocument.documentElement.removeAttribute('data-ppt-hover');
      return;
    }
    const resolved = componentSelection(target, frameSlide, false);
    const element = resolved ? elementAtPath(frameSlide, resolved.path) : null;
    if (!resolved || !element || (current.selection && sameSelection(current.selection, resolved) && current.selections.length === 1)) {
      hoverKeyRef.current = '';
      setHoverTarget(null);
      frameDocument.documentElement.removeAttribute('data-ppt-hover');
      return;
    }
    const key = resolved.path.join('.');
    if (hoverKeyRef.current === key) return;
    hoverKeyRef.current = key;
    const draggable =
      !isTableInternal(element) &&
      !isLockedElement(element) &&
      blockedPathAncestor(frameSlide, resolved.path) === null;
    setHoverTarget({
      path: resolved.path,
      rect: frameRectOf(rectOf(element, frameSlide), slideOffsetOf(frameSlide)),
      label: componentLabel(element),
      draggable
    });
    frameDocument.documentElement.setAttribute(
      'data-ppt-hover',
      draggable ? 'move' : 'blocked'
    );
  });
};
const clearHover = () => {
  hoverKeyRef.current = '';
  setHoverTarget(null);
  frameDocument.documentElement.removeAttribute('data-ppt-hover');
};
frameDocument.addEventListener('pointermove', updateHover);
frameDocument.addEventListener('pointerleave', clearHover);
```

Clear hover in `beginDragSession`, `beginResizeSession`, `beginRotateSession`, `beginTextEditing`, at the start of `refreshOverlay`, and in the effect that runs on `scale`/`activeIndex` changes so a zoom cannot leave a stale box. Remove the `data-ppt-hover` attribute in the same places.

- [ ] **Step 4: Render the hover box**

Add to `CanvasOverlayProps`:

```ts
hover?: { rect: Rect; label: string } | null;
```

Render before the selection boxes:

```tsx
{hover && (
  <div
    data-testid="hover-outline"
    className="pointer-events-none absolute border border-dashed border-selection/70"
    style={{
      left: hover.rect.x * scale,
      top: hover.rect.y * scale,
      width: hover.rect.width * scale,
      height: hover.rect.height * scale
    }}
  >
    <span
      data-testid="hover-label"
      className="absolute left-0 top-0 -translate-y-full rounded bg-selection px-1 text-[10px] font-semibold text-selection-contrast"
    >
      {hover.label}
    </span>
  </div>
)}
```

Pass `hover={hoverTarget ? { rect: hoverTarget.rect, label: hoverTarget.label } : null}` from `App.tsx`.

- [ ] **Step 5: Run the hover E2E and the full editor unit suite**

Run: `npm run build && npx playwright test e2e/component-dragging.spec.ts --project=chromium`

Expected: PASS. Then `npm run test -w @htmlppt/editor` — PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/editor/src/App.tsx packages/editor/src/components/CanvasOverlay.tsx e2e/component-dragging.spec.ts
git commit -m "feat(editor): preview the draggable component on hover"
```

---

### Task 4: Visible Enter action, SVG objects, and chart selection resilience

**Files:**
- Modify: `packages/editor/src/components/Inspector.tsx`
- Modify: `packages/editor/src/App.tsx`
- Modify: `packages/editor/src/commands/charts.ts`
- Modify: `packages/editor/src/commands/charts.test.ts` (or add `charts.test.ts`)
- Modify: `packages/editor/src/i18n/messages/en.ts`, `zh-Hant.ts`, `zh-Hans.ts`
- Modify: `e2e/component-dragging.spec.ts`

**Interfaces:**
- Consumes: `onEnterContext`, `selection`, `slide` already passed to the Inspector.
- Produces: `data-testid="inspector-enter-component"`; `chartFigure(element)` now climbs to `figure[data-ppt-chart]`.

- [ ] **Step 1: Write the failing tests**

Add to `e2e/component-dragging.spec.ts`:

```ts
test('offers a visible Enter action for a deep selected container', { tag: '@feature:component-dragging' }, async ({ page }) => {
  const deck = await openDeck(page);
  try {
    await deck.frame.locator('#card').click({ position: { x: 4, y: 4 } });
    await page.getByTestId('inspector-enter-component').click();
    await expect(page.getByTestId('edit-context')).toContainText('card');
    await expect(page.getByTestId('object-row').filter({ hasText: 'icon' })).toBeVisible();
  } finally {
    await deck.close();
  }
});

test('selects the chart figure and keeps chart controls', { tag: '@feature:component-dragging' }, async ({ page }) => {
  const deck = await openDeck(page);
  try {
    await deck.frame.locator('#chart-svg').click();
    await expect(page.getByTestId('selection-outline')).toHaveAttribute('data-selected-id', 'chart');
    await expect(page.getByTestId('chart-object')).toBeVisible();
    await expect(page.getByTestId('chart-summary')).toContainText('bar');
  } finally {
    await deck.close();
  }
});
```

Add to `packages/editor/src/commands/charts.test.ts` (create if absent):

```ts
it('finds the chart figure from a descendant svg', () => {
  const figure = document.createElement('figure');
  figure.setAttribute('data-ppt-chart', '{}');
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  figure.appendChild(svg);
  expect(chartFigure(svg)).toBe(figure);
  expect(chartFigure(figure)).toBe(figure);
  expect(chartFigure(null)).toBeNull();
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `npm run test -w @htmlppt/editor -- src/commands/charts.test.ts` — FAIL (`chartFigure(svg)` is null).
Run: `npm run build && npx playwright test e2e/component-dragging.spec.ts -g "Enter action|chart figure" --project=chromium` — FAIL (no Enter button; chart selection is the figure but the controls may show if the figure is atomic — the chart test may already pass; keep the assertion).

- [ ] **Step 3: Implement the Enter action and strings**

Add to the locale catalogs:

```ts
// en.ts
'inspector.enterComponent': 'Enter',
// zh-Hant.ts
'inspector.enterComponent': '進入',
// zh-Hans.ts
'inspector.enterComponent': '进入',
```

In `Inspector.tsx`, after `objectActions`/`contextBase` are computed:

```tsx
const selectedElement =
  slide && selection ? elementAtPath(slide.element, selection.path) : null;
const canEnterSelection =
  Boolean(selectedElement && isEnterableContainer(selectedElement)) &&
  selection !== null &&
  selection.path.join('.') !== contextBase.join('.') &&
  onEnterContext !== undefined;
```

Render in the OBJECTS section header:

```tsx
<div className="flex items-center justify-between">
  <h3 className={HEADING_CLASS}>{t('inspector.objects')}</h3>
  {canEnterSelection && selection && (
    <button
      type="button"
      data-testid="inspector-enter-component"
      onClick={() => onEnterContext?.([...selection.path])}
      className={ACTION_CLASS}
    >
      {t('inspector.enterComponent')}
    </button>
  )}
</div>
```

- [ ] **Step 4: Make chartFigure climb to the figure**

```ts
export function chartFigure(element: Element | null): Element | null {
  if (!element) return null;
  const figure = element.closest('figure[data-ppt-chart]');
  return figure;
}
```

Update `handleOpenChartEditor` and `handleApplyChart` to pass the resolved figure:

```ts
const figure = chartFigure(element);
if (!figure) return;
setChartEditor({ json: chartJson(figure), error: '' });
```

```ts
const figure = chartFigure(element);
if (!figure || !chartFigure(figure)) {
  failure = t('app.chartNotSelected');
  return false;
}
const result = withChartData(figure, editor.json);
```

`chartState` in App already calls `chartFigure(primaryObject)`; it now works for the SVG too.

- [ ] **Step 5: Run the tests**

Run: `npm run test -w @htmlppt/editor -- src/commands/charts.test.ts src/inspector-state.test.ts` — PASS.
Run: `npm run build && npx playwright test e2e/component-dragging.spec.ts e2e/charts.spec.ts --project=chromium` — PASS.

- [ ] **Step 6: Phase 1 gate**

Run `npm run verify` alone on the final HEAD. Expected: PASS (lint, deps, typecheck, unit, integration, matrix, Playwright, package smoke). Record the commit hash and test counts. Do not start Phase 2 before this is green.

- [ ] **Step 7: Commit**

```bash
git add packages/editor/src/components/Inspector.tsx packages/editor/src/App.tsx packages/editor/src/commands/charts.ts packages/editor/src/commands/charts.test.ts packages/editor/src/i18n/messages e2e/component-dragging.spec.ts
git commit -m "feat(editor): enter components from the inspector and keep chart controls"
```

---

## Phase 2 — SVG and table geometry

### Task 5: SVG translate helpers

**Files:**
- Modify: `packages/editor/src/transform.ts`
- Modify: `packages/editor/src/transform.test.ts`

**Interfaces:**
- Produces:
  - `function svgUserDelta(element: Element, delta: Point): Point`
  - `function applySvgTranslate(element: Element, authoredTransform: string, delta: Point): void`

- [ ] **Step 1: Write the failing unit tests**

Add to `packages/editor/src/transform.test.ts`:

```ts
import { applySvgTranslate, svgUserDelta } from './transform.js';

describe('svgUserDelta', () => {
  it('converts a design delta through the element CTM', () => {
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    const shape = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
    svg.appendChild(shape);
    document.body.appendChild(svg);
    (shape as unknown as { getScreenCTM(): unknown }).getScreenCTM = () => ({
      inverse: () => ({
        transformPoint: (point: { x: number; y: number }) => ({
          x: point.x / 2 + 10,
          y: point.y / 2 + 20
        })
      })
    });
    expect(svgUserDelta(shape, { x: 40, y: 20 })).toEqual({ x: 20, y: 10 });
    svg.remove();
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npm run test -w @htmlppt/editor -- src/transform.test.ts` — FAIL (function missing).

- [ ] **Step 3: Implement the helpers**

```ts
function svgMatrix(element: Element): {
  transformPoint(point: { x: number; y: number }): { x: number; y: number };
} | null {
  const graphics = element as SVGGraphicsElement;
  const ctm = graphics.getScreenCTM?.();
  return ctm ? (ctm.inverse() as unknown as { transformPoint(point: { x: number; y: number }): { x: number; y: number } }) : null;
}

/** Converts a design-pixel delta to the element's SVG user units. */
export function svgUserDelta(element: Element, delta: Point): Point {
  const inverse = svgMatrix(element);
  if (!inverse) return { x: delta.x, y: delta.y };
  const origin = inverse.transformPoint({ x: 0, y: 0 });
  const moved = inverse.transformPoint({ x: delta.x, y: delta.y });
  return {
    x: Math.round((moved.x - origin.x) * 1000) / 1000,
    y: Math.round((moved.y - origin.y) * 1000) / 1000
  };
}

/** Pre-multiplies a translate so authored transforms are preserved. */
export function applySvgTranslate(
  element: Element,
  authoredTransform: string,
  delta: Point
): void {
  const translate = `translate(${delta.x} ${delta.y})`;
  const authored = authoredTransform.trim();
  element.setAttribute(
    'transform',
    authored ? `${translate} ${authored}` : translate
  );
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm run test -w @htmlppt/editor -- src/transform.test.ts` — PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/editor/src/transform.ts packages/editor/src/transform.test.ts
git commit -m "feat(editor): add SVG translate geometry helpers"
```

---

### Task 6: SVG drag mode, overlay, and Inspector state

**Files:**
- Modify: `packages/editor/src/App.tsx`
- Modify: `packages/editor/src/components/Inspector.tsx`
- Modify: `e2e/component-dragging.spec.ts`

**Interfaces:**
- Consumes: `svgUserDelta`, `applySvgTranslate`, `isSvgInternal`.
- Produces: SVG-internal selections drag via `transform`; no resize/rotate handles; geometry fields disabled.

- [ ] **Step 1: Write the failing E2E**

```ts
test('enters an SVG and drags a circle with a transform', { tag: '@feature:component-dragging' }, async ({ page }) => {
  const deck = await openDeck(page);
  try {
    // The chart figure is atomic: the first double-click enters the figure,
    // the second enters its svg, and then the circle is a direct child.
    await deck.frame.locator('#chart-svg').dblclick({ position: { x: 40, y: 40 } });
    await expect(page.getByTestId('edit-context')).toContainText('chart-card');
    await deck.frame.locator('#chart-svg').dblclick({ position: { x: 40, y: 40 } });
    await expect(page.getByTestId('edit-context')).toContainText('svg');
    await deck.frame.locator('#dot').click();
    await expect(page.getByTestId('selection-outline')).toHaveAttribute('data-selected-path', '0.0.1.1');
    await expect(page.locator('[data-testid^="handle-"]')).toHaveCount(0);
    await expect(page.getByTestId('rotate-handle')).toHaveCount(0);
    await expect(page.getByTestId('field-x')).toBeDisabled();

    const box = await deck.frame.locator('#dot').boundingBox();
    await page.mouse.move(box!.x + box!.width / 2, box!.y + box!.height / 2);
    await page.mouse.down();
    await page.mouse.move(box!.x + box!.width / 2 + 40, box!.y + box!.height / 2 + 20, { steps: 5 });
    await page.mouse.up();
    await expect(page.getByTestId('save-status')).toHaveText('已同步');
    const html = await readFile(deck.path, 'utf8');
    expect(html).toMatch(/id="dot"[^>]*transform="translate\([^)]*\)"/);
    expect(html).not.toMatch(/id="dot"[^>]*position: absolute/);
  } finally {
    await deck.close();
  }
});
```

The exact `data-selected-path` depends on the chart figure structure (`section > pad > figure > svg > circle` → `0.0.?`). Compute it in the test with a helper:

```ts
async function pathOf(deck, selector: string) {
  return deck.frame.locator(selector).evaluate((element) => {
    const path: number[] = [];
    let current: Element | null = element;
    const slide = element.closest('[data-ppt-preview-slide], [data-slide-id]');
    while (current && slide && current !== slide) {
      const parent = current.parentElement;
      if (!parent) break;
      path.unshift(Array.from(parent.children).indexOf(current));
      current = parent;
    }
    return path.join('.');
  });
}
```

Use `await expect(outline).toHaveAttribute('data-selected-path', await pathOf(deck, '#dot'))`.

- [ ] **Step 2: Run it to verify it fails**

Run: `npm run build && npx playwright test e2e/component-dragging.spec.ts -g "drags a circle" --project=chromium` — FAIL (the circle is pinned with CSS; no transform).

- [ ] **Step 3: Add the SVG geometry mode to the session**

In the gesture types, add `mode: 'html' | 'svg'` and, for SVG targets, `authoredTransform: string`.

In `beginDragSession`, map each item:

```ts
targets: items.map((item) => {
  const svg = isSvgInternal(item.element);
  return {
    element: item.element,
    start: rectOf(item.element, slide),
    rotation: rotationOf(item.element),
    path: item.selection.path,
    elementId: item.selection.elementId,
    mode: svg ? 'svg' : 'html',
    authoredTransform: svg
      ? item.element.getAttribute('transform') ?? ''
      : ''
  };
})
```

In `moveSession`, the first-move pin step only runs for HTML targets:

```ts
const htmlTargets = session.targets.filter((target) => target.mode === 'html');
session.pinned = willAnyPinToAbsolute(htmlTargets.map((target) => target.element));
htmlTargets.forEach((target) => pinToAbsolute(target.element, target.start, session.slide));
```

For the drag branch, after computing `dx/dy` and snapping, apply per target:

```ts
rects.forEach((rect, index) => {
  const target = session.targets[index];
  if (!target) return;
  if (target.mode === 'svg') {
    applySvgTranslate(
      target.element,
      target.authoredTransform,
      svgUserDelta(target.element, { x: dx, y: dy })
    );
  } else {
    applyRect(target.element, rect, session.slide);
  }
});
```

Disable snapping when any target is SVG:

```ts
const allowSnap = !noSnap && session.targets.every((target) => target.mode === 'html');
```

The overlay boxes keep using the start rect + delta, which is exact for SVG too.

- [ ] **Step 4: Suppress handles and lock geometry in the Inspector**

In `App.tsx`, compute:

```ts
const svgInternal = primaryObject ? isSvgInternal(primaryObject) : false;
const tableInternal = primaryObject ? isTableInternal(primaryObject) : false;
const overlayHandles =
  blockedAncestor !== null || svgInternal || tableInternal ||
  (primaryObject && isLockedElement(primaryObject))
    ? 'none'
    : primaryObject && isGroupElement(primaryObject)
      ? 'rotate'
      : 'all';
```

Pass `geometryUnavailable={svgInternal || tableInternal}` to the Inspector. In `Inspector.tsx`, add the prop and fold it into `geometryLocked`:

```ts
const geometryLocked =
  readOnly ||
  blockedByAncestor ||
  geometryUnavailable ||
  objectActions.locked ||
  objectActions.hidden;
```

- [ ] **Step 5: Run the SVG E2E**

Run: `npm run build && npx playwright test e2e/component-dragging.spec.ts -g "drags a circle" --project=chromium` — PASS. Then run the transform/unit suites.

- [ ] **Step 6: Commit**

```bash
git add packages/editor/src/App.tsx packages/editor/src/components/Inspector.tsx e2e/component-dragging.spec.ts
git commit -m "feat(editor): drag SVG shapes with a transform"
```

---

### Task 7: Table cells select but do not drag

**Files:**
- Modify: `packages/editor/src/App.tsx`
- Modify: `packages/editor/src/text-edit-block.ts`
- Modify: `packages/editor/src/text-edit-block.test.ts`
- Modify: `packages/editor/src/i18n/messages/en.ts`, `zh-Hant.ts`, `zh-Hans.ts`
- Modify: `e2e/component-dragging.spec.ts`

**Interfaces:**
- Produces: `EditHintReason` gains `'table-cell'`; a moved table cell shows `data-testid="edit-hint"` with the new copy; no geometry session starts.

- [ ] **Step 1: Write the failing tests**

Unit (`text-edit-block.test.ts`):

```ts
it('maps the table-cell reason to its copy key', () => {
  expect(EDIT_HINT_KEYS['table-cell']).toBe('editor.hint.table-cell-move');
});
```

E2E:

```ts
test('selects a table cell but refuses to drag it', { tag: '@feature:component-dragging' }, async ({ page }) => {
  const deck = await openDeck(page);
  try {
    await deck.frame.locator('#cell-a').click();
    await expect(page.getByTestId('table-toolbar')).toBeVisible();
    const box = await deck.frame.locator('#cell-a').boundingBox();
    await page.mouse.move(box!.x + 10, box!.y + 10);
    await page.mouse.down();
    await page.mouse.move(box!.x + 50, box!.y + 40, { steps: 5 });
    await page.mouse.up();
    const after = await deck.frame.locator('#cell-a').boundingBox();
    expect(deviation(box!, after!)).toBeLessThanOrEqual(1);
    await expect(page.getByTestId('edit-hint')).toBeVisible();
    await expect(page.getByTestId('edit-hint')).toContainText('表格');
  } finally {
    await deck.close();
  }
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `npm run test -w @htmlppt/editor -- src/text-edit-block.test.ts` — FAIL (no `table-cell` key).
Run: `npm run build && npx playwright test e2e/component-dragging.spec.ts -g "refuses to drag" --project=chromium` — FAIL (no hint; the cell pins).

- [ ] **Step 3: Add the reason and the localized copy**

`text-edit-block.ts`:

```ts
export type TextEditBlock = 'not-text' | 'has-children' | 'empty';
export type EditHintReason = TextEditBlock | 'locked' | 'hidden' | 'group' | 'table-cell';

/** Guard reasons only; table-cell is a movement hint, not a guard. */
export type TopLevelBlock = 'locked' | 'hidden' | 'group';

export const EDIT_HINT_KEYS: Record<EditHintReason, MessageKey> = {
  'not-text': 'editor.hint.not-text',
  'has-children': 'editor.hint.has-children',
  empty: 'editor.hint.empty',
  locked: 'editor.hint.locked',
  hidden: 'editor.hint.hidden',
  group: 'editor.hint.group',
  'table-cell': 'editor.hint.table-cell-move'
};
```

Locales:

```ts
// en.ts
'editor.hint.table-cell-move': 'This is a table cell. Select the table to move it.',
// zh-Hant.ts
'editor.hint.table-cell-move': '這是表格儲存格，請選取整個表格再移動。',
// zh-Hans.ts
'editor.hint.table-cell-move': '这是表格单元格，请选取整个表格再移动。',
```

- [ ] **Step 4: Detect a moved table cell without starting a session**

In `handleFramePointerDown`, after the table-internal check and before `beginDragSession`, attach a one-shot movement probe:

```ts
if (isTableInternal(clicked)) {
  const startX = event.clientX;
  const startY = event.clientY;
  const threshold = DRAG_THRESHOLD_SCREEN_PX;
  const cleanup = () => {
    frameDocument.removeEventListener('pointermove', onMove);
    frameDocument.removeEventListener('pointerup', cleanup);
    frameDocument.removeEventListener('pointercancel', cleanup);
  };
  const onMove = (move: PointerEvent) => {
    if (Math.hypot(move.clientX - startX, move.clientY - startY) < threshold) return;
    cleanup();
    showEditHint('table-cell');
  };
  frameDocument.addEventListener('pointermove', onMove);
  frameDocument.addEventListener('pointerup', cleanup);
  frameDocument.addEventListener('pointercancel', cleanup);
  return;
}
```

Also refuse Delete on a table cell with the same hint. In `handleKeyDown`'s `case 'delete'`:

```ts
const slide = frameSlideNow();
const element = slide && current.selection
  ? elementAtPath(slide, current.selection.path)
  : null;
if (element && isTableInternal(element)) {
  event.preventDefault();
  showEditHint('table-cell');
  return;
}
```

The table's own row/column operations stay in the table toolbar, so the cell is never removed by Delete.

Do not `preventDefault` for the probe, so the browser's native cell text selection still works. `showEditHint` currently accepts `EditHintReason`; the new reason flows through `EDIT_HINT_KEYS`.

- [ ] **Step 5: Run the tests**

Run: `npm run test -w @htmlppt/editor -- src/text-edit-block.test.ts` — PASS.
Run: `npm run build && npx playwright test e2e/component-dragging.spec.ts e2e/tables.spec.ts --project=chromium` — PASS.

- [ ] **Step 6: Phase 2 gate**

Run `npm run verify` alone on the final HEAD. Expected: PASS. Record the commit and counts. Do not start Phase 3 before this is green.

- [ ] **Step 7: Commit**

```bash
git add packages/editor/src/App.tsx packages/editor/src/text-edit-block.ts packages/editor/src/text-edit-block.test.ts packages/editor/src/i18n/messages e2e/component-dragging.spec.ts
git commit -m "feat(editor): explain why a table cell cannot be dragged"
```

---

## Phase 3 — Nested structural operations

### Task 8: Nested object helpers

**Files:**
- Modify: `packages/editor/src/object-ops.ts`
- Modify: `packages/editor/src/object-ops.test.ts`

**Interfaces:**
- Produces:
  - `function cloneComponent(element: Element, master: Document, nextId: () => string): Element`
  - `function collectComponent(element: Element): Element | null` (returns the selected element; top-level or nested)
  - `function deleteComponentPaths(master: Document, slideIndex: number, paths: readonly (readonly number[])[]): number`
  - `function pasteComponentNode(master: Document, slideIndex: number, node: Element, parentPath: readonly number[], afterPath: readonly number[] | null, measure?: PastedObjectMeasure): SelectionTarget | null`

- [ ] **Step 1: Write the failing unit tests**

Add to `packages/editor/src/object-ops.test.ts`:

```ts
import {
  cloneComponent,
  deleteComponentPaths,
  pasteComponentNode
} from './object-ops.js';

it('deletes a nested element by path', () => {
  const master = new DOMParser().parseFromString(
    '<main data-ppt-deck><section data-slide-id="s1"><div id="pad"><h1 id="head">T</h1><p id="lead">L</p></div></section></main>',
    'text/html'
  );
  expect(deleteComponentPaths(master, 0, [[0, 0]])).toBe(1);
  expect(master.querySelector('#head')).toBeNull();
  expect(master.querySelector('#lead')).not.toBeNull();
});

it('clones a nested element and refreshes ids', () => {
  const master = document.createElement('div');
  master.innerHTML = '<div id="pad"><h1 id="head" data-ppt-el="e1"><span data-ppt-el="e2">x</span></h1></div>';
  const source = master.querySelector('#head')!;
  let next = 10;
  const clone = cloneComponent(source, master, () => `e${next++}`) as Element;
  expect(clone.getAttribute('data-ppt-el')).toBe('e10');
  expect(clone.querySelector('span')?.getAttribute('data-ppt-el')).toBe('e11');
  expect(clone.id).toBe('head');
});

it('pastes an svg node into an svg parent without HTML parsing', () => {
  const master = new DOMParser().parseFromString(
    '<main data-ppt-deck><section data-slide-id="s1"><svg id="plot"><circle id="dot" cx="5" cy="5" r="2"/></svg></section></main>',
    'text/html'
  );
  const dot = master.querySelector('#dot')!;
  const target = pasteComponentNode(
    master,
    0,
    dot.cloneNode(true) as Element,
    [0],
    null,
    undefined
  );
  expect(target?.path).toEqual([0, 1]);
  expect(master.querySelectorAll('circle')).toHaveLength(2);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm run test -w @htmlppt/editor -- src/object-ops.test.ts` — FAIL (missing exports).

- [ ] **Step 3: Implement the helpers**

In `object-ops.ts`:

```ts
export function cloneComponent(
  element: Element,
  master: Document,
  nextId: () => string
): Element {
  const clone = master.importNode(element, true) as Element;
  if (clone.hasAttribute('data-ppt-el')) {
    clone.setAttribute('data-ppt-el', nextId());
  }
  for (const nested of Array.from(clone.querySelectorAll('[data-ppt-el]'))) {
    nested.setAttribute('data-ppt-el', nextId());
  }
  return clone;
}

export function deleteComponentPaths(
  master: Document,
  slideIndex: number,
  paths: readonly (readonly number[])[]
): number {
  const slide = detectSlides(master)[slideIndex]?.element;
  if (!slide) return 0;
  let removed = 0;
  for (const path of [...paths].sort((a, b) => b.length - a.length)) {
    const parent = elementAtPath(slide, path.slice(0, -1));
    const index = path[path.length - 1];
    const element = parent?.children[index ?? -1];
    if (!element || element === slide) continue;
    parent.removeChild(element);
    removed += 1;
  }
  return removed;
}

export function pasteComponentNode(
  master: Document,
  slideIndex: number,
  node: Element,
  parentPath: readonly number[],
  afterPath: readonly number[] | null,
  measure?: PastedObjectMeasure
): SelectionTarget | null {
  const slide = detectSlides(master)[slideIndex]?.element;
  const parent = slide ? elementAtPath(slide, parentPath) : null;
  if (!slide || !parent) return null;
  const clone = cloneComponent(node, master, nextIdFactory(slide));
  offsetPastedObject(clone, slide, measure?.(clone) ?? null);
  const after = afterPath
    ? parent.children[afterPath[afterPath.length - 1] ?? -1]
    : null;
  if (after) parent.insertBefore(clone, after.nextSibling);
  else parent.appendChild(clone);
  return {
    slideIndex,
    path: [...parentPath, Array.from(parent.children).indexOf(clone)],
    elementId: clone.getAttribute('data-ppt-el')?.trim() || null
  };
}
```

Note: `nextIdFactory` and `offsetPastedObject` are private but already in the file, so reuse them. `elementAtPath` must be imported from `selection.js`. The `svg` parameter is not needed if `importNode` preserves the namespace; drop it. `offsetPastedObject` handles `position:relative` for flow; for SVG nodes, inline styles are ineffective, so add a branch: if `isSvgInternal(clone)`, set a `transform` translate of 20 user units? The duplicate offset for SVG uses a 20 px design offset; import `svgUserDelta` from `transform.js` would create a dependency from object-ops to transform (both editor modules, fine). Simpler: set `transform="translate(20 20) <authored>"` for SVG clones inside the offset function:

```ts
if (clone.namespaceURI === 'http://www.w3.org/2000/svg' && clone.closest('svg') !== clone) {
  const authored = clone.getAttribute('transform') ?? '';
  clone.setAttribute('transform', authored ? `translate(20 20) ${authored}` : 'translate(20 20)');
  return;
}
```

Add this at the top of `offsetPastedObject`.

- [ ] **Step 4: Run the unit tests**

Run: `npm run test -w @htmlppt/editor -- src/object-ops.test.ts` — PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/editor/src/object-ops.ts packages/editor/src/object-ops.test.ts
git commit -m "feat(editor): address nested components by path"
```

---

### Task 9: Nested copy, paste, duplicate, delete, and multi-selection

**Files:**
- Modify: `packages/editor/src/use-deck-controller.ts`
- Modify: `packages/editor/src/commands/objects.ts`
- Modify: `packages/editor/src/App.tsx`
- Modify: `e2e/component-dragging.spec.ts`

**Interfaces:**
- Consumes: Task 8 helpers, Task 2 multi-depth selection.
- Produces: nested structural operations and their history/save behavior.

- [ ] **Step 1: Write the failing tests**

Unit (`use-deck-controller.test.ts`): the controller's nested behavior is covered end to end by the Playwright cases below (real autosave, history, and reload), because the controller's selection and clipboard state only becomes meaningful across those async paths. The pure pieces (`cloneComponent`, `deleteComponentPaths`, `pasteComponentNode`) are unit-tested in Task 8.

E2E:

```ts
test('duplicates and deletes a nested component inside its parent', { tag: '@feature:component-dragging' }, async ({ page }) => {
  const deck = await openDeck(page);
  try {
    await deck.frame.locator('#headline').click();
    await page.keyboard.press('Control+d');
    await expect(deck.frame.locator('#pad h1')).toHaveCount(2);
    const clone = deck.frame.locator('#pad h1').nth(1);
    const sourceBox = await deck.frame.locator('#headline').boundingBox();
    const cloneBox = await clone.boundingBox();
    expect(cloneBox!.x - sourceBox!.x).toBeCloseTo(20, 0);
    await expect(page.getByTestId('save-status')).toHaveText('已同步');
    await page.keyboard.press('Control+z');
    await expect(deck.frame.locator('#pad h1')).toHaveCount(1);
    await page.keyboard.press('Delete');
    await expect(deck.frame.locator('#headline')).toHaveCount(0);
  } finally {
    await deck.close();
  }
});

test('refuses structural commands on a nested multi-selection', { tag: '@feature:component-dragging' }, async ({ page }) => {
  const deck = await openDeck(page);
  try {
    await deck.frame.locator('#headline').click();
    await deck.frame.locator('#chip-one').click({ modifiers: ['Shift'] });
    await expect(page.getByTestId('selection-outline')).toHaveCount(2);
    await page.keyboard.press('Control+d');
    await expect(deck.frame.locator('#pad h1')).toHaveCount(1);
    await expect(page.getByTestId('inspector-nested-structural')).toBeVisible();
  } finally {
    await deck.close();
  }
});
```

Check the actual testid of the nested structural hint in `Inspector.tsx`; if it has none, add `data-testid="inspector-nested-structural"` to the existing hint element.

Also add the copy/paste case to the same file:

```ts
test('copies and pastes a nested component as its sibling', { tag: '@feature:component-dragging' }, async ({ page }) => {
  const deck = await openDeck(page);
  try {
    await deck.frame.locator('#headline').click();
    await page.keyboard.press('Control+c');
    await deck.frame.locator('#lead').click();
    await page.keyboard.press('Control+v');
    await expect(deck.frame.locator('#pad h1')).toHaveCount(2);
    const leadBox = await deck.frame.locator('#lead').boundingBox();
    const cloneBox = await deck.frame.locator('#pad h1').nth(1).boundingBox();
    expect(cloneBox!.y).toBeGreaterThan(leadBox!.y);
    await expect(page.getByTestId('save-status')).toHaveText('已同步');
  } finally {
    await deck.close();
  }
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `npm run build && npx playwright test e2e/component-dragging.spec.ts -g "duplicates and deletes|refuses structural|copies and pastes" --project=chromium` — FAIL (nested paths are ignored by the current `collectObjectHtml`/`deleteObjectPaths`).

- [ ] **Step 3: Share the path guards**

Move `blockedPathAncestor` and `guardedPathElement` from `App.tsx` into `packages/editor/src/commands/objects.ts` (exported), import them back in `App.tsx`, and import `blockedPathAncestor` in `use-deck-controller.ts`. `commands/objects.ts` already imports `elementAtPath` and the guard predicates, so no new cycle.

- [ ] **Step 4: Replace the clipboard with component nodes**

In `use-deck-controller.ts`:

```ts
interface ClipboardComponent {
  node: Element;
  parentTag: string;
  svg: boolean;
}
const clipboardRef = useRef<ClipboardComponent[]>([]);
```

`copySelection`:

```ts
const targets = stateRef.current.selections.filter(
  (target) => target.slideIndex === activeIndexRef.current
);
if (targets.length === 0) return;
const slide = slidesRef.current[activeIndexRef.current];
if (!slide) return;
const components: ClipboardComponent[] = [];
for (const target of targets) {
  const element = elementAtPath(slide.element, target.path);
  if (!element || isTableInternal(element)) continue;
  const parent = element.parentElement;
  if (!parent) continue;
  components.push({
    node: element.cloneNode(true) as Element,
    parentTag: parent.tagName.toLowerCase(),
    svg: element.namespaceURI === 'http://www.w3.org/2000/svg'
  });
}
if (components.length > 0) clipboardRef.current = components;
```

Paste:

```ts
const pasteObjects = useCallback(async () => {
  const components = clipboardRef.current;
  if (components.length === 0) return;
  const current = stateRef.current;
  const slide = slidesRef.current[activeIndexRef.current];
  if (!slide) return;
  const selected = current.selections.filter(
    (target) => target.slideIndex === activeIndexRef.current
  );
  if (selected.length > 1) return;
  await commitMaster((master) => {
    const targets: SelectionTarget[] = [];
    for (const component of components) {
      const anchor = selected[0] ?? null;
      if (anchor && anchor.path.length > 1) {
        const parentPath = anchor.path.slice(0, -1);
        const parent = elementAtPath(slide.element, parentPath);
        const compatible =
          parent !== null &&
          (component.svg
            ? parent.namespaceURI === 'http://www.w3.org/2000/svg'
            : parent.tagName.toLowerCase() === component.parentTag);
        if (compatible) {
          const pasted = pasteComponentNode(
            master,
            activeIndexRef.current,
            component.node,
            parentPath,
            anchor.path,
            measurePastedRef.current
          );
          if (pasted) targets.push(pasted);
          continue;
        }
        if (component.svg) continue;
        // An HTML component copied elsewhere still pastes at slide level.
      }
      if (component.svg) continue;
      const pasted = pasteComponentNode(
        master,
        activeIndexRef.current,
        component.node,
        [],
        null,
        measurePastedRef.current
      );
      if (pasted) targets.push(pasted);
    }
    if (targets.length > 0) applySelections(targets);
  });
}, [applySelections, commitMaster]);
```

Duplicate:

```ts
const duplicateSelection = useCallback(async () => {
  const current = stateRef.current;
  const slide = slidesRef.current[activeIndexRef.current];
  if (!slide) return;
  const targets = current.selections.filter(
    (target) => target.slideIndex === activeIndexRef.current
  );
  if (targets.length !== 1 || targets[0].path.length < 2) {
    // top-level multi and top-level single keep the existing string path
    const html = collectObjectHtml(
      slide.element,
      targets.map((target) => target.path)
    );
    if (html.length > 0) await pasteHtml(html);
    return;
  }
  const target = targets[0];
  const element = elementAtPath(slide.element, target.path);
  if (!element || !element.parentElement || isTableInternal(element)) return;
  await commitMaster((master) => {
    const pasted = pasteComponentNode(
      master,
      activeIndexRef.current,
      element,
      target.path.slice(0, -1),
      target.path,
      measurePastedRef.current
    );
    if (pasted) applySelections([pasted]);
  });
}, [applySelections, commitMaster, pasteHtml]);
```

Delete:

```ts
const deleteSelection = useCallback(async () => {
  const current = stateRef.current;
  const slideIndex = activeIndexRef.current;
  const slide = slidesRef.current[slideIndex];
  if (!slide) return;
  const targets = current.selections.filter(
    (target) => target.slideIndex === slideIndex
  );
  if (targets.length === 0) return;
  const nested = targets.some((target) => target.path.length > 1);
  if (targets.length > 1 && nested) return;
  if (targets.length === 1 && targets[0].path.length > 1) {
    const element = elementAtPath(slide.element, targets[0].path);
    if (!element || isTableInternal(element) || blockedPathAncestor(slide.element, targets[0].path)) return;
  }
  await commitMaster((master) => {
    const removed = nested
      ? deleteComponentPaths(master, slideIndex, targets.map((target) => target.path))
      : deleteObjectPaths(master, slideIndex, targets.map((target) => target.path));
    if (removed > 0 && activeIndexRef.current === slideIndex) {
      applySelections([]);
    }
  });
}, [applySelections, commitMaster]);
```

`pasteHtml` (the old path) stays for clipboard entries created before this change? The clipboard is now nodes, so the old `pasteObjects` is replaced. Keep `pasteHtml` for duplicate of top-level multi; it uses `pasteObjectHtml` strings. `duplicateSelection` top-level path uses it. Fine.

App-level: `deleteSelection` currently filters top-level paths; remove that filtering so nested targets reach the controller. In App, `deleteSelection` is in the controller; no App change. The App's Delete shortcut calls `actionsRef.current.deleteSelection()`. Good.
`copySelection`/`pasteObjects` are in the controller; no App change.
`isTableInternal` and `blockedPathAncestor` imports in the controller.

- [ ] **Step 5: Run the tests**

Run: `npm run test -w @htmlppt/editor -- src/use-deck-controller.test.ts src/object-ops.test.ts` — PASS.
Run: `npm run build && npx playwright test e2e/component-dragging.spec.ts e2e/rich-text.spec.ts e2e/insertion.spec.ts --project=chromium` — PASS.

- [ ] **Step 6: Phase 3 gate**

Run `npm run verify` alone on the final HEAD. Expected: PASS. Record the commit and counts.

- [ ] **Step 7: Commit**

```bash
git add packages/editor/src/use-deck-controller.ts packages/editor/src/use-deck-controller.test.ts packages/editor/src/commands/objects.ts packages/editor/src/App.tsx e2e/component-dragging.spec.ts
git commit -m "feat(editor): edit nested components with the standard commands"
```

---

## Phase 4 — Docs, feature matrix, and release gate

### Task 10: Documentation and feature matrix

**Files:**
- Modify: `docs/features.json`
- Modify: `docs/contract.md`
- Modify: `docs/architecture.md`
- Modify: `README.md`

- [ ] **Step 1: Add the feature id**

```json
{ "id": "component-dragging", "spec": "Component dragging 2026-10-28", "status": "active", "tests": ["@feature:component-dragging"] }
```

- [ ] **Step 2: Document the contract**

`docs/contract.md` Canvas/Objects section: add a paragraph stating that the editor's click target is the innermost visible component (deepest non-inline box, atomic media, chart figures, guarded wrappers), that entered contexts keep direct-child selection, that SVG internals are reached by entering an SVG and are moved with `transform`, that table cells are selectable but immovable, that nested/SVG components support delete/duplicate/copy-paste inside their parent, and that selection/hover state is editor-only and never saved. Note the superseded 2026-10-25 slide-level click rule.

`docs/architecture.md`: describe `component-target.ts`, the hover overlay, the SVG geometry mode, and the node clipboard.

`README.md`: one short bullet under editor features.

- [ ] **Step 3: Run the matrix and lint**

Run: `npm run test:matrix` — PASS with 25 active features.
Run: `npm run lint` — PASS.

- [ ] **Step 4: Commit**

```bash
git add docs/features.json docs/contract.md docs/architecture.md README.md
git commit -m "docs: record the component selection contract"
```

---

### Task 11: Full verification, manual QA, and PR

- [ ] **Step 1: Full verify alone on the final HEAD**

Run: `npm run verify` with no other build/verify running. Expected: PASS (lint, lint:deps, typecheck, unit, integration, feature matrix, Playwright, package smoke). Record the commit hash, unit/integration/Playwright counts, and matrix count.

- [ ] **Step 2: Manual QA on the built dist**

Serve the built editor with `node packages/cli/dist/bin.js open <deck> --no-browser` for `D:/project/tmp/htmlppt-manual/rich-demo.html` and `aria-conductor-q.html` (and the component fixture). Verify in a real browser at 1440x900:
- hover outlines the component under the pointer; clicking a heading/card/chip/tab/step/icon/chart selects that component;
- dragging moves only it; the wrapper/footer/decorations stay; undo restores;
- double-click enters a card and an SVG; Esc leaves; the Inspector Enter action works;
- entering the chart SVG and dragging a bar/circle writes a transform; save/reload keeps it; no handles;
- table cell selects and opens the table toolbar; drag shows the hint; the table moves from its border;
- duplicate/delete/copy-paste nested components persist; multi-selection across depths drags together;
- play mode and export are unchanged (PDF page count and PNG count match the pre-change run).

If a browser check cannot be performed, say so explicitly; do not claim QA.

- [ ] **Step 3: Push and open the PR**

Only after the user authorizes the push for this round. Push `feat/component-dragging`, open a PR against `main` with the verify evidence, the spec/plan links, and the phase test counts. Do not merge, tag, or publish.

- [ ] **Step 4: Hosted CI**

Watch the newest run of the pushed SHA until every job is green (ubuntu+windows, Node 20+22, E2E, package smoke). A red matrix is not proposed for merge. Classify any failure as environment/flake/test-race/regression before changing product code.

- [ ] **Step 5: Final report**

Reply in Traditional Chinese with: phases implemented vs pending CI, the exact verify command and commit, the CI run id and job counts, manual QA results, and the PR link. Never commit or push to `main`; the user merges.
