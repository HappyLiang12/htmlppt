# Drill-in Editing Phase 1: Editing Context Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let the editor enter a layout container so its direct children become selectable objects, with a visible breadcrumb and Esc to leave.

**Architecture:** `containerPath: number[]` is editor-only UI state; selection paths stay absolute from the slide root. Pure helpers in `selection.ts` resolve clicks and double-clicks relative to the current container, so the existing absolute-path mutation layer is untouched. The inspector lists the container's children instead of the slide's, and a breadcrumb shows the level.

**Tech Stack:** React 19, TypeScript, Vitest, Playwright.

**Spec:** `docs/superpowers/specs/2026-10-25-nested-container-editing-design.md` (Goals, Decisions, Behavior > Entering and leaving / Selection)

## Global Constraints

- No new attributes, ids, or `data-ppt-el` values are written into decks by this phase.
- Top-level object semantics and MCP targets do not change.
- `data-ppt-group` is unrelated; never create or rewrite it here.
- UI copy goes into the typed locale catalog (`en`, `zh-Hant`, `zh-Hans`); no hardcoded strings.
- Nested selections stay single until Phase 2 enables their geometry.
- RED first, then GREEN, then commit. Do not weaken existing selection tests.
- Branch + PR only; push and PR need per-round authorization.

---

## File Structure

- Modify `packages/editor/src/selection.ts`: context-aware click resolution and context entry helpers.
- Modify `packages/editor/src/selection.test.ts`: pure helper coverage.
- Modify `packages/editor/src/App.tsx`: context state, enter/leave wiring, breadcrumb.
- Modify `packages/editor/src/components/Inspector.tsx`: object list from the context container, enter affordance.
- Modify `packages/editor/src/inspector-state.ts`: summarize a supplied container.
- Modify `packages/editor/src/i18n/messages/*.ts`: context labels.
- Create `test-utils/fixtures/wrapped.deck.html`: wrapper-style fixture.
- Create `e2e/drill-in.spec.ts`: real-browser enter/leave.

---

### Task 1: Context-aware selection helpers

**Files:**
- Modify: `packages/editor/src/selection.ts`
- Test: `packages/editor/src/selection.test.ts`

**Interfaces:**
- Produces: `SelectionFromEventOptions.containerPath?: readonly number[]`; `selectionFromEvent` resolves clicks to the context container's direct children; `contextEntry(slide: Element, target: Element, containerPath: readonly number[]): number[] | null`; `describeContextSegment(element: Element): string`.

- [ ] **Step 1: Write the failing tests**

Add to `packages/editor/src/selection.test.ts`:

```ts
import { contextEntry, describeContextSegment, selectionFromEvent } from './selection';

function build(): Element {
  const doc = new DOMParser().parseFromString(
    `<section data-slide-id="s1">
       <div class="halo"></div>
       <div class="pad">
         <div class="cover"><h1>Title</h1><p>Sub</p></div>
         <p class="foot">Footer</p>
       </div>
     </section>`,
    'text/html'
  );
  return doc.querySelector('section') as Element;
}

describe('editing context', () => {
  it('selects the context container child, not the slide-level wrapper', () => {
    const slide = build();
    const h1 = slide.querySelector('h1') as Element;

    const selected = selectionFromEvent(h1, slide, { containerPath: [1] });

    expect(selected?.path).toEqual([1, 0]);
  });

  it('keeps absolute paths for alt-click inside a context', () => {
    const slide = build();
    const h1 = slide.querySelector('h1') as Element;

    const selected = selectionFromEvent(h1, slide, {
      containerPath: [1],
      altKey: true
    });

    expect(selected?.path).toEqual([1, 0, 0]);
  });

  it('enters the nearest container with children', () => {
    const slide = build();
    const cover = slide.querySelector('.cover') as Element;

    expect(contextEntry(slide, cover, [])).toEqual([1, 0]);
  });

  it('does not enter a leaf element', () => {
    const slide = build();
    const foot = slide.querySelector('.foot') as Element;

    expect(contextEntry(slide, foot, [1])).toBeNull();
  });

  it('describes a context segment by class, then tag', () => {
    const slide = build();

    expect(describeContextSegment(slide.querySelector('.pad') as Element)).toBe('.pad');
    expect(describeContextSegment(slide.querySelector('h1') as Element)).toBe('h1');
  });
});
```

