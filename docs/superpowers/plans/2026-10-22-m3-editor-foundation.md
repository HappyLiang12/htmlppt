# M3 Editor Foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Turn the M0 two-pane editor into a real canvas editor foundation: selection and transform with snapping, multi-select, thumbnails and sorter, inspector shell, undo/redo, shortcuts, and live sync/autosave/conflict recovery against M2's host.

**Architecture:** A controller hook owns the master `Document`, revision, dirty state, selection, and snapshot history; the iframe remains the rendering surface and is still sandboxed with scripts disabled. Pointer geometry is computed in design pixels from the iframe's scaled rect; transforms are applied inside the iframe and committed through the existing slide-doc cleanup into the master. The overlay (handles, guides, marquee) renders outside the iframe so no editor markup ever enters the deck. History stores whole serialized master snapshots with coalescing. Live sync uses M2's SSE endpoint, an 800 ms autosave debounce, and a reload/overwrite conflict banner.

**Tech Stack:** React 19, Vite 6, Tailwind 4, core DOM APIs, jsdom (new dev dependency), Vitest 3, Playwright.

**Spec:** `docs/superpowers/specs/2026-10-21-html-ppt-editor-design.md` §9 (live updates), §10 (editor), §13; test framework §9–§10.

## Global Constraints

- Node >= 20, ESM, TypeScript strict. No retries, skips, or mocks of host/filesystem/Chromium.
- No editor markup in saved HTML. The iframe keeps `sandbox="allow-same-origin"` only; deck scripts stay inert.
- Geometry math is deterministic and unit-tested in design pixels; the overlay uses screen pixels only for hit-testing.
- Autosave is 800 ms after a commit; saves are serialized and always use the latest revision. A 409 is visible, never silent.
- UI copy Traditional Chinese; code/docs/tests English.
- M3 depends on M2 backend (sessions, SSE, PUT `force`); do not edit host/cli/core outside the explicitly listed M3 additions.
- New dev dependency: `jsdom`. No state-management or geometry libraries.

## File Structure

```
packages/editor/
  package.json                 + jsdom, vitest
  vitest.config.ts             new
  src/geometry.ts              design coords, snapping, rotate, resize
  src/geometry.test.ts
  src/transform.ts             pin/resize/rotate application
  src/transform.test.ts
  src/selection.ts             top-level object model, ids, hit testing helpers
  src/selection.test.ts
  src/history.ts               snapshot stack + coalescing
  src/history.test.ts
  src/use-deck-controller.ts   master document, selection, save, SSE, autosave
  src/live-sync.ts             EventSource client + types
  src/components/Toolbar.tsx   created in Task 4
  src/components/ThumbnailRail.tsx
  src/components/CanvasOverlay.tsx
  src/components/Inspector.tsx
  src/components/SorterView.tsx
  src/App.tsx                  composition
  src/api.ts                   + force save, SSE URL
  src/slide-doc.ts             unchanged except helpers exported as needed
e2e/editor.spec.ts             editor foundation E2E
docs/features.json             editor-core, slides, live-sync active
```

---

### Task 1: Editor test harness and geometry core

**Files:**
- Modify: `packages/editor/package.json`
- Create: `packages/editor/vitest.config.ts`
- Create: `packages/editor/src/geometry.ts`
- Create: `packages/editor/src/geometry.test.ts`
- Modify: root `package.json` `test:unit` to run core and editor unit tests

**Interfaces:**
- `type Rect = { x: number; y: number; width: number; height: number }`.
- `toDesignPoint(clientX, clientY, frame: Rect, scale: number): { x; y }`.
- `frameOfSlide(scale): Rect` is not needed; the caller supplies the iframe rect.
- `snapRect(moving: Rect, targets: Rect[], thresholdDesign: number, bounds: Rect): { rect; guides: Guide[] }` — snap left/center/right and top/middle/bottom to bounds and sibling edges/centers; choose the smallest delta per axis; `Guide { axis: 'x'|'y'; position: number }`.
- `resizeRect(start: Rect, handle: Handle, delta: { dx; dy }, minSize: number): Rect` for the 8 handles; resizing from left/top adjusts origin.
- `rotatePoint(point, center, radians): Point`; `normalizeAngle(degrees): number` in `[0, 360)`.
- `nudge(rect, dx, dy, bounds): Rect` clamps to the slide.

- [ ] **Step 1: Add jsdom and config**

`packages/editor/package.json` devDependencies add `"jsdom": "^26.0.0"`, `"vitest": "^3.0.0"`. `vitest.config.ts` uses `environment: 'jsdom'`, `include: ['src/**/*.test.ts']`, and aliases core/runtime sources like vite.config.

