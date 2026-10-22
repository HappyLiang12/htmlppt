# htmlppt MCP tools and resources

The htmlppt MCP server exposes 25 tools and 3 resources over stdio. Start it with
`htmlppt-mcp` or `htmlppt mcp`. Tool names and arguments below are the complete
supported surface; there are no other deck tools in this milestone.

## Shared conventions

- `path` is a deck HTML path. A relative path resolves against the MCP server's
  working directory. Responses report the resolved absolute path.
- `slideId` is a slide's `data-slide-id`, for example `s1`.
- `target` is exactly one of:

```json
{ "elementId": "e3" }
{ "selector": ".card > h2" }
{ "path": [1, 0] }
```

  `elementId` matches `data-ppt-el` in the slide, `selector` must match exactly
  one element in the slide, and `path` is child indices starting at the slide
  element.
- Every tool returns one text content item containing JSON. Read tools return
  the data directly. A handler or domain failure sets `isError: true` and
  returns `{ code, message, ...context }`.
- Schema-validation failures are different: the MCP SDK rejects them with the
  `InvalidParams` code (JSON-RPC `-32602`) before the handler runs, and
  delivers that rejection as an `isError: true` text result such as
  `MCP error -32602: Input validation error: Invalid arguments for tool
  set_text: Required at text`. There is no structured `{ code, message }`
  payload to parse. Missing required arguments and wrong argument types take
  this path; check the call against the tool schema and retry. Domain failures
  such as `file-not-found`, `conflict`, or `slide-not-found` use the structured
  payload described above.
- Sending a non-object `arguments` value is a malformed JSON-RPC request; the
  transport reports it as an internal error rather than a tool result.
- Reads return `revision`. Mutations return the new `revision`. The server
  remembers the last revision it read or wrote per file and compares it before
  writing; an external edit produces `code: "conflict"`.
- Each mutation validates the whole document before writing. An invalid result
  is rejected and the file is left unchanged.
- Writes are atomic. In host-attached mode they route through the editor host
  and broadcast a `revision` event with `source: "mcp"`; without a live host
  they write the file directly.

## Read-only tools

### `get_deck_contract`

No arguments. Returns `{ contract, authoring }`: the contract markdown and the
authoring guidance markdown.

### `validate_deck`

Arguments: `{ path }`.

Returns `{ path, revision, errors, warnings, info, valid }`. Each diagnostic has
`severity`, `code`, `message`, and optional `slideId`/`location`. Validation
runs on the authored bytes, not on in-memory normalization.

### `get_outline`

Arguments: `{ path }`.

Returns `{ path, revision, outline }`. The outline contains `title`, `width`,
`height`, `slideCount`, `runtime`, and `slides`. Each slide has `id`, `index`,
`width`, `height`, `transition`, `notes`, and `elements`. Each element has
`id`, `tag`, `path`, `text` (trimmed to 120 characters), `classes`, and
`group`.

Use this before editing to learn slide ids and element ids instead of guessing.

### `read_slide`

Arguments: `{ path, slideId }`.

