# HTML Deck Editor — Design Spec

Date: 2026-10-21
Status: approved for planning
Project root: `html-ppt-editor`

## 1. Problem and goal

Users generate presentation decks as static HTML with an AI agent. Updating such a deck by hand (or by re-prompting the agent) is slow and error-prone. This project is a browser-based, PowerPoint-like editor that:

1. Imports an existing static HTML deck.
2. Lets the user edit slides visually (move, resize, rotate, restyle text, insert content, manage slides).
3. Exports a static HTML file that renders identically, stays readable, and can be re-imported or handed back to an agent for further edits.

The editor is a pure client-side web app. No backend, no accounts, no telemetry. Files stay on the user's machine.

### Non-goals (v1)

- Per-character rich-text formatting (bold/color on a text selection). Text styles apply to the whole text element.
- Authoring animations or transitions. Existing CSS animations are preserved but frozen while editing.
- Tables, charts, or video editing.
- Cloud storage, accounts, real-time collaboration.
- Zip/folder projects, relative asset rewriting.
- JS-driven decks (reveal.js-style navigation, runtime layout measurement).
- Speaker notes, presenter view, PDF export.

## 2. Deck contract

Agent-generated decks SHOULD follow this contract. The importer tolerates deviations with warnings, but fidelity and edit reliability are best when the contract is met.

- One self-contained HTML file.
- Each slide is a `<section class="slide" data-slide-id="s1">` (unique id) with a fixed design size in CSS pixels, declared via `data-width` / `data-height` or CSS. Recommended canvas: 1600 × 900.
- Slides are stacked vertically in normal document flow. No `position: fixed` slides, no scroll-driven layouts.
- Layout is static; no JavaScript is required to position content.
- CSS animations and transitions are allowed. They are preserved on export.
- Assets are inline (`data:`) or absolute URLs. Relative local assets are not supported in v1 and produce an import warning.
- Content inside a slide may be arbitrary HTML/CSS, but only direct children of the slide are freely transformable (see 6.2).

Example:

```html
<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <style>
    .slide { width: 1600px; height: 900px; background: #fff; position: relative; overflow: hidden; }
  </style>
</head>
<body>
  <section class="slide" data-slide-id="s1" style="width:1600px;height:900px">
    <h1>Title</h1>
  </section>
  <section class="slide" data-slide-id="s2" style="width:1600px;height:900px">
    <p>Second slide</p>
  </section>
</body>
</html>
```

## 3. Import

### Slide detection

Run in order; first match wins:

1. Elements with `[data-slide-id]`.
2. Elements matching `.slide`, `.page`, `.slide-page`.
3. Direct children of the most common parent that are `<section>` elements.
4. Fallback: the document body is treated as a single slide. Slide add/reorder/delete are disabled; editing still works. A warning is shown.

Slides without `data-slide-id` receive generated ids (`s1`, `s2`, …) persisted into the document. Ids are kept on export and are the stable key for selection, history, and round-trips.

### Canvas size

Per slide, in order: `data-width`/`data-height` attributes; inline `style` width/height; computed style; default 1600 × 900. Different slide sizes are supported. A deck with mixed sizes triggers an informational warning.

Normalization applied to the master document on import:

- Ensure each slide has inline `position: relative` when computed position is `static`, so absolutely positioned children resolve against the slide in both the editor and the exported file.
- Assign missing `data-slide-id`.
- No other markup or style mutation.

### Diagnostics report

Collected during import, shown as a dismissible banner with a details dialog:

- Slide count and size mismatches.
- Relative asset references (`src`, `href`, `url()` not `data:`, `http:`, `https:`, `#`).
- Presence of `<script>` tags (preserved but disabled during editing and playback).
- `position: fixed` / `100vh`-style layout hints.
- `<canvas>` or other runtime-rendered content.

Warnings never block import.

## 4. Architecture

Single-page React app, no backend.

```
src/
  app/        shell, routing-free layout, keyboard shortcuts, dialogs
  deck/       loader, slide detection, canvas inference, master document, normalization
  frame/      per-slide iframe rendering, fit scaling, srcdoc build, slide sync, thumbnails
  editor/     selection, transform, snapping, text editing, commands, history
  ui/         toolbar, thumbnail rail, canvas, inspector, play mode, import report
  persist/    File System Access, IndexedDB autosave, export
tests/        unit tests (Vitest)
e2e/          Playwright tests
examples/     fixture decks (contract, messy, animated, external assets)
docs/         this spec, deck contract, agent instructions
```

