# htmlppt MCP server

`htmlppt mcp` (or the `htmlppt-mcp` bin) runs a stdio Model Context Protocol
(MCP) server for agents. It exposes 25 deck tools and 3 resources and edits the
same `htmldeck/v1` files as the CLI and editor.

The server never executes deck scripts and does not provide shell, network, or
arbitrary filesystem tools beyond the deck, image, and export paths documented
here.

## Start it

Installed package:

```bash
htmlppt-mcp
# or
htmlppt mcp
```

Example MCP client configuration:

```json
{
  "mcpServers": {
    "htmlppt": {
      "command": "npx",
      "args": ["-y", "htmlppt", "mcp"]
    }
  }
}
```

Transport: **stdio only**. One JSON-RPC message stream goes in and out; stdout
must stay pure JSON-RPC, so diagnostics are written to stderr. There is no HTTP
listener.

## Modes

The server chooses a storage mode per deck:

| Mode | When | Behavior |
| --- | --- | --- |
| **Host-attached** | A healthy editor host is registered for the deck. | Deck reads, most mutations, and PDF/PNG exports go through the authenticated loopback host. Host-routed writes are validated and broadcast to the editor as `revision` events with `source: "mcp"`. `create_deck` still creates the new file directly, and HTML export writes the cleaned file directly. |
| **Direct** | No live host is found, or `HTMLPPT_MCP_MODE=direct` is set. | Reads and writes the file directly with the server process's permissions. Writes are atomic and revision-checked. |

Host selection is automatic. A host is reusable only when its authenticated
`/api/health` endpoint accepts the deck and it serves the built editor shell; a
health-only host with a broken editor is not treated as host mode. A registry
entry with a live PID but a dead or unauthenticated health endpoint is treated
as stale. `HTMLPPT_MCP_MODE=direct` is a universal override; any other value
allows auto-selection.

## Conventions

- `path` is a deck HTML path. Relative paths resolve against the server's
  working directory; responses report the resolved absolute path.
- `slideId` is a slide's `data-slide-id` value, for example `s1`. Use
  `get_outline` instead of guessing.
- Every tool returns one text content item containing JSON. Read tools return
  the data directly. Domain failures set `isError: true` and return
  `{ code, message, ...context }`.
- Schema-validation failures happen before the handler and are reported by the
  SDK as `InvalidParams` / JSON-RPC `-32602`, for example
  `MCP error -32602: Input validation error: ...`. They do not use the
  structured error envelope.
- Reads return the revision they observed. Mutations return the new revision.
  The server remembers the last revision it read or wrote per file and compares
  it before writing; an external change produces `code: "conflict"`.
- Mutations normalize the document, apply one change, validate the whole deck,
  and write atomically only if it is valid. Invalid results are rejected and the
  file is untouched.
- In host mode, deck mutations other than `create_deck` use the host's save lock
  and revision check; the editor receives the change over SSE. In direct mode,
  the editor's file watcher sees the change on disk.

### Target selectors

Element tools accept exactly one target form:

```json
{ "elementId": "e3" }
{ "selector": ".card > h2" }
{ "path": [1, 0] }
```

- `elementId` matches `data-ppt-el` within the slide.
- `selector` must match exactly one element within the slide.
- `path` is child indices starting at the slide element.

Missing, ambiguous, or invalid targets fail with `target-not-found`,
`target-ambiguous`, or `target-invalid`. Insertion anchors (`target` on
`add_element`, `add_image`, and `add_table`) must resolve to a direct child of
the slide; the new object is inserted after it, or appended when omitted.

## Read tools

