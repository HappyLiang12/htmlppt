# Authoring decks for the htmlppt editor and MCP server

These notes cover how to write decks that stay pleasant to edit by hand, by an
agent, and in the visual editor. The contract itself lives in
[contract.md](contract.md).

## Start from structure, then style

1. Create the deck with `create_deck` or `htmlppt new`. Both produce a valid
   document with slide ids, the canvas size, and the real runtime.
2. Add or replace content as top-level objects. Each object owns its position,
   size, and typography.
3. Add a `<style>` block for the shared visual language.
4. Validate, then open the editor for human review.

Prefer one object per visual block over deeply nested layout. The editor and
MCP tools address top-level objects, so a flat structure is easier to edit and
survives round trips with fewer surprises.

## Editor-friendly structure

- Give every top-level object an explicit `data-ppt-el`. Do not rely on a
  generated id when a later call needs to address the object.
- Keep each object self-contained: position it absolutely inside the slide and
  set an explicit width. Text without a width can overflow the canvas.
- Use real text nodes for content. Text inside CSS `::before`/`::after`,
  background images, or SVG `<text>` is not editable through `set_text`.
- Prefer semantic elements (`h1`, `h2`, `p`, `ul`, `table`, `figure`) so the
  outline reports useful summaries and tags.
- Tables are real `<table>` elements with `<thead>`/`<tbody>`; put
  `data-ppt-el` on the table.
- A `data-ppt-group` wrapper groups related objects. Do not nest group
  wrappers.
- Notes are a direct-child `<aside data-ppt-notes hidden>` of the slide. One
  aside per slide is enough.

Example object:

```html
<div data-ppt-el="e3" style="position: absolute; left: 140px; top: 300px; width: 900px;">
  <h2 style="margin: 0; font-size: 56px;">Why it matters</h2>
  <p style="margin: 24px 0 0; font-size: 30px; line-height: 1.5; color: #4a4f59;">
    Keep the message in a real paragraph so it can be edited in place.
  </p>
</div>
```

## Styling freedom

- Put shared rules in a `<style>` block: colors, type scale, shared object
  classes, print rules.
- Use inline styles for object-specific position, size, and one-off styling.
  `set_style` edits these properties and accepts `null` to remove one.
- CSS custom properties, gradients, shadows, filters, masks, transforms,
  flexbox, grid, inline SVG, and CSS animations are all allowed.
- Web fonts must use a `data:` or absolute URL.
- Keep the fixed canvas in mind. Do not use `position: fixed` or full-height
  `100vh`/`100dvh`/`100svh`/`100lvh` layouts; validation warns (`fixed-layout`)
  because they may not export reliably. Other viewport units are not detected
  by the validator but still scale with the browser window, so avoid them for
  layout. Use absolute positioning inside the 1600x900 (or chosen) canvas.
- Animations that run on their own are preserved. There is no animation
  timeline or trigger authoring in v1.

`set_slide_background` accepts exactly one of `color`, `gradient`, or `image`.
A color uses the `background` shorthand; a gradient or image uses
`background-image`, and the other form is cleared.

## Content edits

- `set_text` replaces an element's text content and escapes HTML. Use it for
  ordinary copy.
- `set_element_html` replaces inner HTML. Use it for deliberate markup changes,
  then validate immediately.
- `update_slide_html` replaces a whole slide's inner HTML. Read the slide first
  with `read_slide`; recreating the objects by hand risks losing ids, notes, and
  styles.
- `add_element` inserts exactly one top-level element. Provide `data-ppt-el` in
  the fragment when you need a stable id; otherwise the returned `elementId`
  tells you the generated id.
- Removing an element uses a target. The slide itself cannot be removed this
  way; use `delete_slide`, and remember the last slide cannot be deleted.
- Slide order changes use `move_slide` or `set_slide_order`; the latter must
  list every slide id exactly once.

Targets for element tools are exactly one of:

```json
{ "elementId": "e3" }
{ "selector": ".card > h2" }
{ "path": [1, 0] }
```

`elementId` matches `data-ppt-el` within the slide. `selector` must match
exactly one element inside the slide. `path` is child indices starting at the
slide element. Missing or ambiguous targets produce stable error codes; read
the outline before guessing.

## Notes, transitions, charts, tables, and images

- `set_notes` writes or clears the direct-child notes aside. An empty string
  removes it.
- `set_transition` accepts `none`, `fade`, or `slide`.
- Chart data lives in `data-ppt-chart` on a `<figure>` as JSON with `type`
  (`bar`, `line`, or `pie`), `labels`, and `series` (`{ name, values }`
  entries). Optional fields are `title`, `colors`, `legend`, and
  `valueLabels`. Labels and each series' values must have the same length, and
  the rendered SVG is derived from the attribute. Use `update_chart` rather
  than editing the SVG. Invalid JSON is a validation error.
- Tables are real `<table>` elements. `add_table` creates one with a header
  row within the 50-row and 20-column core limits.
- `add_image` accepts a data URL, an absolute http(s) URL, or a local path.
  Local files are embedded as data URLs after MIME and 8 MB checks; remote
  URLs are validated but never fetched. Keep assets self-contained.

## Round-trip rules

- Slide ids are unique, non-empty, and stable. Do not renumber slides to
  reorder them; use `move_slide` or `set_slide_order`.
- Object ids are unique within a slide. Do not recycle an id for a different
  object.
- Never write `data-ppt-editing` or `data-ppt-frame-slide`; validation rejects
  saved files containing them.
- Keep the deck self-contained: no relative asset URLs, no external
  stylesheet dependency, no layout that depends on JavaScript.
- Keep one runtime script with `data-ppt-runtime="1"` and the real body.
- Export should not change the meaning of the deck. Notes, transitions, chart
  JSON, and object ids survive export.

## Revision and conflict discipline

Reads and writes are revision-checked. The MCP server remembers the last
revision per file; a host-attached editor also tracks the file revision. If the
file changes between your read and write, the write fails with
`code: "conflict"` and the file is left untouched.

On conflict:

1. Re-read with `get_outline` or `read_slide`.
2. Decide how to reconcile the external change. Preserve edits you did not
   intend to replace.
3. Retry the mutation.

Do not bypass a conflict by rewriting the entire deck unless the user
explicitly asks for that.

## Review and export

- Use `open_editor` (MCP) or `htmlppt open <file>` (CLI) for human review. The
  URL contains a per-session token; treat it as a secret for that session.
- Re-read after a person edits in the editor, because their writes create new
  revisions.
- Run `validate_deck` or `htmlppt validate` before exporting.
- `export_deck` supports HTML only in v1. It writes
  `<name>.export.html` beside the deck or into `outDir`.