### Master document

The parsed original HTML is the single source of truth, held as an inert `Document` (`DOMParser`). Editing never regenerates the whole file:

- The active slide is rendered in a sandboxed iframe built from the master `<head>` plus that slide's markup.
- On every committed edit, a cleaned clone of the iframe slide replaces the corresponding element in the master document.
- Slide-level operations (add, duplicate, reorder, delete) are applied directly to the master document.

### Data flow

1. Open file or drag-drop → parse to master → detect slides → normalize → build model → render.
2. Render active slide → build `srcdoc` = master head clone + editor base style + slide markup → load into iframe.
3. User gesture → editor overlay converts screen coordinates to design coordinates → command mutates iframe DOM → history snapshot → sync to master → refresh thumbnail (debounced) → autosave (debounced).
4. Save/export → serialize master document → write to file or download.
5. Re-import exports cleanly, with stable slide/object ids.

### Slide iframe

- `sandbox="allow-same-origin"` only. Scripts never execute. DOM access is available to the editor.
- Iframe viewport equals the slide's design size; the iframe element is CSS-scaled to fit the canvas area (`transform: scale(fitScale)`), so pointer coordinates inside the iframe are design pixels.
- Injected base style (iframe only, never exported):

```css
html, body { margin: 0 !important; padding: 0 !important; overflow: hidden !important; background: transparent !important; }
[data-slide-id="<active-id>"] { margin: 0 !important; }
```

The active slide is always addressed by its generated `data-slide-id` selector, so nested slide containers are normalized too. Ancestor-specific selectors from the original deck may not match in the single-slide iframe; this is a documented tolerance limit.

- Iframe height is the slide height; width is the slide width. No editor classes or attributes are added to deck elements (selection chrome is drawn in an overlay outside the iframe).

### Thumbnails

- Lazy per-slide iframes, built from the master head plus a single slide, wrapped in a scale container (target width ~160 px). Rendered only when near the viewport (IntersectionObserver).
- Thumbnails refresh on edit commit for the active slide (debounced 300 ms) and after undo/redo/slide ops.

## 5. Editor model

### 5.1 Objects and selection

- An object is a direct child of the slide. Click selects the nearest object under the pointer.
- Shift+click toggles multi-selection (objects only).
- Alt+click drills directly to the nested element under the pointer.
- Double-click enters text editing when the target contains text; otherwise it drills into the nested element for style editing.
- Nested selections show box geometry as read-only with a "Detach to slide" action.
- Escape steps out: text editing → nested selection → object selection → none.
- Clicking empty slide area clears selection.

### 5.2 Transform (top-level objects only)

On the first transform of an object:

1. Compute its bounding rect relative to the slide's padding box (accounting for slide border and padding).
2. Read the computed rotation from its transform matrix.
3. Write inline geometry: `position:absolute; left; top; width; height; margin:0; box-sizing:border-box;` plus `transform: rotate(θdeg)` when θ ≠ 0.
4. Discard non-rotation transform components after baking them into width/height (documented limitation).

Drag moves `left`/`top`; eight resize handles update width/height and left/top; the rotation handle updates `transform`. Resize applies to a single selection. Multi-selection supports group move, align, and distribute only. Shift while rotating snaps to 15°.

Nested elements cannot be transformed while nested. "Detach to slide" clones the element with its computed styles inlined, positions it absolutely on the slide, and selects it.

### 5.3 Snapping and guides

- Candidates: slide left/center/right, top/middle/bottom, and the edges/centers of other top-level objects.
- Threshold: 6 screen pixels, converted to design pixels by `6 / fitScale`.
- Alt temporarily disables snapping.
- Alignment guides render in the overlay (1 px accent line).

### 5.4 Text editing

- Double-click a text-bearing element inside an object → set `contenteditable="true"` on it. Inline spans are preserved.
- Paste inserts plain text only. Enter inserts a line break.
- Commit on Escape, click outside, or Cmd/Ctrl+Enter. The `contenteditable` attribute is removed from the synced clone.
- During text editing, transform keyboard shortcuts are disabled; undo/redo still works.
- Text styles apply to the whole text element via the inspector: font family, size, weight (400/600/700), italic, underline, color, text-align, line-height.

