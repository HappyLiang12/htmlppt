# Component dragging — design

Date: 2026-10-28
Status: design approved in chat; spec review pending
Branch: `feat/component-dragging` from `main` f843ddd (PR #11 merged)

## 1. Problem

The editor's object model is the slide's direct children (`docs/contract.md:94-109`).
Hand-written and agent-written decks wrap their content in layout containers, so
a wrapped deck exposes one top-level `.pad` and clicking any heading, card, chip,
icon, chart, table, or flow step selects that whole block. Dragging then moves
the entire slide content, which is what the screenshot in the request shows.

Reaching an inner element currently requires either drill-in entry (double-click
the container's own padding or use the OBJECTS chevron) or Alt-click. Neither is
discoverable, and inside a text-editing session a drag selects text rather than
moving the box. The user asked for direct drag-and-move of every visible
component — text boxes, charts, lines, circles, sections, tabs, icons,
flow-chart nodes and arrows — with a way into SVG internals that does not
require a remembered hotkey.

The move layer is already path-addressed: selecting a nested path and dragging
it works (`App.tsx:3236-3283`, `App.tsx:2378-2414`), and nested geometry pins
flow elements to absolute on first edit (`transform.ts:67-97`). The blocker is
selection granularity, discoverability, and SVG-internal geometry.

## 2. Goals and non-goals

Goals:

- A single click at slide level selects the innermost visible component under
  the pointer; a hover outline previews exactly what the click or drag will
  target.
- Dragging moves that component only, at any depth, including inside an `<svg>`.
- Double-click, Enter, the OBJECTS chevron, or a visible Inspector action enters
  a component for group editing without a hotkey; Esc leaves one level.
- Nested and SVG components support delete, duplicate, and copy/paste inside
  their parent.
- Text editing, tables, groups, locked/hidden objects, snapping, undo/autosave,
  conflict handling, play/export, and the top-level object contract keep working.
- No deck-format change and no MCP change: selection paths are editor-only, and
  every edit is an inline `style` or SVG `transform` attribute.

Non-goals:

- Editing CSS rules, classes, or stylesheets.
- Marquee selection, cross-slide nested copy/paste, or nested multi structural
  operations beyond the rules in §4.5.
- Resizing or rotating SVG shapes; SVG `<text>` inline editing; `<canvas>`
  pixels.
- Nested groups: `data-ppt-group` stays an atomic top-level wrapper.
- Replacing the top-level object model, validation, normalization, MCP targets,
  or the outline.
- Reworking the drill-in breadcrumb, OBJECTS list, or group-edit semantics.

## 3. Decisions

- **D1 — Component, not top-level object.** The click target is the innermost
  visible component: the deepest element whose computed `display` is not
  `inline` or `contents`, stopping at atomic widgets, with inline content folded
  into its block text box.
- **D2 — Atomic widgets.** `svg`, `img`, `canvas`, `video`, `iframe`, and
  `figure[data-ppt-chart]` are atomic for click selection. A `data-ppt-group`
  subtree, a locked subtree, and a hidden subtree resolve to their guarded
  wrapper. `figure[data-ppt-chart]` is atomic because the chart data and
  regeneration contract address the figure, and detaching its SVG from the
  figure would break the chart dialog and collapse the chart card. `table` is
  atomic for geometry, not for selection; see D9.
- **D3 — Positioned inline elements are components.** An element with computed
  `position: absolute` or `fixed` is selectable even when its display is
  `inline`, so authored line/circle spans remain draggable.
- **D4 — Slide level uses component resolution; an entered context keeps
  direct-child selection.** This supersedes the 2026-10-25 nested-container
  editing rule that a slide-level click selects a direct child. The drill-in
  context, breadcrumb, chevron, and Esc behavior remain and become an explicit
  group-edit mode.
- **D5 — Hover is the affordance.** A pointer move over the canvas outlines the
  component that a click would select, names it (`tag.first-class`), and sets a
  move cursor when it is draggable. No authored node is mutated for hover.
- **D6 — Double-click enters.** Double-click resolves through the same component
  rules: a text-editable leaf starts text editing; an enterable component
  (including `<svg>`) is entered; anything else keeps the existing hint. Enter
  enters the selected component at any depth, not only a direct child of the
  current context.
- **D7 — SVG internals are explicit.** SVG is atomic for a normal click;
  entering the `<svg>` exposes its object children (`g`, `path`, `circle`,
  `line`, `rect`, `polyline`, `text` is not editable). Alt-click remains a power
  shortcut to the deepest node and uses the same SVG geometry when it lands
  inside an SVG.
- **D8 — SVG drag uses a transform.** Drag writes a translate in SVG user units,
  pre-multiplied onto any authored `transform`; resize and rotate are not
  offered for SVG internals, and snapping is disabled for them.
- **D9 — Tables.** A cell is selectable by click (the table toolbar needs it) but
  table-internal selections have no geometry gestures; a drag on a cell shows a
  hint naming the table. The table itself is selectable through its border,
  OBJECTS row, or breadcrumb and moves as one object.
- **D10 — Structural operations follow the selection's parent.** A single
  nested/SVG selection supports delete, duplicate, and copy/paste inside its
  parent with fresh `data-ppt-el` ids and a 20 px offset. Top-level multi
  behavior is unchanged. Nested multi supports dragging but rejects structural
  commands with the documented reason.
- **D11 — Multi-selection may mix depths.** Shift-click adds components at any
  depth on the same slide. A selection normalizer drops descendants when an
  ancestor is selected and replaces descendants when an ancestor is added, so a
  drag never applies twice to the same subtree.
- **D12 — No format change.** No new persisted attributes, no selection state in
  the file, no metadata rewrite. Duplicates/pastes only mint `data-ppt-el` ids
  required by the existing unique-id contract.

## 4. Behavior

### 4.1 Component resolution

Input: the raw event target, the slide root, and the current `containerPath`.

1. Reject targets outside the slide, the slide root itself, notes asides, and
   script/style/template/link/meta.
2. Walk from the target up to the slide:
   - the nearest `data-ppt-group`, locked, or hidden ancestor wins and is
     returned as the component (guarded subtrees stay inert);
   - the nearest `svg`, `img`, `canvas`, `video`, `iframe`, or
     `figure[data-ppt-chart]` wins and is returned;
   - otherwise stop at the first element whose computed `display` is neither
     `inline` nor `contents`, or whose computed `position` is `absolute` or
     `fixed`;
   - an inline/contents element without such an ancestor resolves to null.
   A table cell resolves to the `td`/`th` itself (table-cell display is not
   inline); its geometry is refused per D9, while the table object remains
   selectable through its border, the OBJECTS row, or the breadcrumb.
3. `display: contents` wrappers are transparent; their descendants resolve
   normally.
4. The selection path is the raw child-index path from the slide
   (`selection.elementAtPath`), so it addresses SVG children too.
5. With a non-empty `containerPath`, resolution keeps today's rule: the clicked
   node resolves to the context's direct child, unless Alt-click asks for the
   deepest node. Clicking outside the entered container leaves it, as today.

The resolver is a pure module so unit tests can supply a style oracle and cover
the display/position/atomic rules without a browser.

### 4.2 Hover

- A `pointermove` listener on the frame document resolves the component and
  stores `{ path, rect, label, draggable }` when the path changes; updates are
  rAF-throttled.
- The hover box renders in the same frame-anchored overlay as the selection
  (`stageCrop.translateX/Y`), as a 1 px outline plus a small `tag.class` label.
  It never intercepts pointer events.
- The frame's document element receives an editor-only `data-ppt-hover="move"`
  (or `"blocked"` for table internals) and an injected editor-only style sets
  the cursor. The attribute lives on `<html>`, outside the slide, so
  `commitSlide` never serializes it; the style is re-injected on every frame
  load.
- Hover is cleared on pointerleave, text editing, gesture start, slide reload,
  and when the component is already the single selection.

### 4.3 Drag and move

- HTML components keep today's gesture: pin to absolute after the existing
  drag threshold, snap to siblings/slide bounds (Alt bypasses), one history
  entry, existing threshold and coordinates.
- SVG-internal components use a separate geometry mode:
  - at gesture start capture the element's authored `transform` and the inverse
    of its `getScreenCTM()`; convert the design-pixel delta to user units and
    write `translate(dx dy) <authored transform>`;
  - the selection outline follows the stored start rect plus the design delta;
  - snapping, resize, and rotate are disabled;
  - no `left/top/width/height` styles are written.
- Table internals do not start a session; the selection remains and a hint says
  the table must be selected to move it.
- Multi-selection moves all targets by one delta; if any target is SVG-internal,
  snapping is disabled for the gesture. Targets are normalized so no selected
  element is a descendant of another selected element.
- Text editing keeps native drag-to-select; moving a text box requires leaving
  the edit session first. No drag handle is added to the selection outline.

### 4.4 Enter and leave

- Double-click: a text-editable leaf starts text editing (existing precedence);
  otherwise the resolved component is entered when it has object children.
  Double-clicking a shape inside an `<svg>` therefore enters the SVG. A
  non-enterable component keeps the existing localized hint.
- Enter with a single selected component enters it when it has object children,
  at any depth. Today's direct-child restriction is removed.
- The OBJECTS chevron enters a container as before and now also lists SVG
  children. Selectable SVG objects are the rendered shape elements (`g`,
  `path`, `circle`, `line`, `rect`, `ellipse`, `polyline`, `polygon`, `use`,
  `image`, `foreignObject`, and `text` as an object that is not text-editable).
  Non-rendered SVG elements (`defs`, `title`, `desc`, `metadata`, `symbol`,
  `clipPath`, `mask`, `pattern`, `marker`, gradients, filters, `script`,
  `style`) are never objects.
- The Inspector shows an "Enter" action for a selected enterable component;
  it is keyboard reachable and localized.
- Inside an entered context: click selects direct children, double-click enters
  deeper, clicking outside leaves, Esc leaves one level, the breadcrumb and
  OBJECTS list are unchanged. At slide level the context stays empty even when
  the selection is deep.
- Alt-click keeps the deepest-node behavior and is not required for any flow.

### 4.5 Structural operations

- Delete on a single nested/SVG selection removes that element from its parent;
  table internals and guarded subtrees are refused with a hint.
- Duplicate on a single nested/SVG selection clones the element after itself in
  the same parent, offsets the clone by 20 px, refreshes every `data-ppt-el` in
  the clone, and selects the clone.
- Copy stores the selected component and its kind (HTML or SVG); paste inserts
  it as a sibling after the current selection when the kinds match. With no
  selection an HTML component pastes at slide level as today; an SVG component
  requires an SVG destination and otherwise shows a hint.
- SVG clones use `cloneNode`/`importNode`; serialized SVG is parsed with a
  namespace-aware parser, never the HTML `innerHTML` path.
- Multi-selection structural commands stay top-level only; a nested multi
  selection is refused with the existing structural hint. Group/ungroup remain
  top-level operations.
- All operations go through the existing `commitMaster` history/save path;
  undo, autosave, and conflict recovery apply unchanged.

### 4.6 Text, tables, guards

- Text editing is unchanged: double-click, the Text tab, and formatting target
  the same leaves. A selected text box can be dragged only outside an active
  edit session.
- Table cells stay selectable for the table toolbar; geometry fields, handles,
  drag, duplicate, and delete do not apply to cells/rows. Row/column
  operations stay in the table toolbar.
- Locked, hidden, and grouped objects keep their current selection and inertial
  behavior; component resolution never descends into a guarded subtree.

### 4.7 Feedback, i18n, accessibility

- New localized strings (en, zh-Hant, zh-Hans): enter component
  (`inspector.enterComponent`), table-cell move hint
  (`editor.hint.table-cell-move`: "This is a table cell. Select the table to
  move it."), incompatible paste hint (`editor.hint.paste-kind`), and the hover
  label pattern (lowercase tag plus the first authored class when present,
  e.g. `h1.cover-title`).
- Existing live-region announcements stay; entering/leaving a context still
  announces the level. Hover is pointer-only, so keyboard users use OBJECTS,
  the breadcrumb, and the Inspector Enter action.
- The rejected-gesture hint remains non-blocking and announced once.

### 4.8 Compatibility

- Saved HTML contains only authored markup plus inline styles/`transform`
  attributes and normal ids. No `data-ppt-hover`, editor styles, preview
  markers, or selection state.
- The top-level object model, MCP target selectors, validation, normalization,
  outline, play, presenter, and export keep their contracts.
- Decks with content at the top level select the same elements as today.

## 5. Architecture

- `packages/editor/src/component-target.ts` (new, pure): atomic-tag and
  non-object-tag sets, `resolveComponent`, `componentPath`, `isSvgInternal`,
  `isTableInternal`, `normalizeSelection`.
- `packages/editor/src/selection.ts`: keep context direct-child resolution;
  export the path helpers used by the resolver.
- `packages/editor/src/App.tsx`: pointerdown and double-click use component
  resolution; hover state/listener; Enter relaxation; SVG drag session mode;
  table hint; overlay wiring; structural command dispatch.
- `packages/editor/src/transform.ts`: `svgUserDelta`, `applySvgTranslate`,
  `isSvgInternal`.
- `packages/editor/src/use-deck-controller.ts`: node-based clipboard for nested
  and SVG components, nested delete/duplicate/paste, multi-selection at depth.
- `packages/editor/src/object-ops.ts`: nested collect/delete/paste helpers,
  clone id refresh, namespace-aware offsets.
- `packages/editor/src/components/CanvasOverlay.tsx` (or a small sibling):
  hover outline and label; suppress handles for SVG-internal and table-internal
  selections.
- `packages/editor/src/components/Inspector.tsx`: Enter action; read-only
  geometry for SVG-internal/table-internal selections.
- i18n catalogs, `docs/contract.md`, `docs/architecture.md`, `README.md`,
  `docs/features.json`.

## 6. Acceptance criteria

- **CD-AC1** In a wrapped deck, clicking a heading selects the heading itself
  (outline matches its box); dragging 60 screen px moves it 60 / scale design
  px, and the surrounding wrapper, footer, and decorations do not move. Undo
  restores the original geometry.
- **CD-AC2** Hovering shows the same component that a click selects; hovering
  the wrapper's padding shows the wrapper; the cursor is a move cursor only for
  draggable components.
- **CD-AC3** Cards, chips, steps, tab labels, icons, chart figures, and
  top-level arrows each select and drag as their own component; no whole-slide
  move. A chart figure moves with its title and legend.
- **CD-AC4** Double-clicking a card or an SVG enters it; its direct children are
  selectable; Enter on a deep selected container enters it; Esc leaves one
  level; OBJECTS and breadcrumb reflect the level.
- **CD-AC5** Inside an entered SVG, clicking a `g`/`circle`/`line`/`path`
  selects it; dragging writes a `transform="translate(...)"` in user units and
  saves; no resize/rotate handles appear; undo restores the authored transform.
- **CD-AC6** Clicking a table cell selects it and shows the table toolbar;
  dragging the cell does not move it and shows the hint; the table itself moves.
- **CD-AC7** Nested duplicate/delete/copy-paste persist across save/reload with
  unique ids; top-level copy/paste/duplicate still work; nested multi structural
  commands are refused with the structural hint.
- **CD-AC8** Locked, hidden, and grouped subtrees stay inert and resolve to
  their wrapper; group wrappers still move and rotate; no nested selection
  inside a group.
- **CD-AC9** A saved deck contains no `data-ppt-hover`, editor style tags,
  preview markers, or selection attributes.
- **CD-AC10** Existing text editing/formatting, tables, autosave/conflict,
  play, export, and accessibility suites stay green; expectations that encoded
  the superseded slide-level click rule are updated to the new contract, never
  loosened or skipped.

## 7. Testing

Unit (Vitest, `packages/editor`):

- component resolver: inline span folds into its block text box; block target;
  `display: contents`; positioned inline; atomic media/svg/table; guarded
  wrapper; slide root null; raw path; context direct-child mode.
- SVG math: screen/design delta to user units under scale, rotation, viewBox;
  transform pre-multiplication keeps authored transforms; zero/rounding.
- selection normalization: ancestor/descendant collapse, cross-depth
  multi-selection, same-slide constraint.
- object ops: nested collect/delete/duplicate/paste, id refresh, SVG namespace
  clone, 20 px offset, table-internal refusal.

E2E (`e2e/component-dragging.spec.ts`, tag `@feature:component-dragging`):

- new fixture `test-utils/fixtures/component.deck.html` with a wrapped pad,
  text blocks, a flex chip row, cards, tabs, an icon SVG, a chart figure/SVG,
  an SVG flow with arrow, a table, a group, and locked/hidden objects;
- CD-AC1 through CD-AC9, plus save/undo/reload and clean-HTML assertions.

Existing suites to audit and update where the contract changed: `skeleton`,
`editor`, `drill-in`, `tables`, `charts`, `text-entry`, `insertion`,
`rich-text`, `visual`, `a11y`, `features`.

Feature matrix: add `component-dragging` with its tagged tests; update
`docs/contract.md` (editor component view, superseded slide-level click rule),
`docs/architecture.md`, and `README.md`.

## 8. Risks

- The click-granularity change invalidates existing expectations and muscle
  memory. Hover, breadcrumb, and the Inspector Enter action are the mitigation;
  the superseded rule is documented rather than silently broken.
- Component resolution depends on real computed styles; flex/grid blockification
  and `display: contents` are covered by E2E, not only unit stubs.
- Pinning flow elements changes their layout on first move (accepted in
  2026-10-25); the one-time notice remains.
- SVG-internal movement can rearrange chart or icon parts; it requires entering
  the chart figure and then the SVG, and normal clicks never descend into an
  SVG. The chart figure itself stays atomic so its data contract survives.
- Table cells are selectable but immovable; the hint names the table.
- Nested copy/paste uses a node clipboard; top-level behavior must stay
  byte-compatible and is covered by existing tests.
- Hover hit-testing runs per pointer move; rAF throttling and path-change gating
  keep it cheap.

## 9. Rollout

1. Resolver, hover, click/double-click/Enter changes, and expectation updates.
2. Drag modes: SVG internals, table no-drag, overlay/Inspector state.
3. Nested structural operations and multi-selection at depth.
4. Docs, feature matrix, full `npm run verify` on the final HEAD, green hosted
   CI, manual QA on the built dist, PR.

Every phase starts with a RED test, ends with full `npm run verify` on the final
HEAD and a green hosted CI matrix before the next phase.

## 10. Supersedes

- `docs/superpowers/specs/2026-10-25-nested-container-editing-design.md`: the
  slide-level click rule ("a click selects the direct child of the active
  context") is replaced by component resolution. The editing context,
  breadcrumb, chevron, Esc, appearance, and nested geometry decisions remain.

## 11. Resolved details

- **Chart granularity.** The approved chat design said a chart would select its
  `<svg>` first. Implementation planning found that `chartFigure` and
  `updateChart` require `figure[data-ppt-chart]`; selecting the SVG would break
  the chart dialog and detach the graphic from the card. The final rule is the
  one in D2: the chart figure is atomic and moves as one card; entering it
  exposes the SVG and caption, and entering the SVG exposes its shapes.
- SVG object and non-object lists, the hover label format, and the hint keys are
  pinned in §4.4 and §4.7.
- `commitSlide` serializes only the slide element and restores its authored root
  attributes (`slide-doc.ts:128-167`), so the `<html>`-level hover attribute and
  the injected editor style cannot reach a saved deck.
