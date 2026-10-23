# The `htmldeck/v1` contract

A deck is one self-contained HTML document. The same bytes are the authoring
format, the editor's source of truth, and the exported artifact. There is no
sidecar project file. The validator, editor, CLI, and MCP server all implement
this contract.

The contract has three goals:

1. **Self-contained:** the file opens and presents without a build step or a
   server.
2. **Addressable:** slides and objects have stable ids so tools and the editor
   can edit one thing at a time.
3. **Round-trippable:** normal edits preserve authored HTML, CSS, notes,
   transitions, chart data, and ids.

## Document

- Start with `<!doctype html>`.
- Include a non-empty `<title>`. A missing title is a warning
  (`missing-title`), not an error.
- The document must have content; an empty body is an error
  (`empty-document`).
- The deck must contain at least one slide. If none is detected, the body is
  treated as one slide.
- Keep the deck self-contained: CSS belongs in a `<style>` block or inline
  `style` attributes, and assets use `data:` URIs or absolute URLs. No build
  step is required to open or export it.

## Deck wrapper

The conventional, required wrapper for authored decks is:

```html
<main data-ppt-deck>
  <!-- slides -->
</main>
```

The presentation runtime marks it with `data-ppt-ready="1"` after startup. The
validator and detector are tolerant of legacy documents without the wrapper as
long as slides are otherwise detectable, but every generated deck and every
example uses it. Include exactly one wrapper in new files.

## Slide detection

`detectSlides` tries these strategies in order and stops at the first one that
finds elements:

1. Every element with a `data-slide-id` attribute.
2. `.slide`, then `.page`, then `.slide-page`.
3. The largest group of `<section>` elements that share the same parent. Ties
   keep the first group in document order.
4. The body as a single slide with the id `body`.

Recommended slide markup:

```html
<section class="slide" data-slide-id="s1" data-width="1600" data-height="900">
  <!-- top-level objects -->
</section>
```

Rules:

- `data-slide-id` values must be non-empty and unique. Duplicates are an error
  (`duplicate-slide-id`).
- A slide without a `data-slide-id` produces the `missing-slide-id` warning.
  Normalization assigns `s1`, `s2`, and so on using the smallest free number.
- Slides must not be nested inside another slide (`nested-slide` error).
- The body fallback has the fixed id `body` and produces
  `single-body-fallback`. In that mode slide operations such as add, duplicate,
  delete, move, and reorder are unavailable (`slide-operations-unavailable` from
  the core mutation API).
- Class-only and section-group detection are compatibility paths. Authored
  decks should use explicit `data-slide-id` values for stable addressing.

## Canvas

- `data-width` and `data-height` are positive numbers in CSS pixels. A `px`
  suffix is accepted (`1600` and `1600px` are equivalent).
- Omit both attributes to use the 1600x900 default.
- If an attribute is absent, an inline `width: <n>px` / `height: <n>px` on the
  slide element is honored before the default.
- An attribute that is present but not a positive number is an error
  (`invalid-canvas-size`).
- Slides with different canvas sizes produce the `mixed-canvas-sizes` warning.
  Keep one canvas size per deck. PDF export uses the first slide's size.

## Objects

Every top-level child of a slide is an object, except `<script>`, `<style>`,
`<template>`, `<link>`, `<meta>`, and the notes aside. Text blocks, shapes,
images, tables, figures, and group wrappers are all objects.

- Put `data-ppt-el="<id>"` on each authored top-level object. Ids are unique
  within the slide and stable across edits.
- Nested elements may also carry `data-ppt-el`; nested ids share the same
  uniqueness rule within the slide. Duplicate ids are an error
  (`duplicate-element-id`).
- A missing top-level `data-ppt-el` is not a validation error. Normalization
  assigns the smallest free `eN` id and the file is rewritten on the next save.
- Keep each object self-contained: explicit position, size, and typography.
  Top-level objects are what the editor manipulates and what the MCP target
  selectors address.
- A `data-ppt-group` wrapper groups related objects. The wrapper itself is an
  object with its own `data-ppt-el`. Nested group wrappers are not supported
  (`unsupported-group-nesting` warning), and grouping operations reject groups
  whose members are already grouped.
- `data-ppt-locked="true"` marks an object as locked in the editor. It is
  preserved as authored and does not affect validation or presentation.
