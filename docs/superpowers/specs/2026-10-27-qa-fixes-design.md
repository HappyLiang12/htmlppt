# QA fixes after the 2026-10-27 independent QA round — design

- Date: 2026-10-27
- Status: Proposed (spec gate)
- Base: `origin/main` at `e3bf160`
- Provenance: local QA report `.superpowers/qa/qa-report.md`; reproduction fixture
  `D:\project\tmp\htmlppt-manual\qa-active-script.html`

## 1. Context

An independent QA round reproduced three user-visible defects in the shipped
editor. This spec fixes them in three independent areas:

1. **F1 — blank non-first slides.** `buildSlideSrcDoc` clones one slide and its
   ancestors, and preview iframes are script-free. A deck that hides
   non-current slides with `.active`, `hidden`, or inline `display:none` and
   reveals them from JavaScript renders slide 1 only; later slides are blank in
   the canvas, thumbnails, presenter preview, and built-in play. PNG/PDF export
   already has a reveal pass (`packages/renderer/src/layout.ts`), which is why
   exports of the same deck render every page.
2. **F2 — play does not fill the viewport.** Play is an aspect-fit letterbox by
   contract, but two avoidable sources of empty space remain: a slide sized only
   by CSS is measured against the 1600×900 detection fallback, and the built-in
   play has no cover mode and does not refit on `fullscreenchange`.
3. **F3 — text formatting has no visible entry.** Every requested command
   exists (bold, italic, underline, strike, colour, highlight, font family,
   font size, alignment, line height, lists, link, clear), but the toolbar
   mounts only during an inline editing session started by a canvas
   double-click or Enter on a selected object. The Inspector Text tab is a
   placeholder whose copy points at a toolbar that is not visible yet. There is
   no Ctrl/Cmd+B/I/U shortcut.

Approved decisions from the design discussion:

- F1: iframe reveal pass (option A). No deck scripts and no file rewriting.
- F2: Fit + Fill control, default Fit; measured play box; fullscreen refit.
- F3: formatting strip on single selection; functional Inspector Text tab;
  Ctrl/Cmd+B/I/U.

## 2. Goals and non-goals

### Goals

- Preview every slide of a deck that hides non-current slides with a class,
  attribute, or inline style, without executing authored scripts.
- Make the built-in play view remove inner empty bands, refit correctly, and
  offer an explicit Fill mode that covers the viewport.
- Make text formatting discoverable and usable from a cold start with one
  click, and add keyboard shortcuts for the basic commands.
- Keep saved/exported HTML free of preview-only state.

### Non-goals

- Executing deck scripts in the editor or the built-in play.
- Rewriting user deck files on import.
- Fixing JS-painted content, canvas/chart content generated at load, or
  animation-keyframe-only reveals. These require script execution and belong
  to a separate decision (F1 option B in the QA report).
- Changing the exported runtime or renderer contract. The Fill control is
  editor-play-only; exported decks keep aspect-fit.
- Changing the editor canvas or thumbnail sizing. They stay metadata-based
  because selection overlays, geometry inputs, snapping, and insertion depend
  on a stable canvas size.
- Adding new text commands. The existing command set is reused.
- Release, version, tag, or publish changes. The local
  `chore/release-0.1.0` branch stays separate.

## 3. F1 — reveal state-hidden slides in previews

### 3.1 Preview marker

`packages/editor/src/slide-doc.ts` gains:

```ts
export const PREVIEW_SLIDE_ATTRIBUTE = 'data-ppt-preview-slide';
```

`buildSlideSrcDoc` sets this attribute on the cloned slide root for every
render, including thumbnails and play previews where `markFrame` is false. For
the body fallback (`slide.element.tagName === 'BODY'`), the generated `<body>`
tag carries the attribute. The marker is separate from the existing
`data-ppt-frame-slide` token, which must keep its current single-consumer
rotation behaviour.

### 3.2 Reveal helper

