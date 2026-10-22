---
name: htmlppt
description: Create, edit, validate, preview, and export self-contained HTML presentation decks in the htmlppt (htmldeck/v1) format. Use when asked to build slides, turn an outline or notes into a deck, edit an existing .html deck, work with slide order, speaker notes, or transitions, or drive the htmlppt MCP server or CLI. Not for .pptx or other Office formats.
---

# htmlppt

An htmlppt deck is one self-contained HTML file. Slides are ordinary DOM
elements, styling is ordinary CSS, and every object keeps a stable id so the
visual editor and MCP tools can address it. The HTML file is the source of
truth: there is no sidecar project file.

## When to use this skill

- Create a new presentation from an outline, document, or rough notes.
- Edit an existing deck: text, styling, slides, notes, transitions, or order.
- Validate a deck before sharing or exporting.
- Open the visual editor for human review, or export to standalone HTML, PDF,
  or one PNG per slide.
- Automate deck work through the htmlppt MCP server (`htmlppt-mcp` or
  `htmlppt mcp`) or the `htmlppt` CLI.

Do not use this skill for `.pptx`/PowerPoint files, video, or real-time
collaboration. v1 supports static HTML decks and HTML, PDF, and PNG export.

## Choose a workflow

**MCP-first (preferred when a tool-capable agent is available).** Use the
`htmlppt` MCP server. Read the contract resource once, create or inspect the
deck, mutate in small steps, validate, and only then open or export. The tool
surface is documented in [references/mcp-tools.md](references/mcp-tools.md).

**CLI fallback.** Use `htmlppt` when MCP is not available or a script needs an
exit code. The CLI talks to the same files and contract.

Both workflows are safe to mix: MCP writes are atomic and revision-checked.
The editor receives host revision events over SSE. A clean editor applies
external or MCP changes automatically; unsaved edits surface a conflict banner
with reload or overwrite choices. A save based on an old revision returns
409/conflict.

## Contract at a glance

- Document: `<!doctype html>`, a non-empty `<title>`, and at least one slide.
  Keep the deck self-contained (no build step, no external stylesheet needed).
- Deck wrapper: `<main data-ppt-deck>` is conventional; slides are its
  `[data-slide-id]` descendants.
- Slide: `<section class="slide" data-slide-id="s1" data-width="1600"
  data-height="900">`. Ids must be unique and non-empty.
- Canvas: `data-width`/`data-height` are positive pixel numbers. Omit both for
  1600x900. Keep every slide on the same canvas size.
- Objects: each top-level content child of a slide (text block, image, shape,
  table, figure) is an editable object. Give it `data-ppt-el="e1"`; ids are
  unique within the slide and stable over time. Nested `data-ppt-el` ids are
  allowed but must still be unique in that slide.
- Notes: `<aside data-ppt-notes hidden>Talk track</aside>` must be a direct
  child of its slide.
- Transitions: optional `data-ppt-transition` on a slide; one of `none`,
  `fade`, or `slide`.
- Runtime: multi-slide decks include exactly one
  `<script data-ppt-runtime="1">...</script>` with the real runtime body, not
  an empty marker. `create_deck` and `htmlppt new` write it for you.
- Charts: a figure with `data-ppt-chart='{"type":"bar","labels":["Q1"],"series":[{"name":"USD","values":[12]}]}'`
  holding valid JSON. The rendered SVG is derived from that attribute.
- Assets: use `data:` URIs or absolute URLs. Relative asset paths are flagged
  by validation and do not travel with an exported file. `add_image` embeds a
  local file as a data URL; remote URLs are never fetched.
- No editor artifacts: never write `data-ppt-editing` or
  `data-ppt-frame-slide` into the file.

Full details and validation diagnostics are in
[references/contract.md](references/contract.md).

## Starter template

For a runnable starter, copy [examples/basic.html](examples/basic.html) or let
MCP `create_deck` / `htmlppt new` generate the deck. Both include the real
presentation runtime. The skeleton below abbreviates that script body so the
structure stays readable: replace the placeholder with the runtime from
`examples/basic.html` before presenting the file.

```html
<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>My deck</title>
  <style>
    html, body { margin: 0; padding: 0; background: #0b0d12; }
    .slide {
      width: 1600px;
      height: 900px;
      position: relative;
      overflow: hidden;
      background: #f7f5ef;
      color: #17181c;
      font-family: Inter, ui-sans-serif, system-ui, sans-serif;
    }
    .title { position: absolute; left: 140px; top: 160px; margin: 0; font-size: 96px; }
    .body { position: absolute; left: 140px; top: 340px; margin: 0; font-size: 32px; }
  </style>
</head>
<body>
<main data-ppt-deck>
  <section class="slide" data-slide-id="s1" data-width="1600" data-height="900">
    <h1 class="title" data-ppt-el="e1">My deck</h1>
    <p class="body" data-ppt-el="e2">Replace this text with the opening message.</p>
    <aside data-ppt-notes hidden>Say hello and state the goal of the deck.</aside>
  </section>
  <section class="slide" data-slide-id="s2" data-width="1600" data-height="900" data-ppt-transition="fade">
    <h2 class="title" data-ppt-el="e3" style="font-size: 64px;">Next slide</h2>
    <p class="body" data-ppt-el="e4">Each top-level element is an editable object.</p>
  </section>
</main>
<script data-ppt-runtime="1">/* copy the real runtime body from examples/basic.html */</script>
</body>
</html>
```

**The runtime marker must contain the real runtime source.** Validation only
checks for a `<script data-ppt-runtime="1">` marker; it does not inspect the
script body. A deck saved with the comment above still passes validation but
will not present. Create decks with `htmlppt new` or MCP `create_deck`, or copy
the full runtime from [examples/basic.html](examples/basic.html).