- `data-ppt-crop="<top> <right> <bottom> <left>"` stores percentage crop insets
  for an `<img>`. Each value is between 0 and 90, and opposite insets must not
  total 100 or more. The editor also writes a matching inline
  `clip-path: inset(...)`.

Objects are styled with inline `style` attributes and CSS classes. The editor
may add `position: relative` to a statically positioned slide root while
editing; otherwise it preserves unknown HTML and CSS.

### Editor-only attributes

The preview iframe may temporarily contain:

- `data-ppt-editing` on an inline text editing target;
- `data-ppt-frame-slide="<random token>"` on the cloned active slide.

These attributes are not part of the saved format. They are removed on commit,
never exist in the master document, and produce an `editor-artifacts` error if
they appear in a file passed to validation.

## Speaker notes

Notes are a direct child of the slide:

```html
<aside data-ppt-notes hidden>Talk track for this slide.</aside>
```

- Notes outside a slide, or nested deeper than a direct child, are an error
  (`notes-nested-incorrectly`).
- One aside per slide is conventional. `set_notes` removes duplicates and
  removes the aside entirely when the new notes string is empty.
- Notes are hidden during presentation and print by the runtime's stylesheet.
  They survive HTML export so the source remains editable.

## Transitions

`data-ppt-transition` is optional on a slide. Its value must be exactly one of:

- `none`
- `fade`
- `slide`

Any other value is an error (`invalid-transition`). The standalone runtime
animates `fade` and `slide` transitions unless the viewer prefers reduced
motion. The editor previews the authored transition.

## Presentation runtime

A standalone multi-slide deck needs exactly one runtime script:

```html
<script data-ppt-runtime="1">/* real runtime body */</script>
```

- A marker is valid only on a `<script>` whose `data-ppt-runtime` value is `1`.
  Any other element or value is an error (`invalid-runtime-marker`).
- More than one valid runtime is an error (`duplicate-runtime`).
- A multi-slide deck with no runtime marker produces the `missing-runtime`
  warning. The document is still valid HTML but cannot present itself.
- Validation checks only the marker, not the script body. An empty or commented
  marker passes validation but will not present. Use `htmlppt new` or MCP
  `create_deck` to write the real runtime, or copy it from
  `skills/htmlppt/examples/basic.html`.
- The runtime handles arrow keys, space, Page Up/Down, Home/End, the `#/n`
  hash, and print styles. Noninteractive clicks advance. `F` toggles fullscreen
  and `P` opens a presenter window with notes, next-slide preview, and a timer.
  Links, buttons, form controls, and editable content keep their own behavior.
- The active slide is scaled to fit the browser viewport with letterboxing,
  using its `data-width`/`data-height` (falling back to its computed size).
  Resizing the window refits it, and each slide keeps its own aspect ratio.
  Screen scaling resets for print so exported pages keep their authored size.
- Multi-slide decks get prev/next buttons and a page indicator pinned to the
  bottom of the window. Single-slide decks get no controls, and controls are
  hidden when printing. Control clicks never advance the deck.
- Do not build layout with JavaScript. Scripts other than the runtime produce
  the `script-present` warning (JSON `application/json` and
  `application/ld+json` blocks are exempt) and never execute in the editor or
  renderer.

HTML export appends the runtime when a deck has more than one
`[data-slide-id]` slide, no runtime marker, and no `<script>` element at all.
It never replaces an existing script.

## Charts

Chart data lives in a JSON attribute on a chart figure:

```html
<figure
  data-ppt-el="e5"
  data-ppt-chart='{"type":"bar","title":"Revenue","labels":["Q1","Q2"],"series":[{"name":"USD","values":[18,24]}],"colors":["#e8a33d"]}'
></figure>
```

Schema:

| Field | Required | Meaning |
| --- | --- | --- |
| `type` | yes | `bar`, `line`, or `pie`. |
| `labels` | yes | Non-empty array of label strings, at most 50 entries. |
| `series` | yes | Non-empty array of `{ name, values }` objects, at most 20. Each name is a non-empty string; values are finite numbers with one value per label. |
| `title` | no | Title string, at most 200 characters. |
| `colors` | no | CSS colors, at least one per series (one per label for pie charts). |
| `legend` | no | Boolean. |
| `valueLabels` | no | Boolean. |

Pie charts require exactly one non-negative series with a positive total.
Validation checks that `data-ppt-chart` is valid JSON (`invalid-chart-json`);
the MCP `update_chart` tool applies the full schema, normalizes the JSON, and
regenerates the SVG at the figure's persisted size. Treat the attribute as the
source of truth: editing only the rendered SVG does not change the data.

