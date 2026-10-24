# Drill-in Editing Phase 2: Nested Geometry Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Allow position, size, rotation, drag, resize, and nudge on a single nested selection, pinning flow elements to absolute on first edit with a one-time notice and Undo.

**Architecture:** The mutation layer already resolves `selection.path` with `elementAtPath` and pins flow objects in `applyGeometryEdit`, so this phase removes only the UI gates that reject `path.length !== 1` and adds a non-blocking notice when a pin happens. Multi-selection stays read-only; structural commands stay top-level only.

**Tech Stack:** React 19, TypeScript, Vitest, Playwright.

**Spec:** `docs/superpowers/specs/2026-10-25-nested-container-editing-design.md` (Behavior > Geometry, Risks)

## Global Constraints

- One selection at any depth is editable; multi-selection stays read-only.
- No `data-ppt-el` or other attributes are added by geometry edits; only inline styles change.
- Structural operations (duplicate, delete, reorder, group) stay top-level only.
- The notice never blocks the gesture; Undo uses the existing history stack.
- RED first, then GREEN, then commit. Do not weaken existing geometry tests.
- Branch + PR only; push and PR need per-round authorization.

---

## File Structure

- Create `packages/editor/src/geometry-guards.ts`: pure predicate for the pin notice.
- Create `packages/editor/src/geometry-guards.test.ts`.
- Modify `packages/editor/src/App.tsx`: remove nested gates, wire the notice.
- Modify `packages/editor/src/components/Inspector.tsx`: read-only only for multi-selection.
- Modify `packages/editor/src/i18n/messages/*.ts`: notice copy.
- Modify `e2e/drill-in.spec.ts`: drag, persist, undo.

---

### Task 1: Remove the nested geometry gates

**Files:**
- Modify `packages/editor/src/App.tsx:2059`, `:2103`, `:2150`, `:2647`, `:2717`, `:2735`, `:3564`
- Modify `packages/editor/src/components/Inspector.tsx:392-393`

**Interfaces:**
- Produces: resize, rotate, drag, and nudge accept any single selection; overlay handles render for `path.length > 1`; the inspector computes `readOnly` from multi-selection only.

- [ ] **Step 1: Change the inspector guard**

In `Inspector.tsx`:

```ts
  const readOnly = multi;
```

Keep `geometryLocked = readOnly || objectActions.locked || objectActions.hidden;` and `sizeLocked` unchanged.

- [ ] **Step 2: Allow resize and rotate**

In `beginResizeSession` (`App.tsx:2059`) and `beginRotateSession` (`:2103`), delete the `selected.path.length !== 1 ||` clause from the early-return condition. Keep `current.selections.length !== 1` so multi-selection still cannot transform.

- [ ] **Step 3: Allow drag**

In the pointer-down handler:

- At `:2717`, replace `if (selected.path.length !== 1) return;` with no early return. Keep the comment block updated to state that any single selection is draggable.
- At `:2735`, delete `candidate.path.length === 1 &&` from the `filter` so nested selections produce drag items.
- Confirm `elementAtPath(frameSlide, candidate.path)` resolves nested paths — it already does.

- [ ] **Step 4: Allow nudging**

At `:2150`, delete `target.path.length === 1 &&` from the `filter`.

At `:2647`, replace the nested-selection guard:

```ts
            if (current.selections.some((target) => target.path.length !== 1)) {
              return;
            }
```

with a multi-selection-free guard that keeps only the existing `current.selections.length > 0` behavior — delete the inner `if` entirely.

- [ ] **Step 5: Render overlay handles for nested selections**

At `:3564`, delete `(selection !== null && selection.path.length > 1)` from the disabled condition so handles render for a single nested selection.

- [ ] **Step 6: Run the existing suite**

Run: `npm run test -w @htmlppt/editor`

Expected: all editor unit tests pass. Geometry unit tests operate on paths and should be unaffected.

- [ ] **Step 7: Commit**

```bash
git add packages/editor/src/App.tsx packages/editor/src/components/Inspector.tsx
git commit -m "feat(editor): allow geometry edits on a single nested selection"
```

---

### Task 2: Pin notice and Undo

**Files:**
- Create: `packages/editor/src/geometry-guards.ts`
- Create: `packages/editor/src/geometry-guards.test.ts`
- Modify: `packages/editor/src/App.tsx` (geometry commit handler; status area)
- Modify: `packages/editor/src/i18n/messages/{en,zh-Hant,zh-Hans}.ts`

**Interfaces:**
- Produces: `willPinToAbsolute(element: Element): boolean`; a one-per-session notice rendered with `data-testid="pin-notice"` and an Undo button that calls the existing undo action.

- [ ] **Step 1: Write the failing test**

Create `packages/editor/src/geometry-guards.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { willPinToAbsolute } from './geometry-guards';

function element(style: string): Element {
  const doc = new DOMParser().parseFromString(
    `<div style="${style}"></div>`,
    'text/html'
  );
  return doc.body.firstElementChild as Element;
}

describe('willPinToAbsolute', () => {
  it('is true for a flow element', () => {
    expect(willPinToAbsolute(element('display:grid'))).toBe(true);
  });

  it('is false for an absolute or fixed element', () => {
    expect(willPinToAbsolute(element('position:absolute;left:0'))).toBe(false);
    expect(willPinToAbsolute(element('position:fixed;top:0'))).toBe(false);
  });
});
```

- [ ] **Step 2: Run RED**

Run: `npm run test -w @htmlppt/editor -- geometry-guards.test.ts`

Expected: FAIL because the module does not exist.

- [ ] **Step 3: Implement the predicate**