Root `test:unit`: `npm run test -w @htmlppt/core && npm run test -w @htmlppt/editor`.

- [ ] **Step 2: Write failing geometry tests**

Cover:
- pointer conversion at scale 0.5 and 2 (iframe rect offset + scale).
- snap to left/center/right and top/middle/bottom; nearest target wins; threshold in design px; guides list exact positions.
- no snapping beyond the threshold; Alt bypass is a caller concern.
- resize from each handle (east grows width only; west moves x and shrinks width; north moves y; corners adjust both) with `minSize`.
- nudge clamps at slide edges.
- rotation normalization for negative and >360 values.

- [ ] **Step 3: RED/GREEN**

`npm run test -w @htmlppt/editor` → FAIL, implement, then PASS. No DOM needed for these pure functions; jsdom is for later tasks.

- [ ] **Step 4: Commit**

```bash
git add packages/editor package.json package-lock.json
git commit -m "feat(editor): add geometry and snapping core"
```

---

### Task 2: Selection model, controller, and history

**Files:**
- Create: `packages/editor/src/selection.ts`, `selection.test.ts`
- Create: `packages/editor/src/history.ts`, `history.test.ts`
- Create: `packages/editor/src/use-deck-controller.ts`
- Modify: `packages/editor/src/App.tsx` (minimal wiring, behavior unchanged)
- Modify: `packages/editor/src/api.ts` (add `saveDeck(..., { force? })`)

**Interfaces:**
- `SelectionTarget { slideIndex: number; path: number[]; elementId: string | null }`.
- `topLevelObjects(slide: Element): Element[]` — direct children excluding notes/script/style/template/link/meta.
- `selectionFromEvent(eventTarget, slide): SelectionTarget | null` — `slide` is the iframe-rendered slide (same realm as the event target); nearest top-level ancestor; Alt-click returns the deepest element for drill mode (drill state kept separately). `path` is always raw child indices from the slide, not filtered-object indices.
- `History<T> { push(entry: T, options?): void; undo(): T | null; redo(): T | null; canUndo; canRedo; clear() }` — capacity 100; `push` coalesces when `coalesceKey` matches and the previous push is within 500 ms.
- `useDeckController(): { state, actions }` where state includes `master`, `slides`, `activeIndex`, `selection`, `scale`, `status`, `dirty`, `conflict`, and actions include `load`, `showSlide`, `select`, `clearSelection`, `applySlideMutation`, `commit`, `undo`, `redo`, `reload`, `overwrite`.
- History entries are serialized deck strings (whole master). Undo/redo parses into a new master and re-renders the active slide.

- [ ] **Step 1: Write failing selection/history tests (jsdom)**

- top-level detection skips notes and scripts and returns nested group wrappers as one object.
- `selectionFromEvent` on a nested `<span>` returns its top-level ancestor path/id.
- history capacity, undo/redo ordering, clear-on-new-branch after undo+push, coalescing within 500 ms for the same key and not across keys.
- controller load normalizes via core and sets the first slide; `showSlide` clamps.
- Exception (M1 contract): when the loaded deck already contains authored editor-only attributes (`data-ppt-editing`, `data-ppt-frame-slide`), load skips normalization so the host still rejects the invalid deck with 400; normalization must not launder it.

- [ ] **Step 2: RED/GREEN**

Run editor tests. Keep App behavior identical: load deck, edit text on dblclick, save, nav. The controller replaces the ad-hoc refs but the M1 E2E must stay green.

- [ ] **Step 3: Commit**

```bash
git add packages/editor/src packages/editor/src/*.test.ts
git commit -m "feat(editor): add selection controller and history"
```

---

### Task 3: Canvas overlay, selection, drag, resize, rotate

**Files:**
- Create: `packages/editor/src/components/CanvasOverlay.tsx`
- Create: `packages/editor/src/transform.ts`
- Create: `packages/editor/src/transform.test.ts`
- Modify: `packages/editor/src/App.tsx`
- Modify: `packages/editor/src/slide-doc.ts` (export `frameSlideElement` helper if needed)

**Interfaces:**
- `pinToAbsolute(element: Element, rect: Rect): void` — sets `position:absolute; left; top; width; height; margin:0; box-sizing:border-box` on first transform.
- `rectOf(element, slide): Rect` — design-pixel rect from inline/inferred geometry (uses `getBoundingClientRect` inside the iframe and divides by the scale; for authored flow elements this is the current visual box).
- Pointer flow: pointerdown on the iframe → select; drag moves the selected top-level objects; 8 handles resize; rotation handle; Shift snaps rotation to 15°; Alt disables snapping; arrows nudge 1/10 px when focus is not in a text edit.
- During a transform: update the iframe element inline styles and the overlay; guides render for active snaps.
- On pointerup: commit the slide through the controller (one history entry per gesture).