New module `packages/editor/src/frame-reveal.ts`:

```ts
export function revealPreviewSlide(frameDocument: Document): Element | null;
```

It runs in the parent realm against a same-origin preview iframe. It must not
use `instanceof HTMLElement` or `instanceof CSSStyleRule` on iframe-realm
nodes; use `Element` methods, `tagName`, and `frameDocument.defaultView` for
computed styles.

The helper is idempotent and performs these steps:

1. Resolve the slide root:
   `frameDocument.querySelector('[data-ppt-preview-slide]') ??
   frameDocument.body`. Return `null` when neither exists.
2. Build the chain from the slide root up to `document.documentElement`.
3. Snapshot whether the slide root was hidden before any mutation:
   `root.hasAttribute('hidden') || computedDisplay(root) === 'none'`.
4. For every element in the chain: remove `hidden`; remove inline hiding
   declarations (`display: none`, `visibility: hidden|collapse`,
   `opacity: 0`, `content-visibility: hidden`).
5. If the slide root was hidden in step 3, add the `active` class to it. This
   mirrors the renderer reveal pass and covers `.slide { display:none }` /
   `.slide.active { display:flex }` decks.
6. If an element's computed `display` is still `none`, temporarily remove
   matching `display: none` declarations from same-origin stylesheet rules
   (`frameDocument.styleSheets`), read the resulting computed `display`,
   restore the removed declarations, and set the element's inline `display` to
   that value with `!important`. When no non-`none` value can be resolved, use
   `block`. Cross-origin stylesheet access is caught per sheet.
7. When computed `visibility` is not `visible`, `opacity` is `0`, or
   `content-visibility` hides the element, force `visible`, `1`, and
   `visible` respectively with inline `!important`.
8. Do not change position, transform, margins, padding, width, or height.
   Geometry normalization is outside F1; off-canvas and transformed slides
   remain a documented limitation.
9. Return the resolved slide root.

Only the slide root and its ancestors are touched. Authored hiding of content
inside the slide is preserved.

### 3.3 Commit isolation

`commitSlide` must never persist preview-only state. For element slides:

1. Clone the frame slide.
2. Remove every attribute from the clone.
3. Copy the authored attributes from the current master slide element
   (`slide.element`), which was re-detected at commit time.
4. Keep the frame clone's `innerHTML` so text edits survive.
5. Serialize with `slide.element.outerHTML = clone.outerHTML`.

This drops the frame token, the preview marker, the reveal-added `active`
class, and reveal inline styles, while preserving authored classes and
attributes. Body-fallback slides keep the existing behaviour: only
`frameSlide.innerHTML` is copied, so body-level reveal mutations never reach
the master.

The editor does not support changing the slide root's attributes through any
other path; slide background, transition, and object edits mutate the master
directly. The restoration rule is therefore safe for current features.

### 3.4 Call sites

- `App.tsx` canvas `onFrameLoad`: call `revealPreviewSlide(frameDocument)`
  before `setFrameEpoch(...)`, so overlay geometry measures the revealed
  layout.
- `components/ThumbnailRail.tsx` `SlideMiniature` iframe `onLoad`: reveal the
  frame. Presenter thumbnails reuse this component.
- `components/PlayView.tsx` `handleLoad`: reveal before measuring and before
  installing key/click listeners.

No other consumer builds preview iframes directly.

### 3.5 Limitations

- Content painted by deck JavaScript is still absent because scripts do not
  run.
- Animation or keyframe-only reveals of the slide root are handled only at the
  root; inner animated children may remain at their initial state.
- Slides moved off-canvas with transforms or absolute positioning are not
  normalized.
- Cross-origin stylesheets that hide a slide cannot be inspected; the
  marker/inline/`hidden` paths still apply.

### 3.6 Acceptance criteria

