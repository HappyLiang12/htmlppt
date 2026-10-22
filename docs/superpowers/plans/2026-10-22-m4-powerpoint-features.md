# M4 PowerPoint Features Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Add the PowerPoint-class feature set on top of the M3 editor foundation: rich text, object insertion, groups/lock/hide/align, tables, charts, notes/transitions/backgrounds, play transitions, presenter view, and the remaining MCP asset/table/chart tools.

**Architecture:** Geometry-independent document operations live in `@htmlppt/core` (groups, tables, charts, rich-text style helpers) so the editor, MCP, and tests share one implementation. The editor contributes commands, toolbars, dialogs, and overlay behavior. Charts render deterministic inline SVG from `data-ppt-chart` JSON. Presenter view uses a same-origin popup synchronized with `BroadcastChannel`; the exported runtime gains presenter parity in the same milestone.

**Tech Stack:** React 19, core DOM APIs, jsdom, Vitest, Playwright, existing M1–M3 packages.

**Spec:** `docs/superpowers/specs/2026-10-21-html-ppt-editor-design.md` §4, §6, §10 (Rich text, Objects, Tables, Charts, Play/presenter); test framework §9.

## Global Constraints

- Node >= 20, ESM, TypeScript strict. No retries, skips, mocks of host/filesystem/Chromium.
- All document mutations go through core; saved HTML stays contract-compliant and artifact-free.
- Deterministic chart SVG: same JSON + size ⇒ byte-identical markup.
- Rich-text editing uses real text nodes and inline styles; no editor wrapper markup.
- UI copy Traditional Chinese; code/docs/tests English.
- No new dependencies in M4 unless a task explicitly records one (none planned).

## File Structure

```
packages/core/src/objects.ts        group/ungroup/lock/hide/z-order/align/distribute
packages/core/src/rich-text.ts      inline style apply/clear helpers (DOM Range)
packages/core/src/tables.ts         row/column insert/delete, header toggle
packages/core/src/charts.ts         chart JSON types, validation, SVG renderer
packages/core/src/images.ts         data-URL helpers
packages/core/test/*                unit tests
packages/editor/src/commands/       rich text, objects, tables, charts commands
packages/editor/src/components/     TextToolbar, InsertMenu, TableToolbar, ChartDialog, PresenterWindow
packages/editor/src/presenter.ts    BroadcastChannel protocol
packages/editor/src/App.tsx
packages/runtime/src/index.ts       presenter parity + transition CSS
packages/mcp/src/tools.ts           add_image, add_table, update_chart
skills/htmlppt/                     updated references/examples
e2e/features.spec.ts                @feature:rich-text, tables, charts, presenter
e2e/presenter.spec.ts
```

---

### Task 1: Core object operations

**Files:** `packages/core/src/objects.ts`, `packages/core/src/index.ts`, `packages/core/test/objects.test.ts`

**Interfaces:**
- `groupElements(doc, slideId, elementIds: string[]): string` — wraps two or more top-level objects in `div[data-ppt-group]`, preserving visual order and assigning a group id; returns the group element id.
- `ungroupElement(doc, slideId, target): string[]` — moves children back to the slide, removes the wrapper, returns child ids.
- `setLocked(doc, slideId, target, locked: boolean)`, `setHidden(doc, slideId, target, hidden: boolean)` — `data-ppt-locked="true"` / inline `display:none`.
- `bringToFront/sendToBack/bringForward/sendBackward(doc, slideId, target)`.
- `alignElements(doc, slideId, targets, mode: 'left'|'center'|'right'|'top'|'middle'|'bottom')` and `distributeElements(doc, slideId, targets, axis)` — operate on pinned absolute geometry; throw if an element has no absolute position.
- All respect groups (a group is one top-level object), notes excluded, stable ids.

**Tests:** group/ungroup round-trip preserves inner HTML and order; nested groups rejected; lock/hide flags; z-order DOM order; align/distribute exact coordinates; errors for fewer than two targets.

**Steps:** failing tests → RED → implement → GREEN → commit `feat(core): add object and group operations`.