- [ ] **Step 1: Unit-test transform math**

`pinToAbsolute` produces exact inline styles; `rectOf` uses inline geometry and falls back to the measured box; multi-object drag preserves relative offsets; resizing uses the geometry helpers; rotation writes `transform: rotate(Xdeg)` and keeps the center.

- [ ] **Step 2: Write the E2E RED**

`e2e/editor.spec.ts` (tag `@feature:editor-core`):
- Open the template deck; click inside the `h1`; the nearest top-level object is selected and the overlay shows 8 handles and a selection outline.
- Drag the selected top-level object by (100, 50); the inline style has absolute left/top; the file contains the new position after autosave.
- Resize from the east handle; width changes, height does not.
- On a fixture deck whose slide has a movable top-level object, ArrowRight (not editing text) nudges 1 px; Shift+ArrowRight nudges 10 px. Nested selections are read-only: they get no handles and resize/rotate/nudge do nothing.
- Reload preserves the transform.
- With no object selected, arrow keys change slides (existing behavior).

- [ ] **Step 3: RED/GREEN**

Build, run the focused E2E. If the iframe pointer mapping drifts, assert the computed rect in design px rather than screenshot pixels.

- [ ] **Step 4: Commit**

```bash
git add packages/editor e2e
git commit -m "feat(editor): add selection, transforms, and snapping overlay"
```

---

### Task 4: Thumbnails, sorter, and slide operations

**Files:**
- Create: `packages/editor/src/components/ThumbnailRail.tsx`
- Create: `packages/editor/src/components/SorterView.tsx`
- Create: `packages/editor/src/components/Toolbar.tsx`
- Create: `packages/editor/src/slide-ops.ts`, `slide-ops.test.ts`
- Modify: `packages/editor/src/App.tsx`, `src/components/Toolbar.tsx`

**Interfaces:**
- Thumbnail rail renders each slide in a small sandboxed iframe built by `buildSlideSrcDoc`, highlights the active one, scrolls it into view.
- Sorter shows a grid; click selects; drag reorders using `setSlideOrder`; duplicate/delete buttons.
- Toolbar: add slide, duplicate, delete (disabled for the last slide), undo/redo, view toggle Normal/Sorter, Play (M4), Export HTML.
- Slide ops use the controller so each action is one history entry and triggers autosave.

- [ ] **Step 1: Unit tests for slide ops**

Add/duplicate/delete/move via core through the controller; last-slide delete is disabled and cannot fire; undo restores the deleted slide.

- [ ] **Step 2: E2E (tag `@feature:slides`)**

- Thumbnails count equals slides; clicking thumbnail 2 shows slide 2.
- Add slide inserts after the active one and persists.
- Duplicate copies content with a new id; delete removes; sorter drag reorder persists after reload.
- Undo/redo across add/delete/reorder restores exactly.

- [ ] **Step 3: RED/GREEN/commit**

```bash
git add packages/editor e2e docs/features.json
git commit -m "feat(editor): add thumbnails, sorter, and slide operations"
```

---

### Task 5: Inspector shell and slide settings

**Files:**
- Create: `packages/editor/src/components/Inspector.tsx`
- Create: `packages/editor/src/inspector-state.ts`, `inspector-state.test.ts`
- Modify: `packages/editor/src/App.tsx`

**Interfaces:**
- Tabs Design / Text (read-only placeholder until M4) / Notes.
- Objects panel lists top-level objects (tag, id, text summary) and selects them; lock/hide toggles are M4 but the list is navigable now.
- Numeric X/Y/W/H/rotation fields reflect the selected object and commit on blur/Enter.
- Slide settings: transition select (`none|fade|slide`), background color/gradient/image URL (writes inline background through a new controller action), notes textarea (uses `setNotes`).
- No selection → slide settings only.

- [ ] **Step 1: Unit tests**

Inspector derives numeric fields from the selected element; editing X commits one history entry; invalid numbers are rejected without mutation; notes update/remove; background color and image produce the expected inline style.

- [ ] **Step 2: E2E**

Select an object → change X → position persists; switch tabs; edit notes → file has an aside; select transition → attribute persists; object list selects the right element.

- [ ] **Step 3: Commit**

```bash
git add packages/editor e2e
git commit -m "feat(editor): add inspector and slide settings"
```

---

### Task 6: Undo/redo, shortcuts, copy/paste, multi-select

**Files:**
- Modify: `packages/editor/src/use-deck-controller.ts`, `App.tsx`
- Create: `packages/editor/src/shortcuts.ts`, `shortcuts.test.ts`