- **F1-AC1** Given a deck whose non-current slides use `.slide {display:none}`
  plus `.slide.active {display:flex}` and a script that toggles `active`, when
  the editor opens and the user selects slide 2, the canvas, thumbnail, and
  built-in play all show slide 2's authored content.
- **F1-AC2** Given the same deck, when slide 2 is displayed, the authored
  script has not run: its DOM side effect marker is absent in the preview
  frame.
- **F1-AC3** Given slides hidden with the `hidden` attribute or inline
  `style="display:none"`, the same reveal applies in canvas, thumbnail, and
  play.
- **F1-AC4** Given a revealed slide, when the user edits its text and the deck
  saves, the saved HTML contains neither `data-ppt-preview-slide` nor a
  reveal-added `active` class nor reveal inline styles; authored root
  attributes on every slide are unchanged.
- **F1-AC5** Given the four manual decks in the QA set, all pages still render
  in canvas, play, and export; no regression in their current layout.

## 4. F2 — Fit/Fill and the measured play box

### 4.1 Fit modes

`PlayView` gains a two-button segmented control in a top-right controls group.
The existing Presenter button moves into that group so both controls share one
fixed container and focus order:

- `Fit` (`data-testid="play-fit"`): current aspect-fit letterbox.
- `Fill` (`data-testid="play-fill"`): cover the viewport and crop the
  overflow.

The group has `role="group"` and a localized accessible name. Each button has
`aria-pressed` reflecting the active mode. The default is Fit. The selection is
stored in `localStorage` under `htmlppt.play-fit` with values `fit` and `fill`;
an invalid or unavailable store falls back to Fit. Storage access is wrapped in
`try/catch` so file-origin and blocked-storage environments still work.

### 4.2 Measured content box

New module `packages/editor/src/play-fit.ts` keeps the helpers pure and
unit-testable:

```ts
export type PlayFitMode = 'fit' | 'fill';

export interface SlideBox {
  left: number;
  top: number;
  width: number;
  height: number;
}

export function measureSlideBox(frameDocument: Document): SlideBox | null;
export function scaleFor(
  box: SlideBox,
  viewport: { width: number; height: number },
  mode: PlayFitMode
): number;
```

`measureSlideBox` resolves the preview marker or body, reads
`getBoundingClientRect()`, and returns `null` when any value is non-finite or
the width/height is not positive. It also returns `null` when the box extends
beyond the iframe's `documentElement.clientWidth/clientHeight` by more than one
pixel; such content is clipped by the iframe viewport and must fall back to the
metadata size rather than expose a blank region.

`scaleFor` returns `Math.min(viewport.width / box.width, viewport.height /
box.height)` for Fit and `Math.max(...)` for Fill. Invalid values fall back to
scale 1.

The measurement resolves the same preview marker introduced by F1; the plan
orders F1 before F2.

The iframe viewport is never resized from measured content. This avoids
feedback loops for `vw`, `vh`, and percentage-sized decks. The measured box is
adopted only for the stage and the iframe transform.

### 4.3 Layout math

Let `box` be the measured box (or `{left:0, top:0, width:slide.width,
height:slide.height}` when measurement is unavailable), `v` the current
viewport, and `s = scaleFor(box, v, mode)`.

- Stage width: `box.width * s`.
- Stage height: `box.height * s`.
- Iframe CSS width/height: the slide metadata `slide.width` / `slide.height`.
- Iframe transform: `translate(-box.left * s, -box.top * s) scale(s)` with
  `transformOrigin: 'top left'`.
- Stage: `overflow: hidden` so the iframe area outside the measured box is
  clipped.
- Shell: existing fixed, centered, `overflow: hidden` black surface. In Fill
  mode the stage is larger than the viewport and the shell crops it; in Fit
  mode the stage fits and the shell supplies letterbox bars.

This keeps the stage aligned to the authored content box and removes the inner
band caused by a wrong metadata fallback or a centered CSS-sized slide.

### 4.4 Measurement lifecycle