- [ ] **Step 2: Run RED**

Run: `npm run test -w @htmlppt/editor -- selection.test.ts`

Expected: FAIL because the helpers and option do not exist.

- [ ] **Step 3: Implement**

In `packages/editor/src/selection.ts`:

```ts
export interface SelectionFromEventOptions {
  slideIndex?: number;
  /** Alt-click drills into the deepest element instead of its top-level object. */
  altKey?: boolean;
  /** Entered container path; clicks select that container's direct children. */
  containerPath?: readonly number[];
}

function ancestorWithin(element: Element, container: Element): Element | null {
  let current: Element = element;
  let parent = current.parentElement;
  while (parent && parent !== container) {
    current = parent;
    parent = current.parentElement;
  }
  return parent === container ? current : null;
}

export function contextEntry(
  slide: Element,
  target: Element,
  containerPath: readonly number[]
): number[] | null {
  const container = elementAtPath(slide, containerPath);
  if (!container || !container.contains(target)) return null;
  const child = ancestorWithin(target, container);
  if (!child || child.children.length === 0) return null;
  const index = Array.from(container.children).indexOf(child);
  return index === -1 ? null : [...containerPath, index];
}

export function describeContextSegment(element: Element): string {
  const firstClass = element.getAttribute('class')?.trim().split(/\s+/)[0];
  return firstClass ? `.${firstClass}` : element.tagName.toLowerCase();
}
```

Rewrite the body of `selectionFromEvent` to route through the context:

```ts
export function selectionFromEvent(
  eventTarget: EventTarget | null,
  slide: Element,
  options: SelectionFromEventOptions = {}
): SelectionTarget | null {
  const element = asElement(eventTarget);
  if (!element || element === slide || !slide.contains(element)) return null;

  const slideIndex = options.slideIndex ?? 0;
  const containerPath = options.containerPath ?? [];
  const container = elementAtPath(slide, containerPath);
  if (!container || !container.contains(element) || element === container) {
    return null;
  }

  const contextChild = ancestorWithin(element, container);
  if (!contextChild || !isObjectElement(contextChild)) return null;
  const index = Array.from(container.children).indexOf(contextChild);
  if (index === -1) return null;

  if (options.altKey) {
    const relative = pathTo(element, container);
    if (!relative) return null;
    return {
      slideIndex,
      path: [...containerPath, ...relative],
      elementId: elementIdOf(element)
    };
  }

  return {
    slideIndex,
    path: [...containerPath, index],
    elementId: elementIdOf(contextChild)
  };
}
```

Delete the now-unused `topLevelAncestor` helper. Keep `topLevelObjects`, `elementAtPath`, and `pathTo` as they are: `topLevelObjects` still drives the slide-level list.

- [ ] **Step 4: Run GREEN**

Run: `npm run test -w @htmlppt/editor -- selection.test.ts`

Expected: all selection tests pass, including the existing top-level and alt-click cases with `containerPath` absent.

- [ ] **Step 5: Commit**

```bash
git add packages/editor/src/selection.ts packages/editor/src/selection.test.ts
git commit -m "feat(editor): resolve selections relative to an editing context"
```

---

### Task 2: Context state, enter and leave, breadcrumb

**Files:**
- Modify: `packages/editor/src/App.tsx` (pointer-down selection call around `:2695`; frame dblclick handler around `:2806`; toolbar render block)
- Modify: `packages/editor/src/i18n/messages/en.ts`, `zh-Hant.ts`, `zh-Hans.ts`
- Test: covered by `e2e/drill-in.spec.ts` in Task 4 plus the pure tests in Task 1