### 5.5 Box styling

Inspector writes inline styles: background color, border width/style/color, border-radius, opacity, z-order (bring forward/backward/front/back within the slide). For nested selections, the same style options are available; geometry is read-only.

With nothing selected, the inspector shows slide background color (inline `background-color` on the slide) and read-only canvas size.

### 5.6 Insert

All inserted elements are direct children of the active slide, get a `data-ppt-el` id and `data-ppt-type`, use inline styles only (no editor classes), and are selected after insert:

- Text box: 320 × 60 initially, immediate text editing; empty text boxes are removed on commit.
- Image: file picker, embedded as a data URL, placed at 480 px wide preserving aspect ratio, centered.
- Shapes: rectangle, ellipse, line. Rendered as `div`s with background/border and, for ellipse, `border-radius: 50%`.

### 5.7 Slides

- Add blank slide: uses the active slide's canvas size, no `class` requirement beyond `slide`, white background, unique `data-slide-id`, inserted after the active slide.
- Duplicate: deep clone; regenerate slide id and every `data-ppt-el` id.
- Delete: removes slide; at least one slide must remain.
- Reorder: drag in the thumbnail rail.
- Slide operations are disabled in the single-body fallback mode.

### 5.8 History

- Whole-master snapshots (serialized document) per committed operation; maximum 100 entries.
- Coalescing: continuous drags commit once on pointerup; rapid style/text changes coalesce within 500 ms.
- Undo/redo restores master, re-renders the active slide if changed, and refreshes thumbnails.
- View-only state (zoom, selection, panel sizes) is not part of history.

### 5.9 Keyboard shortcuts

- Cmd/Ctrl+Z undo, Cmd/Ctrl+Shift+Z redo.
- Cmd/Ctrl+S save, Cmd/Ctrl+Shift+E export.
- Cmd/Ctrl+D duplicate selected object.
- Arrow keys nudge 1 px; Shift+Arrow 10 px.
- Delete/Backspace removes selected object (undoable).
- Cmd/Ctrl+= / Cmd/Ctrl+- zoom; Cmd/Ctrl+0 fit.
- Escape: exit text edit / clear selection.
- While presenting: arrows/space/PageUp/PageDown/Home/End navigate; Escape exits.

## 6. Play mode

- Full-screen overlay (Fullscreen API where available).
- Each slide renders in a sandboxed iframe at design size scaled to fit the screen; CSS animations run, scripts do not.
- Slide counter and controls fade on idle.
- v1 has no slide-to-slide transition; only in-slide CSS animations play.

## 7. Persistence and export

### File handling

- Primary: File System Access API. Open uses the file picker; Save writes back to the opened handle. Save requires a prior user gesture after reload if permission is `prompt`.
- Recent projects store `{name, html, updatedAt, fileHandle}` in IndexedDB; reopening prompts once for permission.
- Fallback (no File System Access): open via file input/drag-drop; save via download.

### Autosave and recovery

- Debounced 800 ms after each commit, serialize master to IndexedDB.
- On load with a saved project, offer "Restore unsaved changes" with timestamp.
- Before unload, warn when in-memory content differs from the last file write.

### Export

- Serialize the master document (doctype included) with UTF-8.
- Cleanup: remove `contenteditable` and any editor-only attributes/classes; no injected base styles or overlay markup can exist in master.
- Keep `data-slide-id`, `data-ppt-el`, inserted-element inline styles, and the normalized slide `position: relative`.
- Add one generator comment immediately after the doctype:
  `<!-- Edited with HTML Deck Editor (htmldeck/v1). Slides: [data-slide-id]. -->`
- Default filename `<basename>.edited.html`; "Save As" may overwrite the source.
- No network access is required to export.

## 8. UI

### Layout

