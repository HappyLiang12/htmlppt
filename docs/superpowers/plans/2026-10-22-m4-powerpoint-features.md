# M4 PowerPoint Features Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development. Execute one task per reviewer gate; no concurrent writers in one worktree.

**Goal:** Complete the approved PowerPoint-class editor scope: rich text, object insertion/styling, groups/lock/hide/align, tables, charts, slide settings, fullscreen/presenter, and MCP asset/table/chart tools.

**Architecture:** Portable document mutations live in `@htmlppt/core`; editor commands supply measured geometry, selection and history integration. Charts are deterministic inline SVG. Rich-text Range helpers run in browsers/jsdom, not linkedom. The exported runtime stays self-contained. Presenter sessions have unique channel identities.

**Tech Stack:** Existing React 19, TypeScript, core DOM APIs, Vitest/jsdom and Playwright.

**Spec:** `docs/superpowers/specs/2026-10-21-html-ppt-editor-design.md` sections 4, 6, 10 and 15; `docs/superpowers/specs/2026-10-21-test-framework-design.md`.

## Global Constraints

- Node >=20, strict TypeScript, ESM. UI Traditional Chinese; code/docs/tests English.
- No retries, skipped scenarios, or mocks of host/filesystem/Chromium. Real files and processes; assertions verify saved/reloaded content.
- All new document mutations go through core. One master DOM, one controller commit/history path; no competing copy of the document.
- Editing iframe remains `allow-same-origin` without scripts; overlays and toolbars stay outside it. Saved/exported HTML is artifact-free.
- Native Range helpers may be browser-only; portable object/table/chart mutations retain Node DOM support.
- Chart JSON + dimensions produce byte-identical SVG. No external chart service or live data.
- No production dependencies added. Core Range tests may declare the existing jsdom version as a dev dependency.
- No group resize, nested groups, cell merge/split, new chart kinds, animation timelines, PPTX, or mobile editor scope.
- Local commits and authorized local merges only; no push/PR/publish.

## Execution and ownership

Task 1 touches only new core object APIs/tests and can start from merged M2 while M3 finishes. Task 2 and all editor work wait for reviewed M3 integration. Tasks 2–10 then run sequentially in the M4 worktree. M5 renderer work may run in a separate worktree while files/build outputs are disjoint. M5 CLI/MCP integration and M4 Task 9 both edit MCP/skill files and must not be dispatched as concurrent writers, even in different worktrees. M5 visual/security/a11y exit work waits for M4 completion.

Task numbering was amended before any M4 implementation: original Task 1 was split into core operations (1) and missing editor controls (2); original Tasks 2–9 are now 3–10. No completed task is being renumbered.

## Shared interfaces

- Core object targets reuse `ElementTarget` and existing slide/target resolution. Insertion APIs return object IDs; optional `target` means top-level insertion anchor, not a table cell or an arbitrary selector.
- Editor commands re-resolve IDs against the current master after external/undo replacement. Measure all selected objects before any pin/reparent operation; one user action creates one history entry.
- Geometry operations require finite inline absolute pixel boxes. Editor converts measured flow/percentage layout through its existing pinning bridge first. Node APIs never guess browser layout.
- Node image loading reads only explicitly provided paths; browser File/clipboard/drop acquisition stays outside portable core. Shared MIME/decoded-size validation is reused by MCP.
- Chart update size comes from persisted positive pixel dimensions or fixed defaults, never Node layout measurement. Editor resize supplies explicit dimensions before the gesture commit.

---

### Task 1: Core object operations

**Files:** create `packages/core/src/objects.ts`, `packages/core/test/objects.test.ts`, and focused real-browser `packages/core/test/objects-browser.test.ts` if needed; modify `packages/core/src/index.ts`. Use the existing root Playwright dev dependency, no new dependencies. No root manifests, editor, MCP or host source files in this task.

