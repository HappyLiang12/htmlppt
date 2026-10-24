# Drill-in container editing

Date: 2026-10-25
Status: model approved in chat (drill-in containers, free drag with a one-time
notice); spec review pending. No implementation starts before approval.

## Context

The editor's unit of editing is the slide's direct children: every top-level
child is an object, and those objects are what the editor manipulates and what
MCP targets address (`docs/contract.md:90-105`). Detection is tolerant
(`packages/core/src/detect.ts`), and the object list is the slide's direct
element children minus scripts, styles, templates, links, meta, and notes
(`packages/core/src/normalize.ts`, `packages/editor/src/selection.ts`).

Hand-written and agent-written decks rarely put content at that level. They
wrap it in layout containers, because that is how CSS layout works. A measured
example: in `aria-conductor-q.html`, slide 1 has five direct children
(`.halo-a`, `.halo-b`, `.staff`, `.pad`, and the notes aside), and every piece of
readable content lives inside `.pad`, three levels deep. The editor therefore
shows four objects, clicking the title selects the whole `.pad`, and the entire
slide is one draggable rectangle.

Nested selection already exists: Alt-click drills to a descendant. It is then
deliberately read-only — dragging is blocked (`packages/editor/src/App.tsx`,
the "Drilled nested selections show read-only geometry" guard), the inspector
computes `readOnly` for any `path.length > 1`
(`packages/editor/src/components/Inspector.tsx:392`), and the appearance state
returns `null` for nested selections (`packages/editor/src/App.tsx:3205-3217`).
The inspector then advises "Select the top-level object first", which is useless
advice when the top-level object *is* the whole content block.

Two facts make the fix smaller than it looks. The mutation layer is already
path-addressed: `applyGeometryEdit` resolves `selection.path` with
`elementAtPath` and pins flow objects to absolute on their first edit
(`packages/editor/src/inspector-state.ts:137-185`). Text editing already works
on nested leaves and commits by copying the whole slide back into the master
document (`packages/editor/src/App.tsx:2781-2789`, `2806-2818`), confirmed live
on the H1 above. What blocks per-element editing is the UI contract, not the
data model.

## Goals

- Enter a layout container and edit its direct children as objects: position,
  size, appearance, and text.
- Leave the top-level `htmldeck/v1` contract, MCP target selectors, and existing
  decks unchanged.
- Make the editing context visible, so a nested selection is never confused
  with a top-level one.
- Never fail silently: a double-click that cannot edit says why.

## Non-goals

- Flattening decks or auto-generating `data-ppt-el` on descendants.
- Nested multi-selection, marquee inside a container, or dragging a selection
  across levels.
- Structural operations on nested selections (duplicate, delete, reorder,
  group, ungroup). They stay top-level only and say so when attempted.
- Editing CSS rules, classes, or stylesheets. Edits stay inline on the selected
  element, as today.
- Changing `data-ppt-group`, which is an authored grouping wrapper with no
  nesting allowed (`packages/core/src/objects.ts:44-51`,
  `packages/core/src/validate.ts:431-440`). Drill-in contexts are layout
  containers, not groups, and must not create or alter group markers.
- MCP addressing of nested elements.
- Navigating into a `<canvas>`; its pixels remain uneditable.

## Decisions

- Editing context is a first-class editor state: `containerPath: number[]`
  (`[]` = slide level), stored next to selection and never persisted in a deck.
- Entering a container changes what a click selects, not how objects are
  addressed. Selection paths stay absolute from the slide root.
- No new attributes and no new ids are written anywhere in the deck. Nested
  edits serialize through the existing whole-slide commit.
- Geometry is free for a single nested selection. A flow-positioned child is
  pinned to absolute on its first geometry edit, exactly like a top-level flow
  object today; the user accepted the resulting layout change in chat.
- A one-time, non-blocking notice explains the pin and offers Undo. It never
  blocks the drag.

## Behavior

### Entering and leaving

- Double-click a container's own painted area (not a text leaf) enters it.
  Pressing Enter with a container selected does the same.
- Each OBJECTS row for a container gains an explicit enter affordance (a
  chevron button with a localized label).
- `Esc` leaves one level; at slide level it clears the selection as today.
- Clicking a slide area outside the active container leaves it.
- A breadcrumb appears whenever `containerPath` is non-empty:
  `slide › .pad › .cover-grid`, each segment a button that jumps to that level.
  It carries `data-testid="edit-context"` and localized `aria-label`s.
