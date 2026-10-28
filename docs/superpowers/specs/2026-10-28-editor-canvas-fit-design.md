# Editor canvas fit — design

Date: 2026-10-28
Status: awaiting approval
Branch: `feat/editor-canvas-fit` from `main` 82c84b6

## 1. Problem

Decks whose slide size exists only in CSS (no `data-width`/`data-height`, no
inline size) receive the 1600x900 fallback metadata from `detectSlides`. Play
mode now measures the real slide box (PR #9) and fits that box, but the editor
still builds a metadata-sized stage:

- measured on the QA build: a 1200x900 authored slide inside a 1600x900 canvas
  leaves a 400 px white band on the right in the canvas and in every thumbnail;
- play Fit for the same deck shows no band.

Decks that declare their size (the demo decks and aria-conductor-q declare
1600x900, rich-demo-4x3 declares 1200x900) render with no band today.

The user chose to fix the inner band in the editor canvas and thumbnails,
keeping the play behavior and the 48 px canvas padding unchanged.

## 2. Goals and non-goals

Goals:

- The canvas stage, thumbnail rail, and sorter miniatures crop to the measured
  slide box, matching play Fit.
- Decks whose measured box equals their metadata keep today's geometry.
- No deck-file rewriting: metadata stays as authored.
- Pointer mapping, selection overlay, zoom fit, and text editing keep working
  in the cropped stage.

Non-goals:

- Changing the 48 px canvas padding or the centered stage.
- Changing play Fit/Fill or the presenter.
- Writing `data-width`/`data-height` into the deck file.
- Cropping boxes that overflow their frame: those fall back to metadata.
- Export layout: PNG/PDF render the deck file, not the editor stage.

## 3. Design

### 3.1 Measurement

Reuse `measureSlideBox` from `play-fit.ts` (preview marker plus
`documentElement.clientWidth/Height`), the same measurement play uses.

- Canvas: measure in `onFrameLoad` after `revealPreviewSlide`, store
  `{ id, box }` state, and ignore boxes that `sameBox` considers equal.
- Miniatures: measure in the existing iframe `onLoad` after
  `revealPreviewSlide` and keep per-instance state.
- Fallback when measurement returns null or the id is stale:
  `{ left: 0, top: 0, width: slide.width, height: slide.height }`.

### 3.2 Canvas stage and iframe

With `box` = measured or fallback box and `scale` = current editor zoom:

- stage size: `box.width * scale` x `box.height * scale`;
- iframe keeps `width: slide.width`, `height: slide.height` (authored layout
  must not reflow) and the existing `scale(scale)`, plus
  `translate(-box.left * scale, -box.top * scale)` before the scale;
- stage gains `overflow-hidden` so the cropped band cannot paint outside it.

### 3.3 Invariants that keep editing correct

- Selection boxes are already slide-relative (`slideOffsetOf` plus
  `rectOf(element, slide)`), so they align with the cropped stage origin.
- Pointer mapping reads `frame.getBoundingClientRect()`, which includes the
  translate, and `outerDesignPoint` subtracts the slide rect, so design
  coordinates are unchanged.
- Zoom fit uses the measured box dimensions instead of `slide.width/height`,
  keeping the 48 px margins.
- The transition preview overlay is stage-local (`inset-0`) and follows the
  cropped stage.

### 3.4 Miniatures

`SlideMiniature` keeps its fixed display width (152 px in the rail, 320 px in
the sorter). After measurement:

- container height = `box.height * (width / box.width)`;
- iframe scale = `width / box.width`;
- iframe translate = `-box.left * scale`, `-box.top * scale`.

Before measurement the miniature renders with the metadata box, so the first
paint matches today.

### 3.5 Lifecycle and failure

- Slide switch, commit reload, and document open all fire the iframe `onLoad`,
  which re-measures; stale measurements are ignored by slide id.
- A null measurement (root outside the viewport, zero size, NaN) keeps the
  metadata fallback and never throws.
- Measurement is per session only; nothing is persisted or written back.

## 4. Acceptance criteria

- **ECF-AC1** A CSS-only 1200x900 deck (no metadata) renders in the canvas with
  a 4:3 stage; the slide root's screen rect equals the stage rect within 1 px,
  and no white band is visible. Thumbnail and sorter miniatures show the same
  crop.
- **ECF-AC2** A deck declaring 1600x900 and one declaring 1200x900 keep today's
  stage geometry (no visual regression).
- **ECF-AC3** In the cropped canvas, clicking a text object selects it at the
  correct design point (formatting strip opens), and a drag of N screen pixels
  moves the object by N / scale design pixels; the selection overlay aligns
  with the element.
- **ECF-AC4** Zoom fit uses the measured box and keeps the 48 px margins.
- **ECF-AC5** A box that cannot be measured (root spilling outside the frame)
  falls back to metadata with no console error.
- **ECF-AC6** Saving after an edit still produces HTML without
  `data-ppt-preview-slide`, reveal styles, or editor attributes.

## 5. Testing

Unit (Vitest, `packages/editor`):

- a pure helper that resolves the stage box (measured vs metadata fallback) and
  the crop transform (translate values, scale, miniature height);
- `sameBox` gating and stale-id rejection.

E2E (`e2e/editor-canvas-fit.spec.ts`, tag `@feature:editor-canvas-fit`):

- CSS-only 4:3 fixture: canvas stage ratio, slide-root screen rect equals the
  stage rect, thumbnail crop, sorter crop, single-click selection, one save
  with clean HTML;
- metadata fixture: stage equals the declared size scaled, unchanged.

Manual QA on the built dist: the CSS-only deck plus rich-demo-4x3,
aria-conductor-q, and rich-demo at 1440x900; verify canvas, thumbnails, sorter,
selection, Fit/Fill, and export.

## 6. Risks

- Measurement lands one frame after first paint, so the canvas and miniatures
  may shift once on load; the initial metadata render keeps the change small.
- Cropping hides content that a slide draws outside its own box; play already
  crops the same way, and unmeasurable overflow falls back to metadata.
- Transformed slide roots measure post-transform; the stage follows the painted
  box, consistent with play.