Create `packages/editor/src/geometry-guards.ts`:

```ts
/**
 * Mirrors the pin condition in `applyGeometryEdit`: a flow object is converted
 * to absolute positioning by its first position or size edit.
 */
export function willPinToAbsolute(element: Element): boolean {
  const style = (element as HTMLElement).style;
  if (!style) return false;
  return style.position !== 'absolute' && style.position !== 'fixed';
}
```

- [ ] **Step 4: Wire the notice**

In `App.tsx`, near the other editor-only state:

```ts
  const pinNoticeShownRef = useRef(false);
  const [pinNotice, setPinNotice] = useState(false);
```

In the handler passed to the inspector as `onCommitGeometry`, before applying:

```ts
    const element =
      activeSlide && selection
        ? elementAtPath(activeSlide.element, selection.path)
        : null;
    const pinned =
      element !== null && field !== 'rotation' && willPinToAbsolute(element);
```

After a successful edit:

```ts
    if (pinned && !pinNoticeShownRef.current) {
      pinNoticeShownRef.current = true;
      setPinNotice(true);
    }
```

Render next to the existing status region:

```tsx
      {pinNotice ? (
        <div role="status" data-testid="pin-notice" className="flex items-center gap-2 px-2 py-1 text-xs">
          <span>{t('editor.notice.pinned')}</span>
          <button type="button" onClick={() => { actionsRef.current.undo(); setPinNotice(false); }}>
            {t('editor.notice.undo')}
          </button>
          <button type="button" aria-label={t('editor.notice.dismiss')} onClick={() => setPinNotice(false)}>
            ×
          </button>
        </div>
      ) : null}
```

Use the undo action already exposed by the controller (`history.ts` backs it); if the action is named differently in `App.tsx`, call that existing name.

Add locale keys:

```ts
  'editor.notice.pinned': 'This element was positioned by its container; it is now absolutely positioned.',
  'editor.notice.undo': 'Undo',
  'editor.notice.dismiss': 'Dismiss',
```

Provide `zh-Hant` and `zh-Hans` translations for all three.

- [ ] **Step 5: Run GREEN and typecheck**

Run: `npm run test -w @htmlppt/editor -- geometry-guards.test.ts`

Expected: 2 tests pass.

Run: `npm run typecheck -w @htmlppt/editor`

Expected: exit 0.

- [ ] **Step 6: Commit**

```bash
git add packages/editor/src/geometry-guards.ts packages/editor/src/geometry-guards.test.ts \
  packages/editor/src/App.tsx packages/editor/src/i18n/messages
git commit -m "feat(editor): explain and undo flow pinning on nested edits"
```

---

### Task 3: E2E for nested geometry

**Files:**
- Modify: `e2e/drill-in.spec.ts`

**Interfaces:**
- Consumes: the fixture and harness from Phase 1.

- [ ] **Step 1: Add the tests**

```ts
test('drags a nested child, pins it, and persists after reload', async ({ page }) => {
  const editor = await openDeck(page, 'wrapped.deck.html');

  await page.getByRole('button', { name: /Enter pad|進入 pad|进入 pad/ }).click();
  await editor.frame.locator('.pad .foot').click();

  const box = await editor.frame.locator('.pad .foot').boundingBox();
  if (!box) throw new Error('foot has no box');
  await page.mouse.move(box.x + 10, box.y + 10);
  await page.mouse.down();
  await page.mouse.move(box.x + 70, box.y + 50, { steps: 8 });
  await page.mouse.up();

  await expect(page.getByTestId('pin-notice')).toBeVisible();

  const inline = await editor.frame.locator('.pad .foot').getAttribute('style');
  expect(inline).toContain('position: absolute');
  await expect.poll(async () =>
    (await editor.frame.locator('.pad .foot').getAttribute('style')) ?? ''
  ).toContain('left:');

  await editor.reload();
  const after = await editor.frame.locator('.pad .foot').getAttribute('style');
  expect(after).toContain('position: absolute');

  await editor.close();
});

test('pins a grid child without touching the grid parent', async ({ page }) => {
  const editor = await openDeck(page, 'wrapped.deck.html');

  await page.getByRole('button', { name: /Enter pad|進入 pad|进入 pad/ }).click();
  await page.getByRole('button', { name: /Enter cover|進入 cover|进入 cover/ }).click();
  const title = editor.frame.locator('.pad .cover h1');
  await title.click();

  const box = await title.boundingBox();
  if (!box) throw new Error('title has no box');
  await page.mouse.move(box.x + 20, box.y + 20);
  await page.mouse.down();
  await page.mouse.move(box.x + 60, box.y + 60, { steps: 6 });
  await page.mouse.up();

  expect(await title.getAttribute('style')).toContain('position: absolute');
  expect(await editor.frame.locator('.pad .cover').getAttribute('style')).toContain('display: grid');

  await editor.close();
});
```

Use the harness's real reload helper; if it does not expose one, call `page.reload()` and re-acquire the frame through the harness.

- [ ] **Step 2: Run**

Run: `npx playwright test e2e/drill-in.spec.ts --reporter=line`

Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add e2e/drill-in.spec.ts
git commit -m "test(e2e): cover nested drag, pinning, and persistence"
```

---

## Phase Exit Criteria

- A single nested selection supports X/Y/W/H/rotation, drag, resize, and nudge.
- The first flow edit pins to absolute, shows the notice once, and Undo restores the previous inline style.
- The pinned geometry survives autosave and reload.
- Multi-selection and structural commands are unchanged.
- `npm run verify` and the hosted matrix are green before Phase 3 starts.