- Entering announces the new context through the existing live region.

### Selection

- Inside a context, a click selects the direct child of the context container
  that contains the clicked node; the overlay, handles, and inspector behave
  exactly as they do for a top-level object.
- Alt-click keeps drilling to the deepest element, but only within the current
  context; a nested selection produced this way now shows the same editable
  inspector as a context-level one, so the read-only guard is removed rather
  than duplicated.
- Double-click a text leaf inside the context edits text, unchanged.
- Precedence is deterministic: if the double-clicked node resolves to a leaf
  text element inside the current context, edit text; otherwise enter the
  nearest container at the current level. A container's own padding or
  background therefore enters, while its text leaf edits.
- Selecting a different level by breadcrumb keeps the deepest still-valid
  element selected when possible, otherwise clears the selection.

### Geometry

- Single selection at any depth: X, Y, Width, Height, and Rotation are enabled;
  the overlay handles and keyboard nudges work as at slide level.
- The existing `applyGeometryEdit` pin-on-first-edit is reused as-is. When a
  pin happens, show the notice "This element was positioned by its container;
  it is now absolutely positioned" once per session with an Undo action that
  restores the previous inline style and geometry.
- Multi-selection remains read-only with its current explanation.

### Appearance

- The appearance panel is available for a single selection at any depth, not
  only top-level `div`/`svg`/`img`.
- Kind mapping: `img` keeps image controls; `svg` keeps attribute mapping; every
  other HTML element gets a generic shape mapping built on the existing
  appearance functions (`packages/core/src/appearance.ts:63-159`):
  background colour as fill, border colour and width as stroke,
  border radius, and opacity.
- Text styling beyond an active text session stays out of scope.

### Feedback

- When a double-click cannot start text editing, show a short localized toast
  naming the reason: the element is not a text element, the element has children
  so the container must be entered first, or the element type (`a`, `button`,
  `svg`) does not support inline text editing.
- Replace "Nested selections are read-only. Select the top-level object first."
  with context-aware copy that names the container to enter.
- Structural commands attempted on a nested selection report that they apply to
  top-level objects.

### Accessibility

- Handles and breadcrumb are keyboard reachable with visible focus.
- Enter/leave context works without a pointer; announcements state the context
  and the selected object.
- The toast is announced once and does not steal focus.

## Risks

- Absolute pinning inside transformed or grid containers can compute an offset
  that looks wrong at first. Existing `snapshot.offset` handling covers the
  normal case; E2E must cover a scaled canvas and a grid parent.
- Deeply nested decks need several enters. The breadcrumb is the mitigation.
- Committing the whole slide on every nested edit keeps working, but a very
  large slide now serializes more often; watch save latency in E2E.

## Testing

Unit:

- Enter, leave, and breadcrumb model over a nested fixture; Esc pops one level.
- Click resolution inside a context selects the context's direct child, and
  Alt-click within a context still yields the deepest path.
- Inspector read-only matrix: single nested selection editable, multi-selection
  read-only, top-level unchanged.
- Appearance kind mapping for `p`, `div`, `svg`, and `img`.
- Structural commands reject a nested selection with the documented reason.

E2E (real browser, new fixture `test-utils/fixtures/wrapped.deck.html` that
mirrors the wrapper pattern observed above):

- OBJECTS lists only the wrappers; entering a wrapper lists its children; the
  overlay matches the child's bounding box.
- Drag and resize a nested child: inline `position/left/top/width/height` are
  written, the notice appears once, Undo restores the original inline style.
- Autosave, reload, and the nested changes are still present.
- Change background, border, radius, and opacity on a `p` and reload.
- `Esc` and breadcrumb both change level without losing the deck state.
- Double-click on a `button` shows the explanatory toast instead of silence.

Feature matrix: add ids for drill-in selection, nested geometry, nested
appearance, and edit-context feedback.

## Rollout

Four phases, each with RED tests first, full `npm run verify` on the final
HEAD, and a green hosted CI run before the next phase:

1. Editing-context state, enter/leave, click resolution, breadcrumb.
2. Nested geometry with pin notice and Undo.
3. Appearance for generic elements.
4. Feedback copy, accessibility, and E2E hardening.

Documentation updates: `README.md` (drill-in editing), `docs/contract.md`
(top-level objects are unchanged; containers are enterable and no attributes are
added), `docs/architecture.md` (editor context state).
