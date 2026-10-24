# Drill-in Editing Phase 4: Edit Feedback and Accessibility Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace silent double-click failures and misleading nested-selection hints with specific, actionable copy, and make drill-in fully keyboard reachable.

**Architecture:** A pure `textEditBlockFor(element)` module explains why a double-click cannot edit, mirroring the existing tag, leaf, and empty-text rules. The frame double-click handler surfaces the reason in a dismissible hint. The inspector distinguishes "this object is editable" from "structural commands are top-level only", and the breadcrumb plus handles are keyboard operable.

**Tech Stack:** React 19, TypeScript, Vitest, Playwright.

**Spec:** `docs/superpowers/specs/2026-10-25-nested-container-editing-design.md` (Behavior > Feedback, Accessibility)

## Global Constraints

- Copy lives in the typed locale catalog (`en`, `zh-Hant`, `zh-Hans`).
- No silent no-ops: every rejected gesture gets a visible reason.
- No new dependencies, no new attributes in decks.
- RED first, then GREEN, then commit.
- Branch + PR only; push and PR need per-round authorization.

---

## File Structure

- Create `packages/editor/src/text-edit-block.ts` and `.test.ts`.
- Modify `packages/editor/src/App.tsx` (double-click handler, hint UI, announcements).
- Modify `packages/editor/src/components/Inspector.tsx:128-135`, `:940-950` (hints).
- Modify `packages/editor/src/i18n/messages/{en,zh-Hant,zh-Hans}.ts`.
- Modify `test-utils/fixtures/wrapped.deck.html` (add a button for the rejection case).
- Modify `e2e/drill-in.spec.ts`, `README.md`.

---

### Task 1: Explainable text-edit rejection

**Files:**
- Create: `packages/editor/src/text-edit-block.ts`
- Create: `packages/editor/src/text-edit-block.test.ts`

**Interfaces:**
- Produces: `type TextEditBlock = 'not-text' | 'has-children' | 'empty'`; `textEditBlockFor(target: Element): TextEditBlock | null`.

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, it } from 'vitest';
import { textEditBlockFor } from './text-edit-block';

function pick(html: string, selector: string): Element {
  const doc = new DOMParser().parseFromString(html, 'text/html');
  return doc.querySelector(selector) as Element;
}

describe('textEditBlockFor', () => {
  it('rejects elements outside the text tag contract', () => {
    expect(textEditBlockFor(pick('<button>Go</button>', 'button'))).toBe('not-text');
    expect(textEditBlockFor(pick('<a href="#">Go</a>', 'a'))).toBe('not-text');
    expect(textEditBlockFor(pick('<svg><text>x</text></svg>', 'text'))).toBe('not-text');
  });

  it('rejects a layout div that has element children', () => {
    expect(textEditBlockFor(pick('<div><span>a</span></div>', 'span'))).toBe('has-children');
  });

  it('rejects an empty semantic element', () => {
    expect(textEditBlockFor(pick('<h1></h1>', 'h1'))).toBe('empty');
  });

  it('accepts a text leaf and an empty div', () => {
    expect(textEditBlockFor(pick('<h1>Title</h1>', 'h1'))).toBeNull();
    expect(textEditBlockFor(pick('<div></div>', 'div'))).toBeNull();
  });
});
```

- [ ] **Step 2: Run RED**

Run: `npm run test -w @htmlppt/editor -- text-edit-block.test.ts`

Expected: FAIL because the module does not exist.

- [ ] **Step 3: Implement**

```ts
export type TextEditBlock = 'not-text' | 'has-children' | 'empty';

const TEXT_TAGS = new Set([
  'H1', 'H2', 'H3', 'P', 'LI', 'SPAN', 'TD', 'TH', 'BLOCKQUOTE', 'FIGCAPTION', 'DIV'
]);

export const TEXT_EDITABLE_SELECTOR =
  'h1, h2, h3, p, li, span, td, th, blockquote, figcaption, div';

/**
 * Mirrors the double-click guard: the clicked node is resolved to its nearest
 * text tag, then rejected when it is a layout div, empty, or outside the
 * contract. Null means the caller may start editing.
 */
