# Authoring decks for htmlppt

These notes describe how an agent should author and edit decks through MCP.

## Start from a template

- Prefer `create_deck` with `title`, `width`, `height`, and `slides` over writing
  a document by hand. The template already contains the runtime, canvas sizes,
  and stable slide ids.
- If you supply `html`, it is normalized and validated before it is written.
- `create_deck` never overwrites an existing file. Choose a new path or ask the
  user before replacing a deck.

## Work in small, validated steps

1. Create or read the deck.
2. Apply one mutation per tool call.
3. Call `validate_deck` after a batch of edits and fix every error.
4. Use `get_outline` for a cheap overview and `read_slide` before replacing
   slide HTML.

Never guess ids: `get_outline` reports slide ids, element ids, tags, and child
paths. `get_element` returns an element's `outerHTML` and raw inline style.

## Targets

Element tools accept exactly one target form:

- `{ "elementId": "e3" }` for a `data-ppt-el` value in the slide.
- `{ "selector": ".card > h2" }` for a selector that matches exactly one element
  inside the slide.
- `{ "path": [1, 0] }` for child indices starting at the slide element.

Missing, ambiguous, and invalid targets produce errors with stable codes. Add
new objects with `add_element` and a `data-ppt-el` attribute when you need a
predictable handle.

## Images, tables, and charts

- `add_image` inserts an `<img>` object. `source` may be a supported image data
  URL, an absolute `http:`/`https:` URL, or a local path. Local paths resolve
  against the server working directory and are read and embedded as data URLs;
  remote URLs are validated but never fetched. Local files must be PNG, JPEG,
  GIF, WebP, AVIF, or SVG and at most 8 MB. The default box is 480x270
  (16:9); an explicit `width` scales the height from that ratio.
- `add_table` inserts a real `<table>` with a header row. `rows` includes the
  header, and the core limits are 50 rows and 20 columns. The default box starts
  at (100, 100) with a width of 960.
- `update_chart` edits an existing chart figure: a `<figure>` carrying
  `data-ppt-chart`. `chart` is a JSON string or object with
  `type` (`bar`, `line`, or `pie`), `labels`, and `series` (`{ name, values }`
  entries). Optional fields are `title`, `colors`, `legend`, and `valueLabels`.
  Labels and each series' values must have the same length, and pie charts need
  one non-negative series with a positive total. The tool stores normalized JSON
  and regenerates the SVG at the figure's persisted size, so do not edit the
  SVG by hand.
- `add_image` and `add_table` accept the same optional `target` insertion
  anchor as `add_element`: the anchor must be a direct child of the slide, and
  the new object is inserted after it; without a target the object is appended.

## Styling

- Inline styles keep authoring local and editable. Use `set_style` for individual
  CSS properties, with `null` to remove a property.
- A deck's shared visual language belongs in a `<style>` block. Avoid
  `position: fixed` and full-height `100vh`/`100dvh`/`100svh`/`100lvh` layouts
  because they may not export reliably. Other viewport units are not detected
  by validation but still scale with the window.
- `set_slide_background` accepts exactly one of `color`, `gradient`, or `image`.
  Colors use the `background` shorthand; gradients and images use
  `background-image`. The previous background form is cleared.

## Content and assets

- Text mutations are plain text: `set_text` escapes HTML. Use `set_element_html`
  when you intentionally need markup.
- Use `data:` URLs for images that must travel with the deck, or absolute HTTPS
  URLs. Relative asset paths are flagged by validation.
- Speaker notes belong in a direct-child `<aside data-ppt-notes hidden>`; use
  `set_notes`.
- Keep chart JSON in `data-ppt-chart` small enough to read and edit directly.

## Conflicts and revisions

Mutation tools return the new `revision`. If the file changed after the last
read or write, the tool fails with `code: "conflict"` and the file is untouched.
Re-read the deck, reconcile the external change, and retry. Do not bypass a
conflict by rewriting the whole file unless the user asks for it.

## Workflow tools

- `open_editor` starts a detached local editor host and returns its tokenized
  loopback URL. It does not modify the deck.
- `export_deck` supports `format: "html"` in this milestone. PDF and PNG export
  arrive later.
