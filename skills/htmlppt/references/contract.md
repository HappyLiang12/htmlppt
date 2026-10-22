# htmlppt deck contract (htmldeck/v1)

The HTML file is both the authoring format and the saved deck. The validator,
editor, CLI, and MCP server all read and write this same contract.

## Document

- Start with `<!doctype html>`.
- Include a non-empty `<title>`. A missing title is a warning
  (`missing-title`), not an error.
- The document must have content (`empty-document` error otherwise).
- The deck must contain at least one slide.
- The deck is self-contained: keep CSS in a `<style>` block or inline `style`
  attributes, and keep assets inline or on absolute URLs. No build step is
  required to open or export it.

## Deck wrapper and slides

- `<main data-ppt-deck>` is the conventional wrapper. The runtime marks it
  `data-ppt-ready="1"` while presenting.
- Detection order:
  1. Elements with `data-slide-id`.
  2. `.slide`, then `.page`, then `.slide-page`.
  3. The largest same-parent group of `<section>` elements.
  4. The body as a single slide with the id `body`.
- Explicit `data-slide-id` values are required for stable addressing. A slide
  without one is a warning (`missing-slide-id`) and normalization assigns one.
- Slide ids must be unique and non-empty. Duplicates are an error
  (`duplicate-slide-id`).
- Slides must not be nested inside another slide (`nested-slide` error).

Minimal explicit slide:

```html
<section class="slide" data-slide-id="s1" data-width="1600" data-height="900">
  <h1 data-ppt-el="e1">Title</h1>
</section>
```

## Canvas

- `data-width` and `data-height` are positive pixel numbers.
- Omit both to use 1600x900, or set both explicitly.
- An explicitly invalid value is an error (`invalid-canvas-size`).
- When the attributes are absent, an inline `width: <n>px; height: <n>px` on
  the slide is also honored.
- Different sizes across slides produce the `mixed-canvas-sizes` warning.
  Keep one canvas size per deck.

## Objects

- Every top-level child of a slide is an object: text blocks, shapes, images,
  tables, figures, and groups.
- Put `data-ppt-el="<id>"` on each top-level object. Ids are unique within the
  slide and stay stable across edits.
- Nested elements may also carry `data-ppt-el`; they share the same uniqueness
  rule within the slide. Duplicate ids are an error (`duplicate-element-id`).
- Normalization assigns a missing top-level `data-ppt-el` id. It does not
  invent content.
- A `data-ppt-group` wrapper groups objects. Nested group wrappers are not
  supported (`unsupported-group-nesting` warning).
- Objects are edited through inline styles and CSS classes. The editor does not
  write classes or attributes into the slide while you are editing it.

## Speaker notes

- Notes are a direct child of the slide:
  `<aside data-ppt-notes hidden>Talk track</aside>`.
- Notes outside a slide, or nested deeper than a direct child, are an error
  (`notes-nested-incorrectly`).
- `set_notes` removes the aside when the notes string is empty.

## Transitions and runtime

- `data-ppt-transition` is optional and must be `none`, `fade`, or `slide`.
  Any other value is an error (`invalid-transition`).
- Multi-slide decks should include exactly one runtime:
  `<script data-ppt-runtime="1">...</script>` in the document.
- A missing runtime on a multi-slide deck is a warning (`missing-runtime`);
  the deck is still valid HTML but cannot present itself.
- The runtime body must be the real runtime script, not an empty marker.
  `create_deck` and `htmlppt new` write it. Copy it from
  `../examples/basic.html` when hand-authoring.
- More than one runtime marker is an error (`duplicate-runtime`). A
  `data-ppt-runtime` attribute whose value is not `1`, or on an element other
  than `<script>`, is an error (`invalid-runtime-marker`).
- The runtime handles the first/last slide, arrow keys, space, Page Up/Down,
  Home/End, the `#/n` URL hash, and print styles. Do not replace it with custom
  navigation unless the user asks and accepts that the editor will not run it.

## Charts

- Chart data lives in `data-ppt-chart` on a figure (or another element) and
  must be valid JSON (`invalid-chart-json` error otherwise).
- A typical chart attribute:

```html
<figure
  data-ppt-el="e5"
  data-ppt-chart='{"type":"bar","title":"Revenue","labels":["Q1","Q2"],"series":[{"name":"USD","values":[18,24]}],"colors":["#e8a33d"]}'>
</figure>
```

- Keep the JSON small enough to read and edit directly. Treat the attribute as
  the source of truth: any rendered chart is derived from it, so editing only
  the rendered output would not change the data.

## Assets and styling

- Use `data:` URIs or absolute URLs for images, fonts, and other assets.
- Relative `src`/`href` values and relative `url(...)` values produce the
  `relative-asset` warning. They do not travel with an exported file.
- Arbitrary CSS is allowed: custom properties, flex/grid inside objects,
  inline SVG, CSS animations, shadows, gradients, and absolute web fonts.
- `position: fixed` and viewport-height units (`vh`, `dvh`, `svh`, `lvh`)
  produce the `fixed-layout` warning because they may not export reliably.
- A `<canvas>` produces the `canvas-content` warning: its drawing cannot be
  edited visually.
- Scripts other than the runtime produce the `script-present` warning. The
  editor does not execute them.

## Round-trip and writes

- Serialization writes `<!doctype html>` followed by the document element. The
  MCP/editor path removes editor-only attributes before writing:
  `data-ppt-editing` and `data-ppt-frame-slide` are always rejected by
  validation (`editor-artifacts` error) if present in a saved file.
- HTML export adds the generator comment
  `<!-- Edited with htmlppt. Format: htmldeck/v1. -->` and, for a multi-slide
  deck with no runtime and no script at all, appends the runtime.
- Writes are atomic (temporary file plus rename) and compare against the
  revision last read or written. A changed file produces a structured
  `conflict` error; re-read and retry.
- Normalization may add missing slide/object ids; the editor may also add a
  relative position to statically positioned slide roots. Unknown HTML and CSS
  are preserved otherwise.

## Validation summary

Errors make a deck invalid; warnings do not.

| Severity | Code | Meaning |
| --- | --- | --- |
| error | `empty-document` | No content in the document. |
| error | `nested-slide` | A slide is inside another slide. |
| error | `invalid-canvas-size` | Explicit canvas width/height is not positive. |
| error | `invalid-transition` | Transition is not none, fade, or slide. |
| error | `duplicate-element-id` | An element id repeats within a slide. |
| error | `invalid-chart-json` | `data-ppt-chart` is not valid JSON. |
| error | `duplicate-slide-id` | A slide id repeats. |
| error | `invalid-runtime-marker` | Runtime attribute is not `1` on a script. |
| error | `duplicate-runtime` | More than one runtime script. |
| error | `notes-nested-incorrectly` | Notes are not a direct child of a slide. |
| error | `editor-artifacts` | Editor-only attributes are present. |
| warning | `missing-title` | No `<title>`. |
| warning | `single-body-fallback` | No slides found; the body is one slide. |
| warning | `missing-slide-id` | A slide has no `data-slide-id`. |
| warning | `missing-runtime` | Multiple slides but no runtime. |
| warning | `script-present` | A non-runtime script is present. |
| warning | `relative-asset` | A relative asset URL is present. |
| warning | `fixed-layout` | Fixed or viewport-sized layout is present. |
| warning | `mixed-canvas-sizes` | Slides use different canvas sizes. |
| warning | `canvas-content` | A `<canvas>` cannot be edited visually. |
| warning | `unsupported-group-nesting` | Groups are nested. |
| info | `slide-count` | Number of detected slides. |