| Tool | Arguments | Returns |
| --- | --- | --- |
| `get_deck_contract` | none | `{ contract, authoring }` markdown guidance. |
| `validate_deck` | `path` | `{ path, revision, errors, warnings, info, valid }`. Validates the authored bytes, not the in-memory normalization. Diagnostics include `severity`, `code`, `message`, and optional `slideId`/`location`. |
| `get_outline` | `path` | `{ path, revision, outline }`. The outline has `title`, `width`, `height`, `slideCount`, `runtime`, and `slides`; each slide has `id`, `index`, `width`, `height`, `transition`, `notes`, and `elements`; each element has `id`, `tag`, `path`, `text` (120 characters max), `classes`, and `group`. |
| `read_slide` | `path`, `slideId` | `{ path, revision, slide }` where `slide` has `id`, `index`, `html` (outer HTML), `notes`, `transition`, `width`, and `height`. |
| `get_element` | `path`, `slideId`, `target` | `{ path, revision, html, style }`. `html` is the element's outer HTML; `style` is the raw inline style attribute or `null`. No layout is computed. |

## Mutation tools

| Tool | Arguments | Result |
| --- | --- | --- |
| `create_deck` | `path`, optional `title`, `width`, `height`, `slides` (1–1000), `html`, `runtime` (default `true`) | `{ path, revision, created: true }`. Refuses to overwrite (`file-exists`). Custom `html` is normalized and validated. `runtime: false` removes the runtime marker. |
| `add_slide` | `path`, optional `html`, `afterSlideId`, `notes`, `transition` | `{ path, revision, slideId }`. Inserts after `afterSlideId` or at the end. |
| `update_slide_html` | `path`, `slideId`, `html` | `{ path, revision }`. Replaces the slide's entire inner HTML. The slide element and its transition attribute remain, but child content including the notes aside is replaced; call `set_notes` again if needed. |
| `duplicate_slide` | `path`, `slideId` | `{ path, revision, slideId }` for the clone. |
| `delete_slide` | `path`, `slideId` | `{ path, revision }`. The last slide cannot be deleted (`last-slide`). |
| `move_slide` | `path`, `slideId`, `toIndex` | `{ path, revision }`. `toIndex` is zero-based and must be in range. |
| `set_notes` | `path`, `slideId`, `notes` | `{ path, revision }`. An empty string removes the notes aside. |
| `set_transition` | `path`, `slideId`, `transition` | `{ path, revision }`. `transition` is `none`, `fade`, or `slide`. |
| `set_slide_background` | `path`, `slideId`, `background` | `{ path, revision }`. `background` is a strict object with exactly one non-empty `color`, `gradient`, or `image`. |
| `add_element` | `path`, `slideId`, `html`, optional `target` | `{ path, revision, elementId }`. `html` must be exactly one root element with no non-whitespace text (`invalid-fragment`). `elementId` is the assigned `data-ppt-el` or `null` for non-object tags. |
| `add_image` | `path`, `slideId`, `source`, optional `width`, `target` | `{ path, revision, elementId }`. `source` is a supported data URL, an absolute `http(s)` URL (never fetched), or a local path embedded as a data URL. |
| `add_table` | `path`, `slideId`, `rows`, `columns`, optional `target` | `{ path, revision, elementId }`. `rows` includes the header and is 1–50; `columns` is 1–20. |
| `update_chart` | `path`, `slideId`, `target`, `chart` | `{ path, revision, width, height }`. `target` must be a `<figure data-ppt-chart>`; `chart` is a JSON string or object. Normalizes JSON and regenerates the SVG. |
| `set_element_html` | `path`, `slideId`, `target`, `html` | `{ path, revision }`. Replaces the element's inner HTML. |
| `set_text` | `path`, `slideId`, `target`, `text` | `{ path, revision }`. Replaces text content; the text is escaped, not parsed as HTML. |
| `set_style` | `path`, `slideId`, `target`, `styles` | `{ path, revision }`. Maps CSS property names to string values, or `null` to remove a property. |
| `remove_element` | `path`, `slideId`, `target` | `{ path, revision }`. The slide itself cannot be removed (`cannot-remove-slide`). |
| `set_slide_order` | `path`, `slideIds` | `{ path, revision }`. The array must contain every slide id exactly once (`invalid-order`). |

