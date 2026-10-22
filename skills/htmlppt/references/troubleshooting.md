# Troubleshooting htmlppt

Start with the cheapest probe:

```bash
htmlppt validate deck.html --json     # errors, warnings, info, valid
htmlppt outline deck.html --json      # slide and element ids
```

Through MCP, use `validate_deck` and `get_outline` for the same data. Re-read
before changing a deck after an external edit or a conflict.

## Validation errors

Errors make the deck invalid and block MCP mutations and export. Fix every
error before continuing.

| Code | Fix |
| --- | --- |
| `empty-document` | Add at least one slide with visible content. |
| `nested-slide` | Move the inner slide out of its parent slide so slides are siblings. |
| `invalid-canvas-size` | Use a positive pixel number for `data-width`/`data-height`, or omit both. |
| `invalid-transition` | Use exactly `none`, `fade`, or `slide`. |
| `duplicate-element-id` | Make `data-ppt-el` unique within the slide; ids may repeat across different slides. |
| `invalid-chart-json` | Fix the JSON in `data-ppt-chart`. Use single quotes around a double-quoted JSON attribute. |
| `duplicate-slide-id` | Give every slide a unique, non-empty `data-slide-id`. |
| `invalid-runtime-marker` | Put `data-ppt-runtime="1"` on a `<script>`, or remove the attribute. |
| `duplicate-runtime` | Keep exactly one runtime script per document. |
| `notes-nested-incorrectly` | Make the notes `<aside data-ppt-notes hidden>` a direct child of its slide. |
| `editor-artifacts` | Remove `data-ppt-editing` and `data-ppt-frame-slide`; never save editor internals into the deck. |

## Validation warnings

Warnings do not block saving or export but usually predict a broken round trip.

| Code | Fix |
| --- | --- |
| `missing-title` | Add a non-empty `<title>`. |
| `single-body-fallback` | Add explicit slides (`data-slide-id`); the body fallback is hard to edit. |
| `missing-slide-id` | Add a unique `data-slide-id`. Normalization invents one, but an explicit id is stable. |
| `missing-runtime` | Copy the real runtime script from `examples/basic.html`, or regenerate with `create_deck`/`htmlppt new`. |
| `script-present` | Remove non-runtime scripts or accept that they do not run in the editor. |
| `relative-asset` | Use a `data:` URI or an absolute URL for images, fonts, and `url(...)` values. |
| `fixed-layout` | Replace `position: fixed` and viewport units with fixed-canvas absolute positioning. |
| `mixed-canvas-sizes` | Use one `data-width`/`data-height` for every slide. |
| `canvas-content` | Replace `<canvas>` drawing with editable markup or embed an image. |
| `unsupported-group-nesting` | Flatten nested `data-ppt-group` wrappers. |

## MCP tool failures