- On every iframe `load`, after reveal, measure the box and store it together
  with the current `slide.id`. A different slide id resets to metadata until
  its load measures.
- Observe the slide root with `ResizeObserver` and re-measure when its box
  changes. Disconnect the previous observer on reload and unmount.
- Store viewport `{width: window.innerWidth, height: window.innerHeight}` in
  state. Update it on `resize` and `fullscreenchange`; both listeners are
  removed on unmount.
- Ignore measured changes smaller than 0.5 px to avoid render loops.

### 4.5 Contract and limits

- `docs/contract.md` is updated to state that the built-in editor play offers
  Fit (default) and Fill; the exported runtime and standalone deck keep
  aspect-fit.
- The editor canvas and thumbnails remain metadata-based. A CSS-only deck may
  still show an inner band in the canvas preview; this is a documented
  limitation of this round.
- Content that genuinely overflows the metadata iframe viewport is not
  recovered; the measured box falls back to metadata.

### 4.6 Acceptance criteria

- **F2-AC1** Given a deck whose slide is 1200×900 by CSS only (no
  `data-width`/`data-height`, no inline size), when play opens, the stage aspect
  ratio is 4:3 within 1%, and the slide content is fully visible with no inner
  empty band.
- **F2-AC2** Given a 4:3 deck in a 16:9 viewport, Fit shows pillarboxing with
  the stage height equal to the viewport height within 1 px; Fill makes the
  stage cover the viewport (stage width ≥ viewport width − 1 px and stage
  height ≥ viewport height − 1 px).
- **F2-AC3** The Fit/Fill choice survives exiting and re-entering play in the
  same browser context; a new context defaults to Fit.
- **F2-AC4** A `fullscreenchange` (and a viewport resize) recomputes the scale
  without reloading the slide; the stage still matches the active mode.
- **F2-AC5** The Presenter button stays visible and clickable in both modes,
  and clicking chrome does not advance the slide.

## 5. F3 — visible text formatting entry

### 5.1 Shared text target resolver

New module `packages/editor/src/text-target.ts`:

```ts
export type TextTargetBlockReason = EditHintReason | 'not-active';

export type TextTargetResult =
  | { status: 'editable'; leaf: HTMLElement; empty: boolean }
  | { status: 'blocked'; reason: TextTargetBlockReason };

export function resolveSelectedTextTarget(
  slide: Element,
  path: readonly number[]
): TextTargetResult;
```

Rules:

- Resolve the selected element with `elementAtPath` using the slide-rooted
  selection path, the same helper `startTextEditing` uses today.
- Reject a locked, hidden, or grouped top-level ancestor with that reason
  (`topLevelBlockFor`).
- Reject a locked, hidden, or grouped ancestor between the selected element and
  its top-level ancestor, including the selected element itself. This closes
  the current nested-guard gap and makes Enter, Edit text, and the selection
  toolbar agree.
- Resolve the primary leaf exactly as `startTextEditing` does today: the
  selected element when it matches `TEXT_EDITABLE_SELECTOR`, otherwise its
  first matching descendant, requiring `isLeafTextElement`.
- When no leaf is found, return `blocked` with the reason from
  `textEditBlockFor(selected)` or `not-text`.
- `empty` is true when the leaf's trimmed `textContent` is empty.
- The resolver does not check selection count, slide index, or editing state;
  callers do and map those cases to the Text panel's UI-only states
  (`multi` / `idle`) before calling it.

`startTextEditing` is refactored to use this resolver. Its current tag,
leaf, and empty-text rules stay; nested guards now reject the edit. Empty
`DIV`, `TD`, and `TH` remain editable; other empty semantic elements are not.

### 5.2 Selection formatting toolbar

`TextToolbar` gains an optional `mode: 'editing' | 'selection'` prop (default
`editing`) and renders `data-mode`. The host div gains `role="toolbar"` and an
`aria-label` from the locale catalog. The leading label is
`t('text.group')` in editing mode and `t('text.selection')` in selection mode.
Buttons, menus, test ids, and `aria-pressed` behavior are unchanged.