**Interfaces:**
- Consumes: `contextEntry`, `describeContextSegment`, `elementAtPath`.
- Produces: `containerPath` state; Enter/double-click enters; Esc and breadcrumb leave; selection is cleared on every context change; state resets on slide or deck change.

- [ ] **Step 1: Add the state and reset rules**

In `App.tsx` component state:

```ts
  const [containerPath, setContainerPath] = useState<number[]>([]);
```

Reset it wherever `activeIndex` or the master deck changes:

```ts
  useEffect(() => {
    setContainerPath([]);
  }, [activeIndex, master]);
```

Also clear it when the current path no longer resolves:

```ts
  useEffect(() => {
    if (containerPath.length === 0) return;
    if (!activeSlide || !elementAtPath(activeSlide.element, containerPath)) {
      setContainerPath([]);
    }
  }, [activeSlide, containerPath]);
```

- [ ] **Step 2: Pass the context into click selection**

At `App.tsx:2695`:

```ts
      const selected = selectionFromEvent(target, frameSlide, {
        slideIndex: current.activeIndex,
        altKey: event.altKey,
        containerPath
      });
```

- [ ] **Step 3: Enter on double-click of a container**

In the frame `dblclick` handler (`App.tsx:2806-2818`), after the existing text-leaf checks return, add:

```ts
      const next = contextEntry(frameSlide, target, containerPath);
      if (next) {
        event.preventDefault();
        setContainerPath(next);
        actionsRef.current.clearSelection();
      }
```

Text leaves keep winning: the handler already returns after starting text editing.

- [ ] **Step 4: Enter on Enter, leave on Esc**

Add a document-level key handler that runs while a context is active and stops the event so the shortcut layer does not clear or move slides:

```ts
  useEffect(() => {
    if (containerPath.length === 0) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        setContainerPath((path) => path.slice(0, -1));
        actionsRef.current.clearSelection();
      }
    };
    document.addEventListener('keydown', onKeyDown, true);
    return () => document.removeEventListener('keydown', onKeyDown, true);
  }, [containerPath]);
```

Use the same capture-phase registration style as the other keyboard effects in this file.

- [ ] **Step 5: Render the breadcrumb**

Add near the stage header, using the existing locale hook and tokens:

```tsx
      {containerPath.length > 0 && activeSlide ? (
        <nav
          data-testid="edit-context"
          aria-label={t('editor.context.label')}
          className="flex items-center gap-1 px-2 py-1 text-xs text-secondary"
        >
          <button type="button" onClick={() => { setContainerPath([]); actionsRef.current.clearSelection(); }}>
            {t('editor.context.slide')}
          </button>
          {containerPath.map((_, depth) => {
            const path = containerPath.slice(0, depth + 1);
            const element = elementAtPath(activeSlide.element, path);
            return (
              <Fragment key={path.join('.')}>
                <span aria-hidden="true">›</span>
                <button type="button" onClick={() => { setContainerPath(path); actionsRef.current.clearSelection(); }}>
                  {element ? describeContextSegment(element) : t('editor.context.unknown')}
                </button>
              </Fragment>
            );
          })}
        </nav>
      ) : null}
```

Add `import { Fragment } from 'react';` if the file does not already import it.

- [ ] **Step 6: Add locale keys**

In each of `en.ts`, `zh-Hant.ts`, `zh-Hans.ts`:

```ts
  'editor.context.label': 'Editing context',
  'editor.context.slide': 'Slide',
  'editor.context.unknown': 'Unknown',
```

Use `編輯脈絡` / `投影片` / `未知` for `zh-Hant` and `编辑上下文` / `幻灯片` / `未知` for `zh-Hans`.

- [ ] **Step 7: Typecheck and commit**

Run: `npm run typecheck -w @htmlppt/editor`

Expected: exit 0.

```bash
git add packages/editor/src/App.tsx packages/editor/src/i18n/messages
git commit -m "feat(editor): enter and leave layout containers"
```

---

### Task 3: Inspector lists the context container's children