**Interfaces:**
- `groupElements(doc: Document, slideId: string, elementIds: string[]): string` groups at least two distinct top-level non-group objects in `div[data-ppt-group]` with a stable generated object ID.
- Require pinned absolute pixel boxes, validate all inputs and derived finite coordinates before mutation. Group bounds enclose the selected objects in slide coordinates; child offsets become group-local without visual jumps. Preserve IDs, content, rotation and relative selected-object paint order. Place the new atomic group at the frontmost selected layer; noncontiguous selections are valid, and unrelated siblings retain their mutual order. Relative overlap between selected and intervening unselected layers necessarily changes when forming one group; do not falsely promise interleaved stacking survives.
- Detect inline descendant stacking that escapes its top-level object and would change appearance when grouped/reordered. Preserve it if representable; otherwise reject that concrete hazard before mutation with actionable flattening guidance, not a blanket ban on noncontiguous selection. Static/positioned painting order must match real Chromium; normalizing layers cannot activate dormant offsets or move unrelated objects/descendants.
- `ungroupElement(doc: Document, slideId: string, target: ElementTarget): string[]` returns restored child IDs. Compose group translation/rotation with child geometry so moved/rotated groups retain their visible positions after ungroup. Do not merely move children retaining group-local left/top. Support 2D rigid translation/rotation in transform functions and equivalent matrix(a,b,c,d,e,f) form, including finite pixel/percentage transform origins; reject scale/skew/3D or unresolvable CSS geometry before mutation. Harmless inherited wrapper styles such as color:inherit must not prevent ungrouping; real wrapper-only effects must be preserved/flattened or rejected explicitly.
- `setLocked(doc, slideId, target, locked: boolean): void` uses `data-ppt-locked="true"`; unlocking removes it.
- `setHidden(doc, slideId, target, hidden: boolean): void` hides with inline display:none and restores authored display on unhide, including a serialize/parse round-trip. Define a persistent contract attribute for prior inline display only if needed; do not use editor-only artifacts.
- `bringToFront`, `sendToBack`, `bringForward`, `sendBackward` accept `(doc, slideId, target)`. Effective visual z-order must change even when objects have explicit z-index; notes/script/style are not objects. Keep resulting order deterministic and preserve unrelated content.
- `alignElements(doc, slideId, targets: ElementTarget[], mode: 'left'|'center'|'right'|'top'|'middle'|'bottom'): void` aligns to the selected set's bounds.
- `distributeElements(doc, slideId, targets: ElementTarget[], axis: 'horizontal'|'vertical'): void` distributes equal gaps between outer edges with first/last fixed; require at least three distinct objects. Alignment requires at least two. Both require pinned absolute geometry and must not partially mutate on invalid input.

**Tests:** exact coordinates for each alignment/distribution mode; invalid/duplicate/nested/notes targets rejected before changes; group/ungroup content/ID/order invariants; moved and rotated group ungroup appearance calculated in slide coordinates; rotated children; hidden flex/grid display restoration after serialization; explicit z-index ordering; boundary no-ops; stable unrelated siblings.

**Steps:** write failing tests and observe RED; implement; run `npm run test -w @htmlppt/core`, `npm run typecheck`, `npm run lint`, `npm run lint:deps`; review the focused diff. No full E2E needed for pure core task.

**Commit:** `feat(core): add object and group operations`.

---

### Task 2: Editor object commands and recoverable object panel

**Depends on:** Task 1 and approved M3 merge.

**Files:** new `packages/editor/src/commands/objects.ts`, object controls component if existing Inspector is not a suitable owner; modify App, Inspector, selection/transform/shortcuts/CanvasOverlay as needed; `e2e/features.spec.ts`, feature matrix.

**Interfaces:**
- Route group/ungroup, six alignments, two distributions, four z-order operations, lock/unlock and hide/unhide through core and one controller commit.
- Ctrl/Cmd+G groups; Shift+Ctrl/Cmd+G ungroups outside editable text. New group becomes selected; ungroup selects returned children.
- Objects panel includes hidden/locked items with individually labeled recovery controls. Hidden/locked items cannot be transformed or text-edited via canvas or keyboard; panel can still select/recover them.
- Groups move and rotate as one top-level object. No resize handles or numeric W/H edits for groups. Selection/remapping uses IDs after structural changes.
- Reuse M3 geometry bridge; measure before pinning. Disable inapplicable actions without creating no-op history or saves.