## Tables

Tables are real `<table>` elements with `<thead>`/`<tbody>` and cells. Put
`data-ppt-el` on the table object.

- `add_table` creates a header row within the core bounds: 1–50 rows including
  the header, and 1–20 columns.
- The editor supports adding and deleting rows/columns, toggling the header,
  cell fill, and cell borders.
- Merging and splitting cells is not supported. The editor refuses row/column
  structure changes on a table that contains `colspan` or `rowspan` cells, so
  author merged tables only when they do not need structural edits.

## Images and other assets

- Use `data:` URIs or absolute URLs for images, fonts, and other assets.
- Relative `src`/`href` values and relative `url(...)` values in inline styles
  or `<style>` blocks produce the `relative-asset` warning. Relative assets do
  not travel with an exported file.
- `add_image` accepts a supported data URL, an absolute `http(s)` URL
  (validated but never fetched by the Node host), or a local path embedded as a
  validated data URL. Local files must be PNG, JPEG, GIF, WebP, AVIF, or SVG,
  non-empty, and at most 8 MB.
- Arbitrary CSS is allowed: custom properties, gradients, shadows, filters,
  masks, transforms, flexbox, grid, inline SVG, and CSS animations. Use a fixed
  canvas and absolute positioning for top-level objects.
- `position: fixed` and full-height `100vh`/`100dvh`/`100svh`/`100lvh` values
  produce the `fixed-layout` warning because they may not export reliably.
  Other viewport units are not detected by the validator but still scale with
  the browser window; avoid them for slide layout.
- A `<canvas>` produces `canvas-content`: its pixels cannot be edited visually.

## Attributes

| Attribute | Where | Required | Value |
| --- | --- | --- | --- |
| `data-ppt-deck` | Deck wrapper | Yes for authored decks | Boolean marker, conventionally on `<main>`. |
| `data-slide-id` | Slide | Yes for stable addressing | Non-empty string, unique in the deck. |
| `data-width`, `data-height` | Slide | No | Positive pixel number, optional `px` suffix. Default 1600x900. |
| `data-ppt-el` | Top-level object; optional nested | Yes for authored objects | Non-empty string, unique within the slide. Normalization fills missing top-level ids. |
| `data-ppt-notes` | Direct child of a slide | No | Boolean marker on an `<aside hidden>`. |
| `data-ppt-transition` | Slide | No | `none`, `fade`, or `slide`. |
| `data-ppt-runtime` | `<script>` | For standalone multi-slide decks | Exactly `"1"`, exactly one script. |
| `data-ppt-chart` | Chart figure | No | Valid JSON chart object. |
| `data-ppt-group` | Group wrapper | No | Boolean marker; no nested groups. |
| `data-ppt-locked` | Object | No | `"true"` to lock in the editor. |
| `data-ppt-crop` | `<img>` | No | `"top right bottom left"` percentage insets. |
| `data-ppt-editing` | Preview only | Forbidden in saved files | Transient inline text marker. |
| `data-ppt-frame-slide` | Preview only | Forbidden in saved files | Random frame token. |
| `data-ppt-ready` | Deck wrapper | Runtime output | Set to `"1"` by the runtime; do not author. |

## Validation rules

Errors make a deck invalid; warnings do not. The CLI exits `1` for an invalid
deck. `validate_deck` returns every diagnostic with `severity`, `code`,
`message`, and optional `slideId` and `location`.

| Severity | Code | Meaning |
| --- | --- | --- |
| error | `empty-document` | The document has no body content. |
| error | `nested-slide` | A slide is inside another slide. |
| error | `invalid-canvas-size` | An explicit canvas width/height is not a positive number. |
| error | `invalid-transition` | Transition is not `none`, `fade`, or `slide`. |
| error | `duplicate-element-id` | A `data-ppt-el` value repeats within one slide. |
| error | `invalid-chart-json` | `data-ppt-chart` is not valid JSON. |
| error | `duplicate-slide-id` | A slide id repeats. |
| error | `invalid-runtime-marker` | A runtime attribute is not `"1"` on a `<script>`. |
| error | `duplicate-runtime` | More than one valid runtime script. |
| error | `notes-nested-incorrectly` | Notes are not a direct child of a slide. |
| error | `editor-artifacts` | `data-ppt-editing` or `data-ppt-frame-slide` is present. |
| warning | `missing-title` | No non-empty `<title>`. |
| warning | `single-body-fallback` | No slides were detected; the body is one slide. |
| warning | `missing-slide-id` | A detected slide has no `data-slide-id`. |
| warning | `missing-runtime` | Multiple slides but no runtime marker. |
| warning | `script-present` | A non-runtime, non-JSON script is present. |
| warning | `relative-asset` | A relative asset URL is present. |
| warning | `fixed-layout` | `position: fixed` or a full-height viewport unit is present. |
| warning | `mixed-canvas-sizes` | Slides use different canvas sizes. |
| warning | `canvas-content` | A `<canvas>` cannot be edited visually. |
| warning | `unsupported-group-nesting` | A group wrapper is inside another group. |
| info | `slide-count` | Number of detected slides. |