---

### Task 2: Rich-text engine and toolbar

**Files:** `packages/core/src/rich-text.ts`, `packages/core/test/rich-text.test.ts`, `packages/editor/src/commands/rich-text.ts`, `packages/editor/src/components/TextToolbar.tsx`, E2E.

**Interfaces:**
- Core: `applyInlineStyle(range: Range, style: Record<string, string>): void` splits text nodes and applies `<span style>` only around the selection; `clearFormatting(range)`, `toggleList(doc, block, 'ul'|'ol')`, `setBlockAlignment(block, value)`, `setLink(range, href)`, `sanitizePastedText(text): string`.
- Editor toolbar actions: bold, italic, underline, strikethrough, color, highlight, font family, font size, alignment, line height, bullet/numbered list, link, clear formatting.
- Collapsed caret applies to the whole block; a selection applies to the selected characters.
- Toolbar state derives from computed styles at the selection; link URLs allow only `http:`, `https:`, `mailto:`, and `#` fragments.
- Paste inserts plain text; commit strips editor-only markup.

**Tests:** jsdom range splitting for partial selections; bold/italic/color nesting; clear formatting removes spans; link validation rejects `javascript:`; list creation/normalization; paste sanitization; toolbar state parses nested styles.

**E2E:** select part of a heading → bold/color → commit → file has spans with the style and no `contenteditable`; clear formatting restores text; link applies to a selection and rejects `javascript:`.

**Commit:** `feat(editor): add rich-text editing and toolbar`.

---

### Task 3: Object insertion (text box, shape, image)

**Files:** `packages/core/src/images.ts`, `packages/editor/src/commands/insert.ts`, `packages/editor/src/components/InsertMenu.tsx`, E2E.

**Interfaces:**
- `insertTextBox(slide, { x, y, width, height, text })` — absolutely positioned div, generated id, real text.
- `insertShape(slide, { x, y, width, height, shape: 'rect'|'ellipse'|'line', fill, stroke, radius })` — inline SVG or styled div; deterministic.
- `insertImage(slide, { x, y, width, height, source })` — `source` can be a data URL, absolute URL, or local `File`; local files are read as data URLs with a 8 MB guard and a clear error above it.
- All objects are top-level, selected after insert, and one history entry.

**Tests:** geometry and markup; image MIME/size guards; unsupported local types rejected; E2E inserts each type, persists, reloads, and exports without editor artifacts.

**Commit:** `feat(editor): add text, shape, and image insertion`.

---

### Task 4: Tables

**Files:** `packages/core/src/tables.ts`, `packages/core/test/tables.test.ts`, `packages/editor/src/commands/tables.ts`, `packages/editor/src/components/TableToolbar.tsx`, E2E.

**Interfaces:**
- `insertTable(doc, slideId, { rows, columns, target? }): string` — `<table>` with `<tbody>` cells and generated id.
- `insertRow(doc, slideId, target, position: 'above'|'below')`, `insertColumn(... 'left'|'right')`, `deleteRow`, `deleteColumn`, `toggleHeaderRow`.
- Cell editing uses contenteditable and commits text; cell background/border via `setStyle`; no merge/split in v1.
- Table toolbar appears when the selection is inside a table; disabled actions at boundaries.

**Tests:** exact row/column counts, header toggle, boundary errors, nested table rejection, E2E edits a cell and inserts/deletes rows/columns.

**Commit:** `feat(editor): add table editing`.

---

### Task 5: Charts

**Files:** `packages/core/src/charts.ts`, `packages/core/test/charts.test.ts`, `packages/editor/src/components/ChartDialog.tsx`, `packages/editor/src/commands/charts.ts`, E2E.