Every failure returns `isError: true` and a JSON payload with `code`,
`message`, and context. The full list is in
[mcp-tools.md](mcp-tools.md#error-codes).

### `conflict`

The file changed after the MCP server last read or wrote it. The file was not
modified by the failed call.

1. Call `get_outline` or `read_slide`.
2. Reconcile the external change; do not discard a person's edits.
3. Retry the mutation.

If the caller is a host-attached editor session, the host may also emit a
`revision` event with `source: "mcp"` when an MCP write succeeds. The editor
reloads when it has no unsaved changes and otherwise shows a conflict.

### `slide-not-found`, `target-not-found`, `target-ambiguous`

Your ids or selector are stale, or the target matches more than one node.
Read `get_outline` and `get_element` again. Prefer `elementId` targets after a
read; a selector must match exactly one element inside the slide.

### `invalid-fragment`

`add_element` needs exactly one root element and no non-whitespace text. Wrap
multiple elements in one container, for example a `<div data-ppt-el="...">`.

### `invalid-deck` or `invalid-result`

The deck would be invalid after the operation. The payload includes `errors`
for `create_deck`/`export_deck`; `invalid-result` means the mutation was
rejected before writing. Run `validate_deck` and fix the listed codes. Small
edits make this easier to diagnose.

### `file-exists`

`create_deck` never overwrites. Choose a new path, or ask the user before
replacing the existing deck.

### `editor-unavailable` or `editor-timeout`

`open_editor` starts the built CLI. If it reports `editor-unavailable`, run
`npm run build` so `packages/editor/dist` and the CLI dist exist. If it reports
`editor-timeout`, the CLI did not write a session within 5 seconds: run
`htmlppt open <file> --no-browser` manually and read its stderr. A blocked
session from a busy host is a common cause; stop it first.

### Unexpected host behavior

`HTMLPPT_MCP_MODE=direct` forces direct file access even when a host session
exists. Use it only as a temporary diagnostic; it bypasses host synchronization
and can make the editor miss changes. Unset it for normal operation.

## CLI failures

CLI failures print a message to stderr and exit 1.

| Message | Cause and fix |
| --- | --- |
| `Deck file not found: <file>. Create one with "htmlppt new <file>".` | `open` path is wrong or the deck does not exist. |
| `Deck file not found: <file>.` | `outline` path is wrong. |
| `Deck file could not be read: <file>.` | The path is a directory or permissions block reading. |
| `Refusing to overwrite <file>. Pass --force to replace it.` | `new` found an existing file. Choose another name or pass `--force`. |
| `Invalid --size. Use positive WIDTHxHEIGHT, for example 1600x900.` | Fix the `--size` value. |
| `Invalid --slides. Use a positive integer up to 1000.` | Fix the `--slides` value. |
| `Port <port> is already in use. Omit --port or choose another.` | Another process owns the port. Omit `--port` for a random port. |
| `Editor build not found. Run "npm run build" first.` | `packages/editor/dist` is missing. Build the workspace. |
| `An editor for this deck appears to be running but is not responding. Retry in a moment or run "htmlppt stop <file>" to stop it.` | A recorded host has a live PID but failed the health check (timeout/5xx). Do not start a second host; retry or stop the recorded one. |
| `No live editor session for <file>. Start one with "htmlppt open <file>".` | `stop` found nothing to stop for that deck. |
| `Specify a deck file to stop or pass --all.` | `stop` needs a target. |
| `Pass either a deck file or --all, not both.` | Use one form. |
| `No live editor sessions.` | The registry is empty. |
| `Removed stale editor session for <path>.` | Success: a definitively stale entry was cleaned. |
| `Could not verify a live editor for <path>; leaving it running. Retry "htmlppt stop <path>" when it responds.` | The PID is alive but health is unknown. The entry was kept. Retry later. |
| `No live editor sessions were stopped.` | Nothing was live or cleanable. |
| `The editor session for <path> changed while stopping it. Retry "htmlppt stop <path>".` | The registry changed after verification. Re-run stop. |
| `The editor session for <path> disappeared before it could be stopped.` | The host removed its entry first. No action needed. |
| `The editor process <pid> for <path> did not stop within 5 seconds. Stop it manually, then run "htmlppt stop <path>" again.` | The process ignored or outlived SIGTERM. Inspect the process before killing it manually. |
| `Only html export is available in this milestone. Use --format html.` | PDF and PNG export are not available yet. |
| `Invalid --port. Use an integer between 0 and 65535.` | Fix the port number. |

`open` reuses a live editor for the same deck and prints its existing
`HTMLPPT_URL` instead of starting a second host. The session registry lives
under `~/.htmlppt/sessions`; set `HTMLPPT_HOME` to isolate it for tests or
automation. `HTMLPPT_EDITOR_DIR` overrides the editor build location.

## Editor and host behavior

- Scripts other than the runtime do not run inside the editor. Layout and
  interaction must work from HTML/CSS alone.
- All slides stacked on one page usually means the runtime is missing or the
  runtime script was replaced with an empty marker. Copy the real runtime from
  `examples/basic.html`; the `missing-runtime` warning points at this.
- The editor receives host revision events over SSE. If another writer changed
  the file, save can return 409/conflict; reload and merge.
- A relative image or font may load on the author's machine but disappear in
  export. Validation warns with `relative-asset`; use `data:` or an absolute
  URL.
- Text overflow is usually a missing width on the object. Set an explicit
  `width` inline; do not rely on viewport sizing.
- Notes are hidden in presentation. If they appear on the slide, remove the
  `hidden` attribute only for editing; keep notes in a direct-child aside.
- Transitions only animate between slides when presenting, not while editing.
  `none` is a valid choice, not an omission.

## When to regenerate rather than repair

Regenerate with `create_deck` / `htmlppt new` when the document has no explicit
slides, has deeply nested slides, or has lost its runtime and ids beyond a
small repair. Preserve the user's content by copying it into the fresh
structure, then validate.