export function textEditBlockFor(target: Element): TextEditBlock | null {
  const candidate = target.closest(TEXT_EDITABLE_SELECTOR);
  if (!(candidate instanceof HTMLElement) || !TEXT_TAGS.has(candidate.tagName)) {
    return 'not-text';
  }
  if (
    candidate.tagName === 'DIV' &&
    !Array.from(candidate.children).every((child) => child.tagName === 'BR')
  ) {
    return 'has-children';
  }
  if (
    !candidate.textContent?.trim() &&
    candidate.tagName !== 'DIV' &&
    candidate.tagName !== 'TD' &&
    candidate.tagName !== 'TH'
  ) {
    return 'empty';
  }
  return null;
}
```

- [ ] **Step 4: Run GREEN**

Run: `npm run test -w @htmlppt/editor -- text-edit-block.test.ts`

Expected: 4 tests pass.

- [ ] **Step 5: Commit**

```bash
git add packages/editor/src/text-edit-block.ts packages/editor/src/text-edit-block.test.ts
git commit -m "feat(editor): name why a double-click cannot edit text"
```

---

### Task 2: Surface the reason

**Files:**
- Modify `packages/editor/src/App.tsx` (frame double-click handler `:2806-2818`; notice area)
- Modify `packages/editor/src/i18n/messages/{en,zh-Hant,zh-Hans}.ts`

**Interfaces:**
- Consumes: `textEditBlockFor`, `TEXT_EDITABLE_SELECTOR`.
- Produces: `data-testid="edit-hint"` with localized copy, auto-dismissed after 6 seconds.

- [ ] **Step 1: Replace the silent early returns**

In the double-click handler, replace the tag/leaf/empty guard block with:

```ts
      const block = textEditBlockFor(target);
      if (block) {
        setEditHint(block);
        return;
      }
```

Keep the existing locked/hidden/group checks and the text-editing start after this block.

Import `TEXT_EDITABLE_SELECTOR` from `./text-edit-block` and delete the local constant so there is one source of truth.

- [ ] **Step 2: Render the hint**

```tsx
  const [editHint, setEditHint] = useState<TextEditBlock | null>(null);

  useEffect(() => {
    if (editHint === null) return;
    const timer = window.setTimeout(() => setEditHint(null), 6_000);
    return () => window.clearTimeout(timer);
  }, [editHint]);
```

```tsx
      {editHint ? (
        <div role="status" data-testid="edit-hint" className="flex items-center gap-2 px-2 py-1 text-xs">
          <span>{t(`editor.hint.${editHint}` as MessageKey)}</span>
          <button type="button" aria-label={t('editor.notice.dismiss')} onClick={() => setEditHint(null)}>
            ×
          </button>
        </div>
      ) : null}
```

Use the existing message-key type import in `App.tsx`; if `MessageKey` is not imported, type the key map explicitly instead of casting.

- [ ] **Step 3: Add locale keys**

```ts
  'editor.hint.not-text':
    'Only text elements edit inline. Double-click a container background to enter it.',
  'editor.hint.has-children':
    'This element has children. Enter the container, then edit its text.',
  'editor.hint.empty':
    'This element has no text yet. Add text through the Text tools first.',
```

Translate for `zh-Hant` and `zh-Hans`; keep the JSON-free typed object shape used by the catalog.

- [ ] **Step 4: Run typecheck and tests**

Run: `npm run typecheck -w @htmlppt/editor && npm run test -w @htmlppt/editor`

Expected: exit 0 and all editor unit tests pass.

- [ ] **Step 5: Commit**

```bash
git add packages/editor/src/App.tsx packages/editor/src/i18n/messages
git commit -m "feat(editor): show why a double-click cannot edit"
```

---

### Task 3: Honest inspector hints

**Files:**
- Modify `packages/editor/src/components/Inspector.tsx:390-396`, `:940-950`
- Modify `packages/editor/src/i18n/messages/{en,zh-Hant,zh-Hans}.ts`

**Interfaces:**
- Produces: the nested read-only hint is gone; a nested selection instead shows that structural commands are top-level only; multi-selection keeps its existing hint.

- [ ] **Step 1: Replace the hint selection**

```ts
  const nested = selection !== null && selection.path.length > 1;
  const hint = multi
    ? t('inspector.multiHint', { count: selectionCount })
    : nested
      ? t('inspector.nestedStructuralHint')
      : objectActions.locked
        ? t('inspector.lockedHint')
        : objectActions.group
          ? t('inspector.groupHint')
          : null;