The toolbar is visible when all of these hold:

- The editor has exactly one selection on the active slide.
- No inline editing session is active.
- The resolver returns `editable`.
- `empty` is false.

It appears without moving focus. The toolbar is removed when the selection is
cleared, multi-selected, guarded, edited in place, or the slide changes.

Selection-mode state is derived with
`readTextToolbarState(frameDocument, leaf, null)`: no range means the leaf
itself is the style anchor. State is recomputed after selection changes, frame
loads, commits, and slide changes.

### 5.3 Selection-mode commands

A format command in selection mode:

1. Calls `actionsRef.current.settlePendingEdits()`; abort if it returns false.
2. Re-resolves the target from the current state and frame; abort if it is no
   longer editable.
3. Clears any stale iframe range with
   `frameDocument.getSelection()?.removeAllRanges()`, so `commandRange` selects
   the whole leaf instead of a leftover partial range.
4. Calls the existing `applyTextCommand(frameDocument, leaf, command, null)`.
5. On success, calls `commitFrame()` and lets the existing controller/history
   path persist one undo entry.
6. On command error, keeps the error in the selection toolbar state and does
   not commit. A commit failure is surfaced by the existing save status.

Commands are serialized with a busy guard: a second selection-mode command is
ignored until the previous commit resolves. Link uses the existing prompt and
scheme validation; invalid links throw before mutation and show the toolbar
error.

Selection mode applies to the resolver's primary leaf. Objects with multiple
text leaves format that leaf; the Text tab states the target so the scope is
not surprising. Whole-object formatting across every leaf is not part of this
round.

### 5.4 Inspector Text tab

The placeholder is removed. The panel props gain a text action summary:

```ts
interface InspectorTextAction {
  status: 'idle' | 'editable' | 'blocked' | 'multi';
  canEdit: boolean;
  canFormat: boolean;
  reason?: EditHintReason | 'not-active';
}
```

The panel renders:

- No selection: localized hint asking the user to select a text object.
- Single selection with `canEdit`: a visible `Edit text` button
  (`data-testid="inspector-edit-text"`) plus a hint that the toolbar above
  formats the selected text. The hint includes the first 40 characters of the
  target leaf, ellipsized, so a wrapper object's primary-leaf scope is
  explicit. The button calls the same `startTextEditing` path and is keyboard
  operable.
- Empty editable leaf: the button remains; the formatting strip stays hidden
  until text exists.
- Blocked selection: the localized reason from `editor.hint.*`; no button.
- Multi-selection: a localized "select one object" hint; no button.

`data-testid="text-placeholder"` is removed. All tests that asserted the
placeholder are rewritten to assert the new idle/edit states; no test is
skipped or loosened.

### 5.5 Keyboard shortcuts

Ctrl/Cmd+B, Ctrl/Cmd+I, and Ctrl/Cmd+U map to bold, italic, and underline when
a text target is active:

- In an editing session, apply to the current selection or collapsed caret.
- In selection mode, apply to the whole resolved leaf through the same command
  path as the toolbar.
- Ignore `Alt` and `Shift` combinations and ignore key repeat.
- Ignore events whose target is an input, textarea, select, or a
  contenteditable outside the canvas editing frame, so notes and inspector
  fields keep their native behavior.
- `preventDefault` when handled, to stop native contenteditable toggling and
  browser shortcuts from double-applying.
- Both the parent document listener and the canvas frame listener handle the
  shortcuts, because key events do not cross the iframe boundary.
- `ShortcutsDialog` gains B/I/U entries in a text group. All three locale
  catalogs get the labels.

### 5.6 Copy and accessibility

- The Inspector Design tab's object alignment control is relabeled
  "Align object" (localized) so it is not confused with text alignment.