**Files:**
- Modify `packages/editor/src/inspector-state.ts` (`summarizeObjects` call site)
- Modify: `packages/editor/src/components/Inspector.tsx` (object list, enter affordance)
- Modify `packages/editor/src/App.tsx` (pass the context element and an enter handler)
- Test: `packages/editor/src/inspector-state.test.ts`

**Interfaces:**
- Consumes: `containerPath`, `contextEntry`.
- Produces: `InspectorProps.contextPath?: readonly number[]` and `InspectorProps.onEnterContext?: (path: number[]) => void`; object rows come from the context container's direct children.

- [ ] **Step 1: Write the failing test**

Add to `packages/editor/src/inspector-state.test.ts`:

```ts
it('summarizes the direct children of a container with index and hasChildren', async () => {
  const { summarizeObjects } = await import('./inspector-state');
  const doc = new DOMParser().parseFromString(
    `<section data-slide-id="s1">
       <div class="pad"><h1>Title</h1><p>Body</p><div><span>nested</span></div></div>
     </section>`,
    'text/html'
  );
  const container = doc.querySelector('.pad') as Element;

  const objects = summarizeObjects(container);

  expect(objects.map((object) => object.tag)).toEqual(['H1', 'P', 'DIV']);
  expect(objects.map((object) => object.index)).toEqual([0, 1, 2]);
  expect(objects.map((object) => object.hasChildren)).toEqual([false, false, true]);
});
```

- [ ] **Step 2: Run RED**

Run: `npm run test -w @htmlppt/editor -- inspector-state.test.ts -t "index and hasChildren"`

Expected: FAIL because the summary type does not expose `index` or `hasChildren`.

- [ ] **Step 3: Wire the inspector**

In `Inspector.tsx`, change the object source:

```ts
  const contextElement = slide
    ? elementAtPath(slide.element, contextPath ?? []) ?? slide.element
    : null;
  const objects = contextElement ? summarizeObjects(contextElement) : [];
```

Add the enter affordance to each row that has element children:

```tsx
                    {object.hasChildren ? (
                      <button
                        type="button"
                        aria-label={t('editor.context.enter', { name: object.tag.toLowerCase() })}
                        onClick={() => onEnterContext?.([...(contextPath ?? []), object.index])}
                      >
                        ›
                      </button>
                    ) : null}
```

`summarizeObjects` must expose `index` and `hasChildren` in its summary type; add both in `inspector-state.ts` where the summary is built (`index` is the child index inside the summarized element, `hasChildren` is `element.children.length > 0`).

- [ ] **Step 4: Pass props from `App.tsx`**

```tsx
              contextPath={containerPath}
              onEnterContext={(path) => {
                setContainerPath(path);
                actionsRef.current.clearSelection();
              }}
```

Add the locale key `editor.context.enter` = `Enter {name}` / `進入 {name}` / `进入 {name}`.

- [ ] **Step 5: Run GREEN and typecheck**

Run: `npm run test -w @htmlppt/editor -- inspector-state.test.ts`

Expected: pass.

Run: `npm run typecheck -w @htmlppt/editor`

Expected: exit 0.

- [ ] **Step 6: Commit**

```bash
git add packages/editor/src/inspector-state.ts packages/editor/src/components/Inspector.tsx \
  packages/editor/src/App.tsx packages/editor/src/i18n/messages \
  packages/editor/src/inspector-state.test.ts
git commit -m "feat(editor): list container children in the inspector"
```

---

### Task 4: Fixture, E2E, and docs

**Files:**
- Create `test-utils/fixtures/wrapped.deck.html`
- Create `e2e/drill-in.spec.ts`
- Modify `README.md`, `docs/contract.md`, `docs/architecture.md`

**Interfaces:**
- Produces: a fixture that reproduces the wrapper pattern and E2E proof that enter/leave works.

- [ ] **Step 1: Create the fixture**

`test-utils/fixtures/wrapped.deck.html` must be a valid `htmldeck/v1` deck whose first slide mirrors the measured shape: two decorative siblings plus one wrapper that holds all content.