**Interfaces:**
- `ChartData { type: 'bar'|'line'|'pie'; title?; labels: string[]; series: { name: string; values: number[] }[]; colors?: string[]; legend?: boolean; valueLabels?: boolean }`.
- `parseChartData(value: string): ChartData` with actionable validation errors (labels/series lengths, finite numbers).
- `renderChartSvg(data, width, height): string` — deterministic, inline SVG with viewBox, bars/lines/pie slices, labels, legend, value labels; no external assets.
- `updateChart(doc, slideId, target, data)` stores JSON in `data-ppt-chart` and replaces the rendered SVG.
- Editor dialog edits type/title/labels/series/colors/legend/value labels; invalid JSON shows a placeholder + validation error.
- Resize re-renders at the new size (ResizeObserver on the figure).

**Tests:** JSON validation cases; SVG determinism (same input twice byte-identical); bar geometry for known values; pie slice sums; E2E insert a chart, edit data, persist, reload.

**Commit:** `feat(editor): add chart editing and rendering`.

---

### Task 6: Notes, transitions, backgrounds, sorter polish

**Files:** `packages/editor/src/components/Inspector.tsx`, `ThumbnailRail.tsx`, `SorterView.tsx`, core `setSlideBackground` (M2) reuse, E2E.

**Interfaces:** Notes tab autosaves on blur; transition select includes a short preview; background color/gradient/image URL; sorter supports drag reorder, duplicate/delete, and multi-select? (single selection is enough); thumbnails show the active selection state.

**Tests:** background round-trip (color/gradient/image), note removal, transition preview does not mutate until confirmed, sorter reorder persists.

**Commit:** `feat(editor): add slide settings and sorter polish`.

---

### Task 7: Play transitions and presenter view

**Files:** `packages/editor/src/components/PlayView.tsx`, `PresenterWindow.tsx`, `packages/editor/src/presenter.ts`, `packages/runtime/src/index.ts`, E2E `presenter.spec.ts`.

**Interfaces:**
- Play mode applies `data-ppt-transition` fade/slide using CSS transitions between slides; respects `prefers-reduced-motion`.
- Presenter popup: notes, next-slide preview, timer, prev/next, sync indicator. Protocol messages: `{ type: 'slide', index }`, `{ type: 'request' }`, `{ type: 'state', index, total }` over `BroadcastChannel('htmlppt-presenter')`; fallback instructions when the popup is blocked.
- Runtime parity: the inline runtime opens the same presenter popup on `P`, reads notes via `[data-ppt-notes]`, and synchronizes via the same channel; `F` requests fullscreen; transitions use CSS classes.
- Exported decks get presenter view without editor chrome.

**Tests:** protocol reducer; popup-blocked message; runtime presenter E2E with two pages (deck + popup) navigating in sync; transitions with reduced motion.

**Commit:** `feat: add presenter view and play transitions`.

---

### Task 8: MCP asset, table, and chart tools

**Files:** `packages/mcp/src/tools.ts`, `packages/mcp/test/mcp-stdio.test.ts`, `skills/htmlppt/`.

**Interfaces:**
- `add_image({ path, slideId, source, width?, target? })` — data URL, absolute URL, or local path embedded as a data URL with size guards.
- `add_table({ path, slideId, rows, columns, target? })`.
- `update_chart({ path, slideId, target, chart })` — stores JSON and renders SVG.
- Skill: add authoring guidance and examples for charts/tables/images; update the MCP tool reference.

**Tests:** direct and host-attached calls for each tool; oversized image rejected; invalid chart JSON returns structured errors; examples validate.

**Commit:** `feat(mcp): add asset, table, and chart tools`.

---

### Task 9: Feature E2E and exit

**Files:** `e2e/features.spec.ts`, `e2e/presenter.spec.ts`, `docs/features.json`, `docs/` updates.

**Steps:**
- Tag and activate `rich-text`, `tables`, `charts`, `presenter`, `objects-transform`.
- Run the full acceptance list: transform/multi-select/group/z-order/lock/hide; rich text; insert objects; tables; charts; slide ops; undo/redo; presenter; live update.
- `npm run verify`; manual smoke of each feature.
- Whole-branch review; merge; post-merge verify.

## M4 Exit

All v1 editor features work end to end, MCP asset/table/chart tools pass, presenter view works in the editor and exported decks, and the feature matrix marks every M4 feature active.
