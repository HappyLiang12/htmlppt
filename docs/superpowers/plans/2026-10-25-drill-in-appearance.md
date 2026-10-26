# Drill-in Editing Phase 3: Appearance for Generic Elements Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Expose the appearance panel for a single selection of any element type, not only top-level `div`, `svg`, and `img`.

**Architecture:** Core's `setShapeAppearance`/`readShapeAppearance` already map fill, stroke, radius, and opacity onto any `HTMLElement` with an inline `style` (`packages/core/src/appearance.ts:110-159`); only the editor's kind computation restricts it to `div`. This phase replaces that tag check with a pure helper and removes the nested-selection rejection in the appearance state.

**Tech Stack:** React 19, TypeScript, Vitest, Playwright.

**Spec:** `docs/superpowers/specs/2026-10-25-nested-container-editing-design.md` (Behavior > Appearance)

## Global Constraints

- No core map/attribute changes: SVG keeps attribute mapping, `img` keeps image controls.
- Text styling beyond an active text session stays out of scope.
- Only inline styles change; no classes, no attributes, no new ids.
- RED first, then GREEN, then commit.
- Branch + PR only; push and PR need per-round authorization.

---

## File Structure

- Create `packages/editor/src/appearance-kind.ts` and `.test.ts`.
- Modify `packages/editor/src/App.tsx:3205-3217` (style state).
- Modify `e2e/drill-in.spec.ts`, `README.md`.

---

### Task 1: Kind helper

**Files:**
- Create: `packages/editor/src/appearance-kind.ts`
- Create: `packages/editor/src/appearance-kind.test.ts`

**Interfaces:**
- Produces: `type AppearanceKind = 'image' | 'shape'`; `appearanceKindFor(element: Element): AppearanceKind`.

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, it } from 'vitest';
import { appearanceKindFor } from './appearance-kind';

function element(html: string): Element {
  const doc = new DOMParser().parseFromString(html, 'text/html');
  return doc.body.firstElementChild as Element;
}

describe('appearanceKindFor', () => {
  it('keeps images on the image controls', () => {
    expect(appearanceKindFor(element('<img alt="">'))).toBe('image');
  });

  it('treats every other element as a shape', () => {
    for (const html of ['<p></p>', '<h1></h1>', '<article></article>', '<div></div>', '<svg></svg>']) {
      expect(appearanceKindFor(element(html))).toBe('shape');
    }
  });
});
```

- [ ] **Step 2: Run RED**

Run: `npm run test -w @htmlppt/editor -- appearance-kind.test.ts`

Expected: FAIL because the module does not exist.

- [ ] **Step 3: Implement**

```ts
export type AppearanceKind = 'image' | 'shape';

/** Images keep crop/alt controls; every other element maps to shape styles. */
export function appearanceKindFor(element: Element): AppearanceKind {
  return element.tagName.toLowerCase() === 'img' ? 'image' : 'shape';
}
```

- [ ] **Step 4: Run GREEN**

Run: `npm run test -w @htmlppt/editor -- appearance-kind.test.ts`

Expected: 2 tests pass.

- [ ] **Step 5: Commit**

```bash
git add packages/editor/src/appearance-kind.ts packages/editor/src/appearance-kind.test.ts
git commit -m "feat(editor): classify appearance for any element"
```

---

### Task 2: Appearance state for nested and generic selections

**Files:**
- Modify: `packages/editor/src/App.tsx:3205-3217`

**Interfaces:**
- Consumes: `appearanceKindFor`.
- Produces: the appearance panel renders for a single selection at any depth and for any tag.

- [ ] **Step 1: Replace the style state body**

```ts
  const styleState: InspectorStyleState | null = (() => {
    if (!activeSlide || !selection || selections.length !== 1) {
      return null;
    }
    const element = elementAtPath(activeSlide.element, selection.path);
    if (!element) return null;
    const tag = element.tagName.toLowerCase();
    return {
      kind: appearanceKindFor(element),
      svg: tag === 'svg',
      appearance: readShapeAppearance(element),
      text:
        tag === 'svg' ? element.querySelector('text')?.textContent ?? '' : '',
      alt: element.getAttribute('alt') ?? '',
      crop: imageCropOf(element) ?? { top: 0, right: 0, bottom: 0, left: 0 }
    };
  })();
```

This removes the `selection.path.length > 1` rejection and the `tag === 'div'` restriction. `InspectorStyleState.kind` already accepts `'shape' | 'image'`.

- [ ] **Step 2: Typecheck**

Run: `npm run typecheck -w @htmlppt/editor`

Expected: exit 0. If the SVG text field now renders for non-SVG shapes, gate the field on `style.svg` in `Inspector.tsx` instead of reintroducing a tag check in `App.tsx`.

- [ ] **Step 3: Commit**

```bash
git add packages/editor/src/App.tsx
git commit -m "feat(editor): expose appearance for generic elements"
```

---

### Task 3: E2E and docs

**Files:**
- Modify `e2e/drill-in.spec.ts`
- Modify `README.md`

- [ ] **Step 1: Add the test**

```ts
test('styles a nested paragraph and persists it', async ({ page }) => {
  const editor = await openDeck(page, 'wrapped.deck.html');

  await page.getByRole('button', { name: /Enter pad|進入 pad|进入 pad/ }).click();
  await editor.frame.locator('.pad .foot').click();

  const fill = page.getByLabel(/Fill|填色|填充/);
  await fill.fill('#ffeeaa');
  await fill.press('Enter');

  await expect.poll(async () =>
    (await editor.frame.locator('.pad .foot').getAttribute('style')) ?? ''
  ).toContain('background-color');

  await editor.reload();
  const style = await editor.frame.locator('.pad .foot').getAttribute('style');
  expect(style).toContain('rgb(255, 238, 170)');

  await editor.close();
});
```

Match the inspector's real field labels; if the fill control is not a labelled input, use the `data-testid` the shape panel already uses for `div` shapes. If the harness has no reload helper, call `page.reload()` and re-acquire the frame.

- [ ] **Step 2: Run**

Run: `npx playwright test e2e/drill-in.spec.ts --reporter=line`

Expected: PASS.

- [ ] **Step 3: Document**

In `README.md`, extend the drill-in paragraph: position, size, appearance, and text apply to the selected child at any depth; SVG shapes keep attribute mapping and images keep crop/alt controls.

- [ ] **Step 4: Full gate**

Run: `npm run verify`

Expected: all suites pass.

- [ ] **Step 5: Commit**

```bash
git add e2e/drill-in.spec.ts README.md
git commit -m "test(e2e): cover appearance on a nested element"
```

---

## Phase Exit Criteria

- A single selection of `p`, `h1`, `article`, `div`, or `svg` shows shape appearance; `img` shows image controls.
- Fill, stroke, radius, and opacity persist across reload for a nested element.
- No core appearance behavior changed.
- `npm run verify` and the hosted matrix are green before Phase 4 starts.