### `add_image` details

`source` accepts:

- a supported image data URL (`data:image/...`);
- an absolute `http:`/`https:` URL, validated but never fetched;
- a local image path. An absolute path is used as-is; a relative path resolves
  against the server working directory. The bytes are embedded as a data URL,
  so pass only assets you intend to embed. Protocol-relative and UNC values are
  treated as URLs and fail validation; they are never resolved as remote shares.

Local files must be PNG, JPEG, GIF, WebP, AVIF, or SVG, non-empty, regular files
of at most 8 MB. The file is opened once, measured through that descriptor, and
read up to its measured size. The default box is `x: 100`, `y: 100`,
`width: 480`, `height: 270`. A supplied `width` must be at least 1 pixel; the
height is `max(1, round(width * 9 / 16))`.

### `update_chart` details

`chart` is a JSON string or object:

```json
{
  "type": "bar",
  "title": "Revenue",
  "labels": ["Q1", "Q2"],
  "series": [{ "name": "USD", "values": [12, 18] }]
}
```

`type` is `bar`, `line`, or `pie`. Optional fields are `colors`, `legend`, and
`valueLabels`. Labels and each series must be non-empty; values must be finite
and match the label count; pie charts need exactly one non-negative series with
a positive total. Malformed data fails with `invalid-chart` and leaves the deck
unchanged. The SVG is regenerated at the figure's persisted size (inline width
at least 160 px, height at least 120 px, then the SVG `viewBox`, then 640x360).

## Review and render tools

| Tool | Arguments | Result |
| --- | --- | --- |
| `open_editor` | `path`, optional `port`, `open` (default `false`) | `{ path, url }` with a tokenized loopback URL such as `http://127.0.0.1:53211/?token=...`. Starts a detached host; reuses a session only when health and the editor shell both pass, and may replace a stale-build host. |
| `export_deck` | `path`, `format` (`html` default, `pdf`, `png`), optional `outDir` | HTML: `{ path, format: "html", outputPath }` and `<name>.export.html`. PDF: `{ path, format: "pdf", files }` with `<name>.pdf`. PNG: `{ path, format: "png", files }` with `<name>-sN.png` per slide. |

`outDir` is resolved against the deck directory (not the server working
directory) and must stay inside it; an escaping path fails with
`invalid-out-dir`. It defaults to the deck directory. The MCP server creates the
output directory when needed.

`open_editor` reuses an existing session only when both probes pass: the
authenticated `/api/health` endpoint accepts the deck and the editor shell is the
built editor. A health-only host is not success; the CLI replaces a `stale-build`
host (stopping it and starting a fresh one on the recorded port) before the tool
returns a URL. The tool fails with `editor-unavailable` when the built CLI is
missing, `editor-failed` when the spawned CLI exits with a non-zero code or is
terminated by a signal before publishing a healthy session (the message names
the exit code or signal), and `editor-timeout` when no healthy session appears
within 5 seconds; on timeout it terminates the spawned host. A spawned CLI that
exits with code 0 before publishing a session is not `editor-failed`; it
surfaces as `editor-timeout`. `export_deck` requires a system Chrome, Edge, or
Chromium (or `HTMLPPT_CHROMIUM`) for PDF/PNG and fails with
`renderer-unavailable` when none is found. An invalid deck fails with
`invalid-deck` and includes `errors`.

## Resources

| URI | MIME type | Content |
| --- | --- | --- |
| `htmlppt://contract` | `text/markdown` | The `htmldeck/v1` contract. |
| `htmlppt://authoring` | `text/markdown` | Agent-oriented authoring and editing guidance. |
| `htmlppt://example` | `text/html` | A minimal valid deck with text, image, shape, table, chart, notes, transitions, and the real runtime. |

Read `htmlppt://contract` and `htmlppt://authoring` before the first edit in a
session. Read `htmlppt://example` when you need a working reference deck.

## Error codes

Domain errors return `isError: true` with a JSON payload:

```json
{
  "code": "conflict",
  "message": "The deck changed on disk since it was loaded. Re-read the deck with get_outline or read_slide, then retry.",
  "path": "/work/deck.html",
  "currentRevision": "…"
}
```

| Code | Meaning |
| --- | --- |
| `conflict` | The file or host revision changed after the last read/write. Re-read, reconcile, retry. |
| `file-exists` | `create_deck` will not overwrite. Choose another path. |
| `file-not-found` | The deck path does not exist. |
| `file-unreadable` | Permissions or path type prevent reading. |
| `file-unwritable` | Permissions prevent writing. |
| `directory-not-found` | The parent directory for a new file does not exist. |
| `invalid-deck` | Supplied or exported HTML failed validation; inspect `errors`. |
| `invalid-result` | A mutation would make the deck invalid and was rejected. |
| `invalid-fragment` | `add_element` HTML is not exactly one root element. |
| `invalid-image` | Unsupported, missing, empty, oversized, or unreadable image source. |
| `invalid-table` | Table rows/columns are outside the 50x20 bounds. |
| `invalid-chart` | Chart JSON or data is invalid; the deck is unchanged. |
| `invalid-insert` | Core insertion rejected the geometry or content. |
| `not-a-chart` | `update_chart` target is not `<figure data-ppt-chart>`. |
| `cannot-remove-slide` | The slide/body cannot be removed as an element. |
| `last-slide` | The final slide cannot be deleted. |
| `invalid-order` | `set_slide_order` did not list every slide id exactly once. |
| `invalid-out-dir` | `export_deck` `outDir` is whitespace-only or resolves outside the deck directory. |
| `source-overwrite` | `export_deck` would replace the source deck, for example a deck named `deck.pdf` exported as PDF. |
| `index-out-of-range` | `move_slide` index is outside the slide range. |
| `slide-operations-unavailable` | Slide operations are unavailable on the body fallback. |
| `slide-not-found` | The slide id is wrong; use `get_outline`. |
| `target-not-found` | No element matches the target. |
| `target-ambiguous` | The target matches more than one element. |
| `target-invalid` | The selector/path is invalid, or an insertion anchor is not a direct child. |
| `invalid-style-property` | A style key is not a valid CSS property name. |
| `invalid-background` | Background must set exactly one non-empty color/gradient/image. |
| `invalid-transition` | Transition must be `none`, `fade`, or `slide`. |
| `renderer-unavailable` | No Chrome, Edge, or Chromium was found for PDF/PNG. |
| `export-failed` | Rendering or the host export path failed. |
| `editor-unavailable` | The built CLI was not found; run `npm run build`. |
| `editor-failed` | The spawned CLI exited with a non-zero code or was terminated by a signal before publishing a healthy session; the message names the exit code or signal. Run `htmlppt open <file> --no-browser` and read its stderr. |
| `editor-timeout` | No healthy editor session appeared within 5 seconds. |
| `internal` | Unexpected failure; read `message`. |

Schema errors (`InvalidParams`, `-32602`) are separate: check the tool schema and
retry.

## Example transcripts

The examples are abridged JSON-RPC messages over stdio. Revisions are long
hex strings and are shortened here.

### Initialize

```json
{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"example","version":"1.0.0"}}}
{"jsonrpc":"2.0","id":1,"result":{"protocolVersion":"2024-11-05","capabilities":{"tools":{"listChanged":true},"resources":{"listChanged":true}},"serverInfo":{"name":"htmlppt","version":"0.0.0"},"instructions":"Use htmlppt://contract and htmlppt://authoring before editing a deck."}}
```

The server negotiates the protocol version supported by the client/SDK. Send
`notifications/initialized` before issuing normal requests.

### List tools

```json
{"jsonrpc":"2.0","id":2,"method":"tools/list","params":{}}
```

Abridged result:

```json
{"jsonrpc":"2.0","id":2,"result":{"tools":[{"name":"get_deck_contract"},{"name":"validate_deck"},{"name":"get_outline"},{"name":"read_slide"},{"name":"get_element"},{"name":"create_deck"},{"name":"add_slide"},{"name":"update_slide_html"},{"name":"duplicate_slide"},{"name":"delete_slide"},{"name":"move_slide"},{"name":"set_notes"},{"name":"set_transition"},{"name":"set_slide_background"},{"name":"add_element"},{"name":"add_image"},{"name":"add_table"},{"name":"update_chart"},{"name":"set_element_html"},{"name":"set_text"},{"name":"set_style"},{"name":"remove_element"},{"name":"set_slide_order"},{"name":"open_editor"},{"name":"export_deck"}]}}
```

The real response also includes each tool's description and JSON input schema.
The list contains exactly 25 tools: `get_deck_contract`, `validate_deck`,
`get_outline`, `read_slide`, `get_element`, `create_deck`, `add_slide`,
`update_slide_html`, `duplicate_slide`, `delete_slide`, `move_slide`,
`set_notes`, `set_transition`, `set_slide_background`, `add_element`,
`add_image`, `add_table`, `update_chart`, `set_element_html`, `set_text`,
`set_style`, `remove_element`, `set_slide_order`, `open_editor`, and
`export_deck`.

### Read a deck

```json
{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"get_outline","arguments":{"path":"deck.html"}}}
{"jsonrpc":"2.0","id":3,"result":{"content":[{"type":"text","text":"{\"path\":\"/work/deck.html\",\"revision\":\"9f2c…\",\"outline\":{\"title\":\"Quarterly review\",\"width\":1600,\"height\":900,\"slideCount\":2,\"runtime\":true,\"slides\":[{\"id\":\"s1\",\"index\":0,\"transition\":null,\"notes\":\"Opening\",\"elements\":[{\"id\":\"e1\",\"tag\":\"h1\",\"path\":[0],\"text\":\"Quarterly review\"}]}]}}"}]}}
```

(For readability, the tool's text payload is shown as an escaped JSON string
inside the content item.)

### Update text

```json
{"jsonrpc":"2.0","id":4,"method":"tools/call","params":{"name":"set_text","arguments":{"path":"deck.html","slideId":"s1","target":{"elementId":"e1"},"text":"Q3 review"}}}
{"jsonrpc":"2.0","id":4,"result":{"content":[{"type":"text","text":"{\"path\":\"/work/deck.html\",\"revision\":\"a71b…\"}"}]}}
```

### Add an image

```json
{"jsonrpc":"2.0","id":5,"method":"tools/call","params":{"name":"add_image","arguments":{"path":"deck.html","slideId":"s1","source":"assets/chart.png","width":640,"target":{"elementId":"e2"}}}}
{"jsonrpc":"2.0","id":5,"result":{"content":[{"type":"text","text":"{\"path\":\"/work/deck.html\",\"revision\":\"c03e…\",\"elementId\":\"e5\"}"}]}}
```

The local file is read once, validated as a supported image of at most 8 MB, and
embedded as a data URL.

### Export

```json
{"jsonrpc":"2.0","id":6,"method":"tools/call","params":{"name":"export_deck","arguments":{"path":"deck.html","format":"pdf","outDir":"dist"}}}
{"jsonrpc":"2.0","id":6,"result":{"content":[{"type":"text","text":"{\"path\":\"/work/deck.html\",\"format\":\"pdf\",\"files\":[\"/work/dist/deck.pdf\"]}"}]}}
```

An `isError` result instead carries one of the codes above:

```json
{"jsonrpc":"2.0","id":7,"result":{"content":[{"type":"text","text":"{\"code\":\"conflict\",\"message\":\"The deck changed on disk since it was loaded. Re-read the deck with get_outline or read_slide, then retry.\",\"path\":\"/work/deck.html\",\"currentRevision\":\"d18a…\"}"}],"isError":true}}
```