- Top bar: file name and save state, Open, Save, Undo/Redo, zoom control, Play, Export.
- Left rail (~168 px): slide thumbnails with index badges; drag to reorder; add/duplicate/delete controls.
- Center: dark canvas area; slide rendered with a drop shadow; zoom 25–200% with fit-to-window default.
- Right inspector (~280 px): Design tab (geometry, z-order, align/distribute, fill, border, radius, opacity, slide background) and Text tab (typography). Contextual empty states.
- Bottom bar: slide index, object count, zoom readout.
- Empty app state: full drop zone, Open button, and a link to the deck contract.

### Visual language

- Dark tool chrome (zinc neutrals), warm amber accent, Inter for UI, slide content untouched by editor styling.
- Tool UI copy in Traditional Chinese; code, comments, and docs in English.
- Accessible focus states and labels; iframes have descriptive titles.
- Minimum supported window: 1280 × 800.

## 9. Error handling

| Situation | Behavior |
|---|---|
| Invalid HTML / no slides | Single-body fallback, warning banner, editing allowed |
| Relative assets or JS dependencies | Import report warning; editing continues |
| iframe resource load failure | Warning entry; broken resources stay as-is |
| Save permission denied | Offer Save As / download |
| Browser without File System Access | Upload/download mode with a one-time notice |
| Writing file fails | Toast with retry and export fallback |
| Last slide deletion | Blocked with explanation |
| Transform of nested element | Blocked; offer Detach to slide |
| Undo stack limit | Oldest entries dropped silently |

## 10. Tech stack

- Vite, React 19, TypeScript (strict).
- Zustand for editor state.
- Tailwind CSS with custom design tokens; lucide-react icons; nanoid for ids.
- Vitest + jsdom for unit tests; Playwright (Chromium) for E2E and visual round-trip tests.
- No backend, no external runtime services.

## 11. Testing

### Unit

Slide detection order, canvas inference, fit-scale and coordinate conversion (including padding/border offsets), pin geometry, rotation decomposition, snapping candidates and threshold, history coalescing, export cleanup and serialization, id regeneration on duplicate.

### E2E (Playwright)

1. Import contract fixture → N thumbnails, slide 1 active.
2. Select object, drag 100 px → inline left/top updated; undo/redo restores.
3. Resize and rotate → geometry persists.
4. Double-click text, edit, commit → text updated; no `contenteditable` in export.
5. Style change (font size, color, align) → applied.
6. Insert text box, image, shape → appear and export.
7. Add/duplicate/reorder/delete slides → order and ids correct; ids regenerated on duplicate.
8. Play mode navigation and exit.
9. Export → re-import → structure and geometry match.
10. Save writes back through File System Access (tested with a stubbed handle) and download fallback works.

### Visual round-trip

- Import fixture, export immediately, render original and export at 1600 × 900, pixel-compare each slide (same browser) with < 0.1% differing pixels.
- After a scripted edit, compare the editor canvas and exported slide screenshots with the same tolerance.

### Fixtures

A contract-compliant deck, a messy legacy deck, a deck with CSS animations, and a deck with external/CDN assets and script tags.

### Verification gate

Before completion: `eslint`, `tsc --noEmit`, `vitest run`, `playwright test`, `vite build` all pass.

## 12. Acceptance criteria

- A contract deck imports with all slides listed and the first slide editable.
- Move, resize, rotate, text edit, and style changes are visible immediately and survive export/re-import.
- Inserted text, images, and shapes survive export and round-trip.
- Slide add/duplicate/reorder/delete work and round-trip.
- Undo/redo covers all content operations with coalesced drags.
- Unedited export renders pixel-identically to the source.
- Exported HTML contains no editor artifacts and remains readable HTML that an agent can edit further.
- Save writes back to the original file in Chromium; other browsers can open and download.
- Play mode navigates slides and runs existing CSS animations.
- Non-compliant decks import with actionable warnings instead of failing.

## 13. Risks and limitations

- Arbitrary HTML cannot be fully modeled as PowerPoint objects. Top-level-object transformation plus nested style editing is the agreed boundary; flex/grid children lose their layout position once pinned.
- Decks that rely on JavaScript for layout or navigation will not edit or present accurately; they are detected and warned about.
- Cross-origin images/fonts remain remote; offline rendering is not guaranteed.
- Text reflow can change the appearance of auto-sized containers; fixed geometry is preserved for pinned objects.
- Browser font rendering differs across platforms; visual round-trip tests compare within one browser.
- File System Access is Chromium-only; other browsers use download/upload.