**Interfaces:**
- Shortcuts per spec: Cmd/Ctrl+Z/Shift+Z, S, Shift+E, D, G/Shift+G (M4 group), +/-, 0, A, C/V, Delete, arrows, Escape, Enter, F5, Shift+F5, `?`.
- Multi-select with Shift+click; marquee only if cheap (optional, not required); align/distribute buttons are M4.
- Copy/paste stores top-level object HTML in memory (not the OS clipboard) and offsets pasted objects by 20 px.
- Shortcut dispatcher ignores key events while a text edit is active or a form control is focused.

- [ ] **Step 1: Unit tests**

Shortcut mapping returns the right action; editable targets are ignored; multi-select toggles and clears; copy/paste round-trips object HTML with new ids; delete removes all selected objects and is one history entry.

- [ ] **Step 2: E2E**

Undo/redo across text edits, transforms, and slide ops; copy/paste object persists; Delete removes; shortcuts do not fire while typing.

- [ ] **Step 3: Commit**

```bash
git add packages/editor e2e
git commit -m "feat(editor): add undo, shortcuts, and multi-select"
```

---

### Task 7: Play mode shell and fullscreen

**Files:**
- Create: `packages/editor/src/components/PlayView.tsx`
- Modify: `packages/editor/src/App.tsx`
- Modify: `e2e/editor.spec.ts`

**Interfaces:**
- Play hides editor chrome, renders the active slide at viewport fit, and supports arrows/space/PageUp/PageDown/Home/End/Escape with the existing transition attributes (visual fade/slide transitions are M4).
- F5 starts at slide 1; Shift+F5 starts at the current slide.
- Presenter view and exported presenter runtime are M4.

- [ ] **Step 1: E2E**

F5 shows chrome-free slide 1; arrows navigate; Escape returns to the same slide; no editor artifacts in the DOM.

- [ ] **Step 2: Commit**

```bash
git add packages/editor e2e
git commit -m "feat(editor): add play mode shell"
```

---

### Task 8: Live sync, autosave, and conflict recovery

**Files:**
- Create: `packages/editor/src/live-sync.ts`, `live-sync.test.ts`
- Modify: `packages/editor/src/use-deck-controller.ts`, `App.tsx`, `api.ts`
- Modify: `packages/host/src/server.ts` only if M2 did not implement PUT `force` (it should; do not duplicate)
- Modify: `e2e/editor.spec.ts`
- Modify: `docs/features.json` (`live-sync` active)

**Interfaces:**
- `openDeckEvents(token): EventSource` on `/api/events?token=...`; events `hello`, `revision` with source.
- On `revision`:
  - if revision equals the local revision → ignore;
  - if clean → fetch the deck and replace master, selection preserved by slide id when possible;
  - if dirty → set `conflict` with `{ revision, source }` and show the banner.
- Autosave: 800 ms after a commit; save queue reads the latest revision; success clears dirty; 409 sets conflict.
- Banner actions: `重新載入` (discard local and fetch) and `覆寫` (PUT with `force: true`).
- Indicator: 已同步 / 儲存中… / 外部更新 / 衝突.
- On unload with unsaved changes, best-effort flush via `navigator.sendBeacon` or a synchronous warning; no data-loss claim without a test.

- [ ] **Step 1: Unit tests**

Event handler pure function: ignore self revisions; clean applies; dirty conflicts; conflict resolution choices clear state; autosave debounce uses fake timers (timer unit only; no network mock).

- [ ] **Step 2: E2E (tag `@feature:live-sync`)**

- External write while clean → editor updates automatically within 2 s; no reload.
- External write while dirty (edit without waiting for autosave) → conflict banner; 重新載入 shows the external deck; 覆寫 writes the local deck with force.
- Autosave: edit, wait, status 已儲存 without pressing anything; file contains the edit.
- Two tabs: tab A saves; tab B edits → conflict; overwrite/reload paths work.
- SSE reconnect after host restart? Host restart changes token/URL; out of scope; document.

- [ ] **Step 3: Full editor gate**

```bash
npm run verify
```

- [ ] **Step 4: Commit**

```bash
git add packages/editor e2e docs/features.json
git commit -m "feat(editor): add live sync, autosave, and conflict recovery"
```

---

## M3 Exit

- `npm run verify` green; all editor E2E pass; feature matrix includes `editor-core`, `slides`, `live-sync`.
- Manual: select/drag/resize/rotate with guides; thumbnails and sorter; inspector; undo/redo; external edit live update; conflict banner.
- Whole-branch review; merge to main; post-merge `npm run verify`.