**Tests:** real browser multi-select/group/move/rotate/ungroup preserving corner positions; explicit-z-index overlapping order; lock blocks drag/nudge/edit, panel unlock recovers; hide→save→reload→panel unhide preserves display; align/distribute exact persisted coordinates; undo/redo once per action; no group resize through either route. Activate `objects-transform` with its acceptance tests.

**Commit:** `feat(editor): wire object operations and recovery controls`.

---

### Task 3: Rich-text engine and toolbar

**Files:** core `rich-text.ts`, `test/rich-text.test.ts`, index exports and core jsdom test dependency/config; editor `commands/rich-text.ts`, `components/TextToolbar.tsx`, App; E2E.

**Interfaces:**
- `applyInlineStyle(range: Range, style: Record<string,string>): void`, `clearFormatting(range: Range): void`, `toggleList(doc: Document, block: Element, kind: 'ul'|'ol'): void`, `setBlockAlignment(block: Element, value: 'left'|'center'|'right'|'justify'): void`, `setLink(range: Range, href: string): void`, `sanitizePastedText(text: string): string`.
- Use real browser/jsdom Ranges, splitting only selected text and applying inline spans. Do not polyfill missing linkedom Range APIs in production.
- Bold, italic, underline, strikethrough, color, highlight, family, size, alignment, line height, lists, links and clear formatting. Collapsed caret applies to the containing block; noncollapsed ranges apply to selected characters.
- Preserve the iframe Range when toolbar focus moves; restore before operation, derive state from computed styles and commit through the existing editing session. No wrapper leakage or unwanted commit per intermediate selection change.
- Links permit only http:, https:, mailto: and fragments. Plain-text paste by default; image clipboard items are routed to Task 4 image acquisition.
- Cell rich text uses the active td/th and survives table structural operations.

**Tests:** partial/cross-span selections; nested formatting; clear formatting retains text; list conversion/normalization; invalid links rejected before mutation; paste sanitization; collapsed block behavior; every toolbar action and state. Real browser selection→toolbar→persist/reload, no authored contenteditable changes, one undo entry, focus preservation. Activate `rich-text`.

**Commit:** `feat(editor): add rich-text editing and toolbar`.

---

### Task 4: Text, shape and image insertion and styling

**Files:** core `images.ts` and insertion/style helpers with tests/index exports; editor `commands/insert.ts`, `components/InsertMenu.tsx`, object/image controls and acquisition handlers; E2E.

**Interfaces:**
- Shared core insertion takes `(doc, slideId, options)` and returns generated object ID, with optional top-level `target` anchor. Default box starts at (100,100); explicit dimensions override defaults.
- Text box: real text, absolute div, default 400×100. Shapes: rectangle, rounded rectangle, ellipse, triangle, line and arrow, default 240×160; line default 240×4. Deterministic native HTML/SVG with fill/stroke/radius/opacity/rotation controls; shapes support editable text without flattening SVG geometry.
- Images: data URL, absolute HTTP(S) URL or browser local File; local files embedded as data URLs. Shared decoded size limit 8 MiB; supported local MIME image/png, image/jpeg, image/gif, image/webp and image/svg+xml. Validate MIME/signature where applicable; SVG loads only as an img resource, never injected as active markup.
- Browser file picker, drop and clipboard image acquisition use the same validation and insertion route. Node local-path loading is Task 9.
- Image replacement retains geometry; basic crop uses a fixed viewport/object-fit:cover plus editable object-position, with reset; alt text, border radius, opacity and rotation persist.
- Select inserted ID; one history entry per insert/style/replace/crop action; rejected inputs do not dirty the deck. Acquisition errors are actionable Traditional Chinese in UI, English in shared errors.

**Tests:** markup, IDs, geometry, every shape type, text-in-shape; invalid MIME/size/URL cases including decoded data size; picker/drop/clipboard images; replace/crop/reset/alt/style persistence and undo/redo. Real file and clipboard events with actual image bytes, no renderer/browser mocks.

**Execution sizing:** core/insertion and browser image acquisition may be delivered by sequential scoped implementers under the same task gate; no simultaneous writers or claims of completion before both parts are reviewed.