## MCP workflow

1. Learn the contract. Call `get_deck_contract` or read the
   `htmlppt://contract` and `htmlppt://authoring` resources. Read
   `htmlppt://example` when you need a working reference deck.
2. Create or inspect.
   - New deck: `create_deck` with `path`, `title`, and `slides`. It never
     overwrites an existing file.
   - Existing deck: `get_outline` first, then `read_slide` or `get_element`
     before replacing anything. Never guess slide or object ids.
3. Mutate in small steps, one tool call per change. Use `add_slide`,
   `set_text`, `set_style`, `add_element`, `add_image`, `add_table`,
   `update_chart`, `set_slide_background`, `set_notes`, `set_transition`, and
   the other mutation tools listed in the tool reference.
4. Validate after a batch of edits with `validate_deck`. Fix every reported
   error before moving on. Warnings are advisory but should be reviewed.
5. For human review, call `open_editor` and give the returned
   `http://127.0.0.1:<port>/?token=...` URL to the user. Do not open it
   yourself unless asked.
6. Re-read after conflicts. A mutation can fail with `code: "conflict"` when
   someone edited the file after your last read or write. Call `get_outline`,
   reconcile the change, and retry. Never bypass a conflict by overwriting the
   whole file.
7. Export with `export_deck` and `format: "html"` for a self-contained
   `.export.html` file, or `format: "pdf"` / `"png"` for rendered output. PDF
   and PNG need a system Chrome, Edge, or Chromium (or `HTMLPPT_CHROMIUM`).

Every mutation returns a new `revision`. Reads return the revision they
observed. Pass no revision explicitly: the MCP server tracks the last
read/written revision per file and compares it before writing.

## CLI fallback

```bash
htmlppt new deck.html --title "Quarterly review" --slides 3
htmlppt validate deck.html            # exit 0 valid, 1 invalid
htmlppt validate deck.html --json
htmlppt outline deck.html             # human summary
htmlppt outline deck.html --json
htmlppt open deck.html                # prints HTMLPPT_URL=http://127.0.0.1:...
htmlppt open deck.html --no-browser --port 0
htmlppt stop deck.html                # stop one host
htmlppt stop --all                    # stop every live host
htmlppt export deck.html --format html --out dist/deck.html
htmlppt export deck.html --format pdf --out dist/deck.pdf
htmlppt export deck.html --format png --out dist/png
htmlppt mcp                           # same stdio server as htmlppt-mcp
```

PDF and PNG export launch a system Chrome, Edge, or Chromium; set
`HTMLPPT_CHROMIUM` to an executable path when auto-discovery fails. `--out` is
a file for `html`/`pdf` and a directory for `png`.

`open` reuses a live editor for the same deck and prints its URL again. If a
recorded host is alive but not answering health checks, `open` refuses to start
a second host and exits 1; retry or stop the recorded session first.

`stop --all` prunes registry entries whose recorded process has exited. When it
cleans only stale entries it prints `Removed <n> stale editor session(s).` and
exits 0; a truly empty registry still exits 1 with `No live editor sessions.`

## Examples

All examples are complete decks validated by the CLI and contain the real
runtime script.

- [examples/basic.html](examples/basic.html) - text objects, speaker notes,
  `fade` and `slide` transition attributes, runtime.
- [examples/table-chart.html](examples/table-chart.html) - a real table and a
  chart whose JSON lives in `data-ppt-chart`.
- [examples/notes-transitions.html](examples/notes-transitions.html) - notes
  on every slide and all three transition values.

Validate them with:

```bash
htmlppt validate skills/htmlppt/examples/basic.html
```

## Authoring rules that prevent rework

- Use a fixed canvas and absolutely position top-level objects. Validation
  warns (`fixed-layout`) for `position: fixed` and full-height `100vh`,
  `100dvh`, `100svh`, or `100lvh`; those may not export reliably. Other
  viewport units are not detected but still scale with the browser window, so
  avoid them for layout.
- Put styling in a `<style>` block or inline `style` attributes. CSS
  animations, inline SVG, flex/grid inside an object, and web fonts via
  absolute URLs are welcome.
- Do not build layout with JavaScript. Scripts other than the runtime are
  reported by validation and do not run in the editor.
- Keep text in real text nodes. `set_text` writes escaped text; use
  `set_element_html` only when you deliberately need markup.
- Set explicit `data-ppt-el` ids on new top-level objects so later calls have a
  stable handle.
- Use `data:` or absolute URLs for images and fonts. A relative path produces
  the `relative-asset` warning.
- Keep chart JSON small and valid. `data-ppt-chart` is parsed during
  validation.
- Run `validate_deck` / `htmlppt validate` before exporting or handing the deck
  to a person.

## Troubleshooting

Start with [references/troubleshooting.md](references/troubleshooting.md). It
maps validation codes, MCP error codes, and CLI messages to fixes. The most
common issues are a missing or duplicated slide id, a relative asset path, an
invalid transition value, invalid chart JSON, a stale target after someone else
edited the deck, and a conflict that requires a re-read.

## References

- [references/contract.md](references/contract.md) - the full htmldeck/v1
  contract and validation rules.
- [references/authoring.md](references/authoring.md) - editor-friendly
  authoring, styling freedom, and round-trip rules.
- [references/mcp-tools.md](references/mcp-tools.md) - every MCP tool,
  resource, and error code.
- [references/troubleshooting.md](references/troubleshooting.md) - symptom to
  fix for validation, MCP, and CLI failures.