```

Render `hint` where the old read-only block rendered, and delete the `inspector.nestedHint` usage.

- [ ] **Step 2: Update the catalog**

Remove `inspector.nestedHint` from all three catalogs and add:

```ts
  'inspector.nestedStructuralHint':
    'Position, size, appearance, and text apply to this object. Duplicate, delete, and reorder act on top-level objects only.',
```

Translate for `zh-Hant` and `zh-Hans`.

- [ ] **Step 3: Typecheck**

Run: `npm run typecheck -w @htmlppt/editor`

Expected: exit 0. A missing or extra key fails typechecking because the dictionaries are typed by `MessageKey`.

- [ ] **Step 4: Commit**

```bash
git add packages/editor/src/components/Inspector.tsx packages/editor/src/i18n/messages
git commit -m "fix(editor): replace the stale nested read-only hint"
```

---

### Task 4: Keyboard reachability, fixture, E2E, docs, phase gate

**Files:**
- Modify `test-utils/fixtures/wrapped.deck.html`
- Modify `e2e/drill-in.spec.ts`
- Modify `README.md`, `docs/contract.md`

- [ ] **Step 1: Add a non-text element to the fixture**

Inside `.pad .cover`, add:

```html
        <button class="cta" type="button" style="font-size:24px">Start</button>
```

Re-validate: `npx htmlppt validate test-utils/fixtures/wrapped.deck.html` → `Deck is valid.`

- [ ] **Step 2: Add the E2E**

```ts
test('explains a rejected double-click and stays keyboard operable', async ({ page }) => {
  const editor = await openDeck(page, 'wrapped.deck.html');

  await editor.frame.getByRole('button', { name: 'Start' }).dblclick();
  await expect(page.getByTestId('edit-hint')).toBeVisible();
  await expect(page.getByTestId('edit-hint')).toContainText(/text elements|文字|文本/);

  await page.getByRole('button', { name: /Enter pad|進入 pad|进入 pad/ }).focus();
  await page.keyboard.press('Enter');
  await expect(page.getByTestId('edit-context')).toContainText('.pad');

  await page.keyboard.press('Escape');
  await expect(page.getByTestId('edit-context')).toBeHidden();

  await editor.close();
});
```

- [ ] **Step 3: Run the suite**

Run: `npx playwright test e2e/drill-in.spec.ts --reporter=line`

Expected: all drill-in tests pass.

- [ ] **Step 4: Document and run the full gate**

- `README.md`: list the drill-in gestures (chevron or container background to enter, Esc to leave, text leaves still edit inline) and note that structural commands stay top-level.
- `docs/contract.md`: state that no drill-in action writes attributes.

Run: `npm run verify`

Expected: all suites pass.

- [ ] **Step 5: Commit, push the branch, open the PR**

```bash
git add test-utils/fixtures/wrapped.deck.html e2e/drill-in.spec.ts README.md docs/contract.md
git commit -m "test(e2e): cover edit feedback and keyboard drill-in"
git push -u origin feat/drill-in-editing
gh pr create --title "feat: edit nested elements inside layout containers" --body-file pr-body.md
```

Write `pr-body.md` at the repository root with the summary and test plan, create the PR, then delete the file before any further commit; never commit it.

Wait for the hosted matrix on the newest run to be green before proposing a merge.

---

## Phase Exit Criteria

- Every rejected double-click shows a specific reason; no silent no-ops remain.
- The stale "Nested selections are read-only" hint is gone from all three locales.
- Drill-in is fully keyboard operable: focus, Enter on the chevron, Esc to leave.
- `npm run verify` is green locally and the hosted matrix is green at the pushed HEAD.