**Commit:** `feat(editor): add text, shape, and image editing`.

---

### Task 5: Tables

**Files:** core `tables.ts`, tests/index exports; editor `commands/tables.ts`, `components/TableToolbar.tsx`, active-cell selection; E2E.

**Interfaces:**
- `insertTable(doc, slideId, { rows, columns, target? }): string` creates a top-level table with generated ID and tbody. Row/column counts are positive integers; reject excessive allocation with documented finite bounds (maximum 100 each).
- `insertRow(doc, slideId, target: ElementTarget, rowIndex: number, position: 'above'|'below'): void`; `insertColumn(doc, slideId, target, columnIndex: number, position: 'left'|'right'): void`.
- `deleteRow(doc, slideId, target, rowIndex): void`, `deleteColumn(doc, slideId, target, columnIndex): void`; keep at least one row/column. `toggleHeaderRow(doc, slideId, target): void` toggles first logical row td/th, preserving inner HTML/styles.
- Indices are zero-based across logical rows including the header; target is the table, never an implicit active cell. Reject nested/ragged/merged tables with actionable errors before mutation.
- Editor separately tracks active table/cell by ID and coordinates. Toolbar only appears for a table/cell selection; boundary actions disabled; cell text and rich formatting commit cleaned HTML, not flattened text. Cell background and border controls use core styles.

**Tests:** exact structure/counts and values, header content/style preservation, invalid indices and last-row/column prevention, nested table rejection; real insert/edit/format/add/delete rows/columns and save/reload/undo. Activate `tables`.

**Commit:** `feat(editor): add table editing`.

---

### Task 6: Charts

**Files:** core `charts.ts`, tests/index exports and semantic chart validation; editor `components/ChartDialog.tsx`, `commands/charts.ts`, insertion and resize integration; E2E.

**Interfaces:**
- `ChartData { type: 'bar'|'line'|'pie'; title?: string; labels: string[]; series: {name:string;values:number[]}[]; colors?: string[]; legend?: boolean; valueLabels?: boolean }`.
- `parseChartData(value: string): ChartData` validates types, nonempty labels/series, lengths, finite values and safe color syntax. Pie requires nonnegative values and a positive total; support declared series explicitly rather than silently ignoring extras.
- `renderChartSvg(data: ChartData, width: number, height: number): string` is deterministic; all text escaped, no external assets. Bars/lines handle negative and zero values without NaN/Infinity; pie slices, labels/legend/value labels fit the chosen canvas.
- `insertChart(doc, slideId, {data,width?,height?,target?}): string` inserts a figure with generated ID; default 640×360. `updateChart(doc, slideId, target, data, size?: {width:number;height:number}): void` stores JSON and SVG; use explicit size, then persisted positive inline px size, then 640×360.
- Reuse semantic validation for imported chart diagnostics. Invalid imported data shows a placeholder/error and remains repairable in the dialog.
- Parent editor owns observation of iframe figure layout; disconnect on replacement. Gesture resize regeneration is part of the same commit/history entry; observer callbacks must not continuously dirty or mutate the master.

**Tests:** malformed JSON/types/lengths/numbers/colors; byte-identical SVG; known bar/line geometry including negatives; pie values and multiple-series behavior; escaped text; insert/edit/resize/save/reload; malformed import repair; no resize feedback loop. Activate `charts`.

**Commit:** `feat(editor): add chart editing and rendering`.

---

### Task 7: Slide settings and sorter completion

**Files:** existing Inspector, ThumbnailRail, SorterView and PlayView preview support; E2E.

**Interfaces:** Reuse M3 notes/background/transition/sorter controls, do not rebuild them. Notes autosave on blur and can be removed. Color/gradient/image backgrounds clear competing forms and support reset. Sorter is explicitly single-selection with drag reorder/duplicate/delete. Transition preview is temporary UI state; only confirmation mutates master/history; cancel does not save. Active thumbnail remains visible.

**Tests:** background variants and clearing round-trip; note removal; transition preview/cancel/confirm save counts; sorter reorder persistence and active-thumbnail state.