```html
<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><title>Wrapped deck</title></head>
<body>
<main data-ppt-deck>
  <section class="slide" data-slide-id="s1" data-width="1600" data-height="900" style="position:relative;width:1600px;height:900px">
    <div class="halo" data-ppt-el="e1" style="position:absolute;inset:0;background:#eef"></div>
    <div class="staff" data-ppt-el="e2" style="position:absolute;right:40px;top:40px;width:120px;height:4px;background:#345"></div>
    <div class="pad" data-ppt-el="e3" style="position:absolute;left:80px;top:80px;width:1200px">
      <div class="cover" style="display:grid;grid-template-columns:1fr 1fr;gap:24px">
        <h1 style="font-size:72px;margin:0">Wrapped title</h1>
        <p style="font-size:28px;margin:0">Body copy</p>
      </div>
      <p class="foot" style="margin-top:32px">Footer</p>
    </div>
  </section>
</main>
</body>
</html>
```

Validate it before committing:

Run: `npx htmlppt validate test-utils/fixtures/wrapped.deck.html`

Expected: `Deck is valid.`

- [ ] **Step 2: Write the E2E**

Create `e2e/drill-in.spec.ts`, reusing the existing editor harness from `e2e/helpers.ts`:

```ts
import { expect, test } from '@playwright/test';
import { openDeck } from './helpers';

test('enters a layout container and lists its children', async ({ page }) => {
  const editor = await openDeck(page, 'wrapped.deck.html');

  // Slide level: .halo, .staff, .pad
  await expect(page.getByTestId('object-row')).toHaveCount(3);

  await page.getByRole('button', { name: /Enter pad|進入 pad|进入 pad/ }).click();
  await expect(page.getByTestId('edit-context')).toContainText('.pad');
  await expect(page.getByTestId('object-row')).toHaveCount(2);

  await page.getByRole('button', { name: /Enter cover|進入 cover|进入 cover/ }).click();
  await expect(page.getByTestId('edit-context')).toContainText('.cover');
  await expect(page.getByTestId('object-row')).toHaveCount(2);

  await page.keyboard.press('Escape');
  await expect(page.getByTestId('edit-context')).toContainText('.pad');
  await expect(page.getByTestId('edit-context')).not.toContainText('.cover');

  await page.keyboard.press('Escape');
  await expect(page.getByTestId('edit-context')).toBeHidden();
  await expect(page.getByTestId('object-row')).toHaveCount(3);

  // Precedence: a text leaf still starts text editing inside a context.
  await page.getByRole('button', { name: /Enter pad|進入 pad|进入 pad/ }).click();
  await editor.frame.getByText('Wrapped title').dblclick();
  await expect(editor.frame.locator('h1[contenteditable="true"]')).toHaveCount(1);

  await editor.close();
});
```

Use the helper's actual exported names and returned frame handle; if `openDeck` returns a different shape, adapt only the harness call, never the assertions.

- [ ] **Step 3: Run the E2E**

Run: `npm run build && npx playwright test e2e/drill-in.spec.ts --reporter=line`

Expected: PASS. Add `data-testid="object-row"` to the inspector row element if it is missing.

- [ ] **Step 4: Update docs**

- `README.md`: describe drill-in editing in one paragraph after the editor section.
- `docs/contract.md`: state that top-level children remain the object model, that containers are enterable in the editor, and that drill-in writes no attributes.
- `docs/architecture.md`: add `containerPath` to editor state.

- [ ] **Step 5: Full gate**

Run: `npm run verify`

Expected: all suites pass.

- [ ] **Step 6: Commit**

```bash
git add test-utils/fixtures/wrapped.deck.html e2e/drill-in.spec.ts README.md \
  docs/contract.md docs/architecture.md
git commit -m "test(e2e): cover entering layout containers"
```

---

## Phase Exit Criteria

- A click inside an entered container selects that container's direct child.
- Escape and the breadcrumb change level; state resets on slide and deck changes.
- The inspector lists the container's children and offers an enter affordance.
- No deck written by this phase gains new attributes.
- `npm run verify` and the hosted matrix are green before Phase 2 starts.