- The selection toolbar has `role="toolbar"`, an accessible name, and no focus
  theft.
- Buttons keep their existing labels and `aria-pressed`; menu triggers keep
  keyboard Escape behavior.
- The `Edit text` button has a visible focus ring and works with Enter/Space.
- Selection-mode formatting does not change the editor's live-region
  announcement behavior.

### 5.7 Acceptance criteria

- **F3-AC1** Given a fresh editor, when the user single-clicks a text object,
  the formatting toolbar is visible with `data-mode="selection"`, and clicking
  Bold applies bold to the object's text and persists it to the saved HTML.
- **F3-AC2** Given a single text selection, the Inspector Text tab shows a
  working `Edit text` button; activating it enters inline editing, the toolbar
  switches to `data-mode="editing"`, and typed text saves.
- **F3-AC3** Given a single text selection, Ctrl/Cmd+B applies bold; given an
  inline editing session with a partial selection, Ctrl/Cmd+I applies italic
  only to the selected characters; both persist.
- **F3-AC4** A keyboard-only path selects a text object through the objects
  panel, opens the Text tab, activates `Edit text`, edits text, and commits
  without using the mouse.
- **F3-AC5** A locked, hidden, grouped, or nested-guarded selection shows the
  localized reason, no formatting toolbar, and no enabled `Edit text` button.
- **F3-AC6** A multi-selection shows no formatting toolbar and a "select one
  object" hint.
- **F3-AC7** An empty text box shows no formatting toolbar but offers
  `Edit text`; after typing and committing, selecting it again shows the
  formatting toolbar.
- **F3-AC8** The Text tab no longer shows a placeholder that points at an
  invisible toolbar; every state has actionable or explanatory copy.

## 6. Testing

### 6.1 Unit

- `slide-doc.test.ts`: the preview marker is present for `markFrame` true and
  false and for the body fallback; `commitSlide` strips the marker and
  reveal-added root attributes for element slides and preserves authored
  attributes.
- `frame-reveal.test.ts`: covered where jsdom's computed style supports it
  (`hidden`, inline hiding); class-rule and CSSOM neutralization are covered by
  E2E because they need real cascade/layout.
- `text-target.test.ts`: primary leaf resolution, wrapper with a single leaf,
  nested guard, top-level guard, empty DIV/TD/TH versus empty semantic tags,
  and no leaf. The caller's multi/idle states are covered by E2E.
- `play-fit.test.ts`: Fit/Fill scale math, invalid boxes, and storage
  parsing/defaults.
- `shortcuts.test.ts`: B/I/U mapping with Ctrl and Meta, rejection with
  Alt/Shift, key repeat, and input-target exclusion.

### 6.2 E2E

- New `e2e/preview-reveal.spec.ts` with `@feature:preview-reveal`: a fixture
  containing class-hidden, `hidden`, and inline-hidden slides plus a script
  side-effect marker. Assert editor canvas, thumbnail, and play render each
  slide; assert the script marker is absent; assert a save after reveal does
  not persist preview attributes.
- New `e2e/play-fit.spec.ts` with `@feature:play-fit`: CSS-only 4:3 box
  measurement, Fit/Fill geometry, persistence across play sessions, and
  fullscreen/resize refit.
- New `e2e/text-entry.spec.ts` with `@feature:text-entry`: cold-start single
  click, Text tab Edit text, Ctrl/Cmd+B/I/U in both modes, keyboard-only path,
  guarded/empty/multi states, and persistence.
- Update `e2e/a11y.spec.ts`: the formatting toolbar is first reached by a
  single click (selection mode), then by double-click (editing mode); assert
  role, name, and `aria-pressed`.
- Update `e2e/editor.spec.ts` placeholder assertions (currently lines 2208,
  2606, and 2627) to assert the idle hint or `Edit text` button according to
  the fixture's selection state.
- Assert no preview iframe executes authored scripts in the new F1 test.

### 6.3 Feature matrix