**Commit:** `feat(editor): complete slide settings and previews`.

---

### Task 8: Fullscreen play, presenter and runtime parity

**Files:** PlayView, new PresenterWindow, editor `presenter.ts`, runtime `index.ts`, existing embedded-runtime fixtures/resources and `e2e/presenter.spec.ts`.

**Interfaces:**
- Editor play uses the main-window Fullscreen API from user activation; actionable fallback if unavailable, no false fullscreen claim. Keyboard and noninteractive click navigation, Escape exit, preserve current slide on return. Do not hijack links/controls.
- Fade/slide transitions honor `data-ppt-transition`; reduced motion removes animation. Notes hidden in main display.
- Presenter popup has notes, next-slide preview, elapsed timer, prev/next and connection status. Popup blocked yields actionable instructions and retains play usability.
- Fresh per-presentation session ID scopes `BroadcastChannel('htmlppt-presenter-' + sessionId)` and popup identity. Channel envelopes include sessionId; messages slide(index), request, state(index,total). Main is authoritative and validates index/range. Bootstrap deck snapshot/notes safely through same-origin opener communication; no arbitrary HTML in URL or unsafe document.write.
- Close/disconnect listeners/channels/timers on either window exit. Two same-origin decks cannot control or expose notes to each other.
- Self-contained exported runtime supports P presenter, F fullscreen, navigation/click/transitions and the same session isolation. No dependency on editor bundle/server. Refresh embedded runtime examples/resources after source changes.

**Tests:** protocol transitions and invalid messages; real two-window editor and exported runtime navigation, notes/next preview/timer, blocked popup, reduced motion, fullscreen enter/exit and fallback, concurrent deck isolation, cleanup. Activate `presenter`.

**Execution sizing:** editor/popup and exported-runtime parity may use sequential scoped implementers; both are required before task approval.

**Commit:** `feat: add fullscreen presenter and play transitions`.

---

### Task 9: MCP asset, table and chart tools

**Files:** MCP tools/errors/tests/schema snapshot/resources, skill references/examples.

**Interfaces:**
- `add_image({path,slideId,source,width?,target?})` accepts data URL, absolute HTTP(S) URL or explicitly supplied local path; reads local bytes and shares Task4 MIME/8 MiB validation. Does not fetch arbitrary remote assets on the Node host.
- `add_table({path,slideId,rows,columns,target?})` uses Task5 insertion and bounds.
- `update_chart({path,slideId,target,chart})` uses Task6 validation/SVG sizing; applies through existing DeckService revision/atomic-write behavior.
- Update exact tool-list/schema snapshots, skill/resources and actual valid examples; preserve existing tools and direct/host mode semantics.

**Tests:** real SDK stdio direct and host-attached success for each tool, persisted HTML, invalid/oversized images, invalid tables/charts, structured errors and conflict behavior. All examples validate with real runtime.

**Commit:** `feat(mcp): add asset, table, and chart tools`.

---

### Task 10: Feature acceptance and M4 exit

**Files:** feature/presenter E2E, feature matrix, user documentation only as needed.

**Steps:**
- Maintain a design-bullet-to-test checklist for objects, text, shapes/images, tables, charts and presentation; no feature tag substitutes for individual acceptance.
- Verify every content operation persists/reloads and has undo/redo; no editor artifacts or script execution in previews.
- Full acceptance: transforms/multi-select/group/z-order/lock/hide recovery; all formatting; shapes/images/crop/drop/clipboard; tables; chart repair/resize; slide settings; play/presenter; existing external-update/conflict behavior.
- Run `npm run verify` with real exit status/full log and a manual browser drill of each new family. No remote CI claims from local commands.
- Whole-branch review, fixes/re-review, authorized local merge and post-merge verify. Leave publishing deferred.

## M4 Exit

All approved M4 feature bullets have real end-to-end evidence, MCP tools and installed examples remain coherent, editor and exported runtime presenter work, and shipped feature rows are active with executed tests. Standalone file fallback, crash recovery and export UI remain explicit final-release acceptance items; M4 exit must not imply those are already delivered.