Returns `{ path, revision, slide }`. The slide contains `id`, `index`, `html`
(the slide's `outerHTML`), `notes`, `transition`, `width`, and `height`.

### `get_element`

Arguments: `{ path, slideId, target }`.

Returns `{ path, revision, html, style }`. `html` is the element's
`outerHTML`; `style` is its raw inline `style` attribute or `null`. No layout
is computed.

## Mutation tools

### `create_deck`

Arguments:

| Name | Type | Notes |
| --- | --- | --- |
| `path` | string | Required. Refuses to overwrite an existing file. |
| `title` | string | Optional deck title. |
| `width` | positive integer | Optional canvas width. |
| `height` | positive integer | Optional canvas height. |
| `slides` | positive integer, max 1000 | Optional slide count. |
| `html` | string | Optional full HTML. Normalized and validated before writing. |
| `runtime` | boolean | Include the runtime. Defaults to true. |

Returns `{ path, revision, created: true }`. An existing path fails with
`file-exists`. An invalid supplied document fails with `invalid-deck` and
includes `errors`.

Prefer `create_deck` over hand-writing a document; it writes the runtime,
canvas size, and stable slide ids.

### `add_slide`

Arguments: `{ path, html?, afterSlideId?, notes?, transition? }`.

Adds one slide after the last slide, or after `afterSlideId`. Returns
`{ path, revision, slideId }` with the new slide id. `html` becomes the slide's
inner HTML. `transition` is `none`, `fade`, or `slide`.

### `update_slide_html`

Arguments: `{ path, slideId, html }`.

Replaces the slide's inner HTML. Returns `{ path, revision }`. Notes and
transition stay on the slide element. Read the slide first.

### `duplicate_slide`

Arguments: `{ path, slideId }`.

Clones one slide and returns `{ path, revision, slideId }` with the clone's id.
The clone inherits notes, transition, and content.

### `delete_slide`

Arguments: `{ path, slideId }`.

Deletes one slide and returns `{ path, revision }`. The last remaining slide
cannot be deleted (`last-slide` error).

### `move_slide`

Arguments: `{ path, slideId, toIndex }`.

Moves one slide to a zero-based index. Returns `{ path, revision }`. The index
must be in `0..slideCount-1` (`index-out-of-range`).

### `set_notes`

Arguments: `{ path, slideId, notes }`.

Sets or clears speaker notes. An empty string removes the notes aside. Returns
`{ path, revision }`.

### `set_transition`

Arguments: `{ path, slideId, transition }`.

Sets a slide transition. `transition` is `none`, `fade`, or `slide`. Returns
`{ path, revision }`.

### `set_slide_background`

Arguments: `{ path, slideId, background }`.

`background` is a strict object with exactly one of `color`, `gradient`, or
`image` set to a non-empty string. A color uses the `background` shorthand; a
gradient or image uses `background-image`, and the other form is cleared.
Returns `{ path, revision }`. Invalid input fails with `invalid-background`.

### `add_element`

Arguments: `{ path, slideId, html, target? }`.

Inserts one raw HTML element as a top-level object. `html` must contain exactly
one root element and no non-whitespace text (`invalid-fragment`). Without
`target` the element is appended; with `target` the anchor must be a direct
child of the slide. Returns `{ path, revision, elementId }`; `elementId` is the
`data-ppt-el` value (added when missing) or `null` for non-object tags such as
`script` or `style`.

### `add_image`

Arguments: `{ path, slideId, source, width?, target? }`.

Inserts one top-level `<img>` and returns `{ path, revision, elementId }`.
`source` is required, and a missing or empty-string value is rejected by the
SDK as `InvalidParams` before the handler runs. A supplied value is one of:

- a supported image data URL (`data:image/...`);
- an absolute `http:`/`https:` URL, validated but never fetched;
- a local image path read from the MCP server process's own filesystem exactly
  as given: an absolute path is used as-is, and a relative path resolves
  against the server working directory. The file is embedded into the deck, so
  pass only assets you intend to embed. Protocol-relative and UNC values
  (`//server/share/x.png` or `\\server\share\x.png`) are not local: they fail
  URL validation as `invalid-image` without being resolved, so a remote share
  is never contacted. Single-letter drive paths such as `C:foo.png` are local.

A whitespace-only `source` reaches the handler and fails with `invalid-image`.
Local files must be PNG, JPEG, GIF, WebP, AVIF, or SVG and at most 8 MB. The
file is opened once, measured through that same descriptor, required to be a
regular non-empty file, and read only up to its measured size. If the path is
not a regular file or the file cannot be opened, measured, or read (including
a file that shrinks during the read), the call fails with `invalid-image`
naming the image path; it never reports the deck as `file-not-found` or
`file-unreadable`. Local bytes are embedded as a data URL, so the deck stays
self-contained. Remote images keep their URL and are not downloaded.

The default box is `x: 100`, `y: 100`, `width: 480`, height `270` (16:9). A
supplied `width` must be a finite number of at least 1 pixel; the height is
`max(1, Math.round(width * 9 / 16))`. `target` is an optional insertion
anchor: it must resolve inside the slide and be a direct child, and the image
is inserted after it; without `target` the image is appended. Failures use
`invalid-image`, `target-not-found`, `target-ambiguous`, `target-invalid`, or
`invalid-insert` from the core insertion checks.

### `add_table`

Arguments: `{ path, slideId, rows, columns, target? }`.

Inserts a real `<table>` with a header row and returns
`{ path, revision, elementId }`. `rows` (including the header row, 1-50) and
`columns` (1-20) must be integers. Missing arguments or non-integer values are
`InvalidParams`; values outside the core bounds fail with `invalid-table`.
The default box is `x: 100`, `y: 100`, width `960`. `target` follows the same
direct-child insertion anchor rules as `add_image` and can fail with
`target-not-found`, `target-ambiguous`, or `target-invalid`.

### `update_chart`

Arguments: `{ path, slideId, target, chart }`.

`target` must resolve to an existing chart: a `<figure>` carrying
`data-ppt-chart`. A target that matches nothing or several elements fails with
`target-not-found` or `target-ambiguous`; anything that resolves but is not a
chart fails with `not-a-chart`. `chart` is required (a missing or wrongly
typed value is `InvalidParams`) and is a JSON string or object:

```json
{
  "type": "bar",
  "title": "Revenue",
  "labels": ["Q1", "Q2"],
  "series": [{ "name": "USD", "values": [12, 18] }]
}
```

`type` is `bar`, `line`, or `pie`; optional fields are `colors`, `legend`, and
`valueLabels`. Labels and every series must be non-empty, values must be finite
numbers with one value per label, and pie charts need exactly one non-negative
series with a positive total. Malformed JSON or invalid data fails with
`invalid-chart` and does not write the deck. The tool normalizes the JSON,
stores it in `data-ppt-chart`, and regenerates the SVG at the figure's
persisted size: inline width at least 160 px and inline height at least 120 px,
then the SVG `viewBox`, then 640x360. A valid short chart (for example 640x140)
keeps its height instead of being resized to 360. Returns
`{ path, revision, width, height }`.

### `set_element_html`

Arguments: `{ path, slideId, target, html }`.

Replaces the element's inner HTML. Returns `{ path, revision }`. Validate after
using intentional markup.

### `set_text`

Arguments: `{ path, slideId, target, text }`.

Replaces the element's text content. The text is escaped, not interpreted as
HTML. Returns `{ path, revision }`.

### `set_style`

Arguments: `{ path, slideId, target, styles }`.

`styles` maps CSS property names to string values, or to `null` to remove a
property. Returns `{ path, revision }`. Invalid property names fail with
`invalid-style-property`.

### `remove_element`

Arguments: `{ path, slideId, target }`.

Removes one element from a slide. Returns `{ path, revision }`. The slide itself
cannot be removed this way (`cannot-remove-slide`).

### `set_slide_order`

Arguments: `{ path, slideIds }`.

Reorders all slides. `slideIds` must contain every slide id exactly once
(`invalid-order`). Returns `{ path, revision }`.

## Workflow tools

### `open_editor`

Arguments: `{ path, port?, open? }`.

Starts a detached local editor host for an existing deck and returns
`{ path, url }`. `url` is a tokenized loopback URL such as
`http://127.0.0.1:53211/?token=...`. `port` defaults to a random port; `open`
(default false) controls whether a browser is launched. The host binds to
127.0.0.1 and permits only the opened deck, its export, and editor assets.

Reuses an existing session only when its authenticated health endpoint answers;
a live PID with a dead port is treated as stale. Fails with
`editor-unavailable` when the CLI build is missing and `editor-timeout` when no
healthy session appears within 5 seconds. On timeout the spawned host process
is terminated instead of being left running.

### `export_deck`

Arguments: `{ path, format, outDir? }`.

`format` is one of `html`, `pdf`, or `png` and defaults to `html`.

- `html` returns `{ path, format: "html", outputPath }` and writes
  `<deck-name>.export.html` beside the deck, or in `outDir` when supplied.
- `pdf` returns `{ path, format: "pdf", files }` with one PDF named
  `<deck-name>.pdf`.
- `png` returns `{ path, format: "png", files }` with one
  `<deck-name>-sN.png` per slide.

PDF and PNG require a system Chrome, Edge, or Chromium (or `HTMLPPT_CHROMIUM`)
and fail with `renderer-unavailable` when none is found; `export-failed`
reports a rendering error. `outDir` resolves against the deck directory and
must stay inside it for every format, in direct and host-attached mode; an
escape fails with `invalid-out-dir`. An invalid deck fails with `invalid-deck`
and includes `errors`.

## Resources

| URI | MIME type | Content |
| --- | --- | --- |
| `htmlppt://contract` | `text/markdown` | The htmldeck/v1 contract. |
| `htmlppt://authoring` | `text/markdown` | Agent authoring guidance. |
| `htmlppt://example` | `text/html` | A complete valid example deck with text, image, shape, table, chart, notes, transitions, and the real runtime. |

Read `htmlppt://contract` and `htmlppt://authoring` before the first edit in a
session. Read `htmlppt://example` when you need a working reference file.

## Error codes

The error payload always includes `code` and `message`, plus `path` and, when
relevant, `slideId`, `target`, `outputPath`, `currentRevision`, or `errors`.

| Code | Meaning and fix |
| --- | --- |
| `conflict` | The file changed after your last read/write. Re-read with `get_outline` or `read_slide`, reconcile, retry. |
| `file-exists` | `create_deck` refuses to overwrite. Choose a new path or ask the user. |
| `file-not-found` | The deck path does not exist. Check the path or create the deck. |
| `file-unreadable` | Permission or path type prevents reading. |
| `file-unwritable` | Permission prevents writing. |
| `directory-not-found` | The parent directory of a new file does not exist. |
| `invalid-deck` | The supplied or exported deck failed validation. Inspect `errors`. |
| `invalid-result` | A mutation would make the deck invalid and was rejected. |
| `renderer-unavailable` | PDF/PNG export found no Chrome, Edge, or Chromium. Install one or set `HTMLPPT_CHROMIUM`. |
| `export-failed` | Rendering or the host export path failed. Read `message` for the actionable detail. |
| `slide-not-found` | The slide id is wrong. Use `get_outline`. |
| `target-not-found` | No element matches the target. Re-read the slide. |
| `target-ambiguous` | The target matches more than one element. Use an id or a narrower selector. |
| `target-invalid` | The selector or path is invalid, or an insertion anchor is not a direct child of the slide. |
| `invalid-fragment` | `add_element` HTML is not exactly one root element. |
| `invalid-image` | `add_image` source is not a supported data/http(s) URL, or a local image cannot be opened, measured, or read, is not a regular file, is empty, has an unsupported type, or is larger than 8 MB. A missing or empty-string `source` is `InvalidParams` before the handler runs. |
| `invalid-out-dir` | `export_deck` `outDir` escapes the deck directory. Use a relative subdirectory such as `exports`. |
| `source-overwrite` | The export destination would replace the source deck (for example a deck named `deck.pdf` exported as PDF). Rename the deck or choose a different `outDir`. |
| `invalid-table` | `add_table` rows or columns are outside the 50x20 core bounds. |
| `invalid-chart` | `update_chart` data is malformed or fails chart validation; the deck is unchanged. |
| `invalid-insert` | A core insert rejected the geometry or content, for example a computed non-positive image size. |
| `not-a-chart` | `update_chart` target is not a `<figure data-ppt-chart>`. |
| `cannot-remove-slide` | The slide/body itself cannot be removed as an element. |
| `last-slide` | The final slide cannot be deleted. |
| `invalid-order` | `set_slide_order` must list every slide id exactly once. |
| `index-out-of-range` | `move_slide` index is outside the slide range. |
| `slide-operations-unavailable` | Slide operations are unavailable on the body fallback. |
| `invalid-style-property` | A style key is not a valid CSS property name. |
| `invalid-background` | Background must set exactly one non-empty color/gradient/image. |
| `invalid-transition` | Transition must be none, fade, or slide. |
| `editor-unavailable` | The built CLI was not found. Run `npm run build`. |
| `editor-timeout` | No healthy editor session appeared within 5 seconds; the spawned host was terminated. Check the editor build and try `htmlppt open`. |
| `internal` | Unexpected failure; the message carries the detail. |