Add to `docs/features.json`:

- `preview-reveal` — spec `QA fixes 2026-10-27`
- `play-fit` — spec `QA fixes 2026-10-27`
- `text-entry` — spec `QA fixes 2026-10-27`

Each active feature must have at least one `@feature:<id>` test or
`npm run test:matrix` fails.

### 6.4 Manual verification

- Use the QA fixture and the four manual decks. Check canvas, thumbnails,
  play, presenter preview, and PNG/PDF export.
- Verify saved HTML after reveal contains no preview-only attributes.
- Verify Fit/Fill in a wide and a narrow window, and after fullscreen.
- Verify the cold-start mouse path and the keyboard-only path.
- Capture screenshots for the final report.

### 6.5 Gates

Every phase follows the repository gate: RED test first, implementation,
module-level tests, full `npm run verify` on the final HEAD, then a green
hosted CI matrix before the next phase. Local green is not a release claim.
Build and verify run sequentially.

## 7. Risks and mitigations

| Risk | Mitigation |
| --- | --- |
| Reveal adds `.active` or inline styles to the live frame | Commit restores root attributes from the master; E2E asserts saved HTML is clean |
| CSSOM scan hits a cross-origin sheet | Catch per sheet; marker/inline/`hidden` paths still work |
| `.active` triggers an authored transition on the preview | Reveal is clone-only; tests cover the QA fixture and manual decks |
| Measured box causes a resize feedback loop | Never resize the iframe viewport from measured content; crop/translate only |
| Measured box overflows the iframe | Fall back to metadata when the box exceeds the iframe viewport |
| Selection toolbar formats the wrong leaf in a wrapper | Resolver reuses the Enter path; Text tab states the target; wrapper scope is documented |
| Nested guards previously editable via Enter | Resolver rejects them; add an E2E case and update any affected tests |
| Native contenteditable handles Ctrl+B twice | `preventDefault` on handled shortcuts; test both modes |
| localStorage unavailable | `try/catch`, default Fit |
| Flaky pixel assertions | Use ratio/tolerance and `expect.poll`; real browser E2E |

## 8. Delivery gates

1. Spec approval (this document).
2. Plan approval: `docs/superpowers/plans/2026-10-27-qa-fixes.md`.
3. Execute approval for the approved plan.

Implementation branch: `feat/qa-fixes` from `origin/main` `e3bf160`. The local
`chore/release-0.1.0` branch (`3c3497d`) stays separate and is not included.
No push, tag, publish, or merge happens without explicit authorization; the
user performs merges. A red CI matrix is not merged.

## 9. File inventory

### New

- `packages/editor/src/frame-reveal.ts`
- `packages/editor/src/frame-reveal.test.ts`
- `packages/editor/src/text-target.ts`
- `packages/editor/src/text-target.test.ts`
- `packages/editor/src/play-fit.ts`
- `packages/editor/src/play-fit.test.ts`
- `e2e/preview-reveal.spec.ts`
- `e2e/play-fit.spec.ts`
- `e2e/text-entry.spec.ts`

### Modified

- `packages/editor/src/slide-doc.ts` and `slide-doc.test.ts`
- `packages/editor/src/App.tsx`
- `packages/editor/src/components/ThumbnailRail.tsx`
- `packages/editor/src/components/PlayView.tsx`
- `packages/editor/src/components/Inspector.tsx`
- `packages/editor/src/components/TextToolbar.tsx`
- `packages/editor/src/components/ShortcutsDialog.tsx`
- `packages/editor/src/shortcuts.ts` and `shortcuts.test.ts`
- `packages/editor/src/i18n/messages/en.ts`
- `packages/editor/src/i18n/messages/zh-Hant.ts`
- `packages/editor/src/i18n/messages/zh-Hans.ts`
- `e2e/editor.spec.ts`
- `e2e/a11y.spec.ts`
- `docs/contract.md`
- `docs/features.json`