## Normalization and writes

Normalization is deterministic and content-preserving:

- missing slide ids become `s1`, `s2`, ... (smallest free);
- missing top-level object ids become `e1`, `e2`, ... within the slide;
- editor-only attributes are removed when normalization is applied;
- when a browser host supplies static-position detection, a statically
  positioned slide root receives `position: relative` so overlay geometry is
  stable.

It does not invent content, add a runtime, alter authored styles beyond that
positioning guard, or reorder slides. Missing ids are assigned in memory and
persisted on the next write.

All deck writes are atomic: content is written to a temporary file in the
destination directory and renamed into place. Writes can be guarded by the
SHA-256 hash of the revision last read; a changed file produces a structured
`conflict` error and is left untouched.

Serialization writes `<!doctype html>` followed by the document element. HTML
export also adds:

```html
<!-- Edited with htmlppt. Format: htmldeck/v1. -->
```

Serialization goes through a real HTML parser. Valid markup, CSS, notes, chart
JSON, ids, and transitions survive, but byte-for-byte identity is not
guaranteed: parsers may normalize quoting, self-closing syntax, attribute
order, or invalid nesting.

## Export guarantees

- **HTML:** writes a standalone `<name>.export.html` with no editor-only
  attributes. Authored scripts are preserved but are never executed by the
  editor or the renderer. If a multi-slide deck has no runtime and no script at
  all, the runtime is appended. The source deck is not modified.
- **PDF:** renders a snapshot with JavaScript disabled, one page per slide,
  using the first slide's canvas size, backgrounds included, and no editor
  chrome.
- **PNG:** renders one `<name>-sN.png` per slide at 2× device scale. Output
  files are staged and atomically renamed.
- **Round-trip:** opening an exported HTML file in the editor and editing it
  preserves the deck's meaning: slide ids, object ids, notes, transitions, chart
  JSON, and inline styles remain addressable. Scripts remain in the file but do
  not run inside htmlppt.
- **Source safety:** export never writes over the source deck. The host and MCP
  server confine their output directory to the deck directory.
- **Rendering isolation:** the renderer permits only main-frame HTTP(S)
  image/font/stylesheet requests. It blocks navigation, local files, frames,
  workers, WebSockets, fetch/XHR, forms, and objects. See
  [../SECURITY.md](../SECURITY.md).

Opening an exported HTML file directly in a browser is outside those
guarantees: it is ordinary HTML, and any scripts left in it can run there.

## Minimal complete example

This single-slide deck is valid without a runtime and presents as a static
page:

```html
<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Minimal deck</title>
  <style>
    html, body { margin: 0; background: #0b0d12; }
    .slide {
      width: 1600px; height: 900px; position: relative; overflow: hidden;
      background: #f7f5ef; color: #17181c;
      font-family: Inter, ui-sans-serif, system-ui, sans-serif;
    }
    h1 { position: absolute; left: 140px; top: 180px; margin: 0; font-size: 96px; }
    p { position: absolute; left: 140px; top: 340px; margin: 0; font-size: 32px; }
  </style>
</head>
<body>
  <main data-ppt-deck>
    <section class="slide" data-slide-id="s1" data-width="1600" data-height="900">
      <h1 data-ppt-el="e1">Minimal deck</h1>
      <p data-ppt-el="e2">One HTML file, ordinary DOM, ordinary CSS.</p>
      <aside data-ppt-notes hidden>Say hello and state the goal.</aside>
    </section>
  </main>
</body>
</html>
```

For a multi-slide deck, let `htmlppt new` or MCP `create_deck` generate the
file so the real runtime body is present.
