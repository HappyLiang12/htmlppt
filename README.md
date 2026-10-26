# htmlppt

**A local-first visual editor and toolchain for static HTML presentations.**

An agent generates one self-contained HTML deck that follows the
[`htmldeck/v1` contract](docs/contract.md). A person opens the same file in a
local visual editor, adjusts layout and copy, and exports a clean standalone
HTML file, a PDF, or one PNG per slide.

No proprietary project file, no build step, no upload. The HTML file is the
source of truth.

## Why

- **Agents write structure; people judge visuals.** MCP tools create and edit
  semantic HTML with stable ids, while the editor gives a human direct control
  over position, type, color, and slide order.
- **One portable file.** Slides are ordinary DOM elements and styles are
  ordinary CSS. A deck opens in a browser, an editor, or any HTML tool without
  an import/export round trip.
- **Local by design.** The editor host binds to `127.0.0.1`, requires a local
  capability token, and has no cloud service, account, or telemetry.

## Quick start

Install or run the package (from a source checkout, run
`npm ci && npm run build` first, then use the same commands through
`npx htmlppt`):

```bash
npx htmlppt new deck.html --title "Quarterly review" --slides 3
npx htmlppt validate deck.html
npx htmlppt open deck.html
npx htmlppt stop deck.html
```

`htmlppt new` refuses to overwrite an existing file; pass `--force` to replace
it. `--size 1600x900` sets the canvas. `open` prints
`HTMLPPT_URL=http://127.0.0.1:<port>/?token=...` and opens your browser;
`--no-browser` prints the URL only.

The printed URL carries the session token once. `open` reuses the token and
port recorded for the deck, so the deck URL stays bookmarkable while its host
runs; after a crash or reboot, one `htmlppt open` brings the same URL back. The
browser exchanges the token for an HttpOnly, `SameSite=Strict` session cookie
with a 30-day `Max-Age` that successful page loads renew, so the browser stays
signed in for that deck even after the token leaves the address bar. CLI and MCP
output still print the tokenized bootstrap URL for automation.

`htmlppt stop` rotates the token, so a bookmark whose cookie predates the stop
needs one `htmlppt open` afterwards. The recorded port is kept; the next `open`
starts the host with the rotated token, and a request carrying the stale cookie
gets a 401 page that names the deck and the recovery command. An editor host
that still answers health but no longer serves the editor shell (a stale build)
is stopped and replaced by the next `open` instead of handing out a dead URL;
that replacement rotates the token too, so use the newly printed URL.

Inside the editor, type a path into the path field and press Enter to switch
this host to another HTML deck. Relative paths resolve against the host's
working directory, quoted paths (`"deck.html"`) and `~` home paths are accepted,
and `file://` URLs work too. A successful switch keeps the host and its token;
the credential moves to the new deck and the previous deck's credential is
discarded, the address bar becomes `/d/<new-deck-name>`, and saves go to the
new file. Use the folder button to pick a file through the standalone editor
instead, which writes through the File System Access handle.

### MCP setup

Add the stdio server to an MCP client:

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

With the package installed globally, `"command": "htmlppt-mcp"` works too.
The server exposes 25 tools and the `htmlppt://contract`,
`htmlppt://authoring`, and `htmlppt://example` resources. See
[docs/mcp.md](docs/mcp.md) for the full tool surface.

### Agent workflow

1. Read the contract and authoring guidance: call `get_deck_contract`, or read
   the `htmlppt://contract` and `htmlppt://authoring` resources.
2. Create a deck with `create_deck`, or inspect an existing one with
   `get_outline`, `read_slide`, and `get_element`. Do not guess slide or
   element ids.
3. Mutate one change per tool call (`set_text`, `set_style`, `add_slide`,
   `add_image`, `add_table`, `update_chart`, and so on).
4. Validate with `validate_deck`; fix every error before continuing.
5. Hand the deck to a person with `open_editor`, which returns a tokenized
   loopback URL.
6. Export with `export_deck`. If a mutation returns `conflict`, re-read,
   reconcile, and retry instead of overwriting the whole file.

The CLI talks to the same files and contract and is a good fallback for scripts
and exit codes.

## The `htmldeck/v1` contract at a glance

| Part | Contract | Notes |
| --- | --- | --- |
| Deck wrapper | `<main data-ppt-deck>` | Required by the contract; the runtime marks it `data-ppt-ready="1"`. Detection is tolerant for legacy decks, but generated decks always include it. |
| Slide | `section[data-slide-id]` | `data-slide-id` is required for stable addressing; ids are unique and non-empty. Class-only slides are detected but not ideal. |
| Canvas | `data-width`, `data-height` | Optional positive pixel numbers. Omit both for 1600x900. Keep one canvas size per deck. |
| Object | `data-ppt-el="e1"` | Required on each authored top-level object; unique within the slide and stable across edits. Nested ids share the uniqueness rule. |
| Speaker notes | `<aside data-ppt-notes hidden>` | Optional, exactly a direct child of the slide. Empty notes remove the aside. |
| Transition | `data-ppt-transition` | Optional; `none`, `fade`, or `slide`. |
| Runtime | `<script data-ppt-runtime="1">` | Required for a standalone multi-slide deck; exactly one script with the real runtime body. |
| Charts | `<figure data-ppt-chart='...'>` | Optional; valid JSON with `type`, `labels`, and `series`. The SVG is derived from the attribute. |
| Groups | `data-ppt-group` | Optional wrapper for related objects; nesting group wrappers is not supported. |

A minimal valid single-slide deck needs no runtime:

```html
<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <title>Minimal deck</title>
  <style>
    html, body { margin: 0; background: #0b0d12; }
    .slide {
      width: 1600px; height: 900px; position: relative; overflow: hidden;
      background: #f7f5ef; color: #17181c;
      font-family: Inter, ui-sans-serif, system-ui, sans-serif;
    }
    h1 { position: absolute; left: 140px; top: 180px; margin: 0; font-size: 96px; }
  </style>
</head>
<body>
  <main data-ppt-deck>
    <section class="slide" data-slide-id="s1" data-width="1600" data-height="900">
      <h1 data-ppt-el="e1">Minimal deck</h1>
      <aside data-ppt-notes hidden>Say hello and state the goal.</aside>
    </section>
  </main>
</body>
</html>
```

[docs/contract.md](docs/contract.md) covers detection, required and optional
attributes, normalization, validation diagnostics, round-trip rules, and
export guarantees in full.

## Editor features

- **Slides:** add, duplicate, delete, thumbnail rail, sorter view with
  drag-to-reorder, slide counter, zoom.
- **Text:** in-place editing plus bold, italic, underline, strikethrough,
  color, highlight, font family, size, alignment, line height, bullet and
  numbered lists, links, and clear formatting.
- **Objects:** text boxes, shapes, images (upload or URL), tables, and charts;
  select or multi-select, drag, resize with snapping and alignment guides,
  rotate, nudge, align/distribute, group/ungroup, change stacking order, lock,
  hide, copy/paste/duplicate/delete, undo/redo.
- **Inspector:** position and size, rotation, shape fill/stroke/radius/opacity,
  shape text, image alt text and percentage crop, image replacement, chart JSON,
  slide background (color, gradient, or image), transition selection with
  preview, and speaker notes.
- **Presenting:** fullscreen play mode with authored transitions and a
  presenter window showing notes, the next-slide preview, and a timer, synced
  through `BroadcastChannel`.
- **Theme:** the editor chrome supports Light, Dark, and System. The toolbar's
  three-segment control persists the choice per browser origin; System follows
  the operating-system preference. A new host port or origin therefore starts
  with the default System choice because `localStorage` is origin-scoped. Slide
  content, play mode, presenter view, and the exported runtime controls keep
  their own styling.
- **Keyboard and accessibility:** shortcuts for saving, undo/redo, nudge,
  grouping, zoom, and presentation, plus an in-editor shortcut reference (`?`)
  and ARIA-labelled controls.
- **Persistence:** 800 ms autosave, live updates when the file changes
  externally or through MCP, a conflict banner with reload/overwrite choices,
  a best-effort flush on page unload, and IndexedDB crash-recovery drafts
  offered on the next load. Without a host, the editor falls back to an
  upload/download mode: File System Access writes the original file when
  available, otherwise Ctrl+S or Export downloads it.

Layout wrappers are enterable. The OBJECTS list shows a chevron on a container
that holds other objects; click it, or double-click the container's own padding
or background on the slide, to drill into that level. The breadcrumb names the
context, Enter enters a selected container, the inspector lists the container's
direct children, and Escape leaves one level (a breadcrumb segment jumps
straight to it). Inside a container, a click selects its direct children and a
double-click on a text leaf still starts inline text editing. A single entered
object can be moved, resized, rotated, and nudged; the first position or size
edit pins a flow object to absolute positioning, and a one-time notice explains
that change with Undo. Rotating a flow object also pins it to absolute,
silently: the notice covers position and size edits only, so a rotation-first
edit means the notice will not appear for that object later. Position, size,
appearance, and text apply to the selected child at any depth: the appearance
panel writes fill, border, radius, and opacity as inline styles on the element.
Images keep their crop and alt controls, the outermost SVG keeps its attribute
mapping, and SVG descendants are not individually styleable. Structural
commands such as grouping, ordering, and slide operations stay top-level.

## Localization

The editor, play mode, presenter, and runtime controls support English,
Traditional Chinese, and Simplified Chinese. The first visit follows the
browser language; the toolbar language menu persists a manual choice.

Exported decks localize at view time from the viewer's browser unless the deck
sets `data-ppt-locale="en"`, `"zh-Hant"`, or `"zh-Hans"` on `<html>`.

## Export formats

Run export through the CLI, the editor toolbar (Export), or MCP:

```bash
npx htmlppt export deck.html --format html
npx htmlppt export deck.html --format pdf
npx htmlppt export deck.html --format png --out dist/png
```

| Format | Output | Notes |
| --- | --- | --- |
| HTML | `<name>.export.html` | Standalone cleaned file with a generator comment. Editor-only attributes are not present; authored scripts are preserved but never executed by the editor or renderer. |
| PDF | `<name>.pdf` | One page per slide at the first slide's canvas size, backgrounds included, no editor chrome. Mixed canvas sizes produce a validation warning. |
| PNG | `<name>-s1.png`, ... | One image per slide at 2× device scale. |

PDF and PNG require a system Google Chrome, Microsoft Edge, or Chromium. Set
`HTMLPPT_CHROMIUM` to an executable path when auto-discovery fails. No browser
is bundled. `--out` is a file for HTML/PDF and a directory for PNG. PNG creates
its output directory; HTML/PDF require the target file's parent directory to
exist. The host toolbar writes `<name>.export.html`, `<name>.pdf`, or
`<name>-sN.png` next to the deck inside the same confined output directory.
The CLI refuses to overwrite the source deck in any format. The MCP tool
resolves `outDir` against the deck directory, confines it there, and defaults to
the deck directory.

## Security model

- The editor host binds to `127.0.0.1` only. A per-deck capability token is
  recorded in a local credential store and reused by `open` until `htmlppt
  stop` rotates it. The tokenized first visit sets an HttpOnly
  `SameSite=Strict` cookie with a 30-day `Max-Age`; page and API requests accept
  that cookie, while CLI, MCP, and tests may continue to use `Authorization:
  Bearer`. When an `Origin` header is present it must be this host's loopback
  origin.
- Deck scripts never execute in the editor. The preview, thumbnails, sorter,
  and play view use `sandbox="allow-same-origin"` without `allow-scripts`.
- The renderer disables JavaScript, blocks service workers and downloads, and
  permits only main-frame HTTP(S) image, font, and stylesheet requests. Frames,
  workers, WebSockets, navigation, forms, and local-file requests are blocked.
- Host and MCP exports stay inside the deck directory, including through
  symlinks; the CLI refuses to overwrite the source deck.
- There is no cloud service, publishing endpoint, or telemetry.

Read [SECURITY.md](SECURITY.md) for the full threat model and the private
vulnerability-reporting process.

## Limitations

- Static, fixed-size slides only. v1 has no responsive layout mode, slide
  masters, themes, animation timeline, or transitions beyond
  `none`/`fade`/`slide`.
- No PPTX import or export, no video rendering, and no real-time collaboration.
- Scripts other than the presentation runtime are preserved but not executed
  by the editor or renderer; do not build layout with JavaScript.
- Tables support rows, columns, header toggling, cell fill, and borders, but not
  merging or splitting cells. Structural table edits reject merged cells.
- A document with no detectable slides is edited as one body slide; slide
  operations such as add, duplicate, delete, and reorder are unavailable in
  that fallback.
- PDF/PNG export depends on a locally installed Chromium-based browser.
- The project is local-only and pre-1.0. There is no upload, sync, or public
  publishing service.

## Development

Prerequisites: Node.js 20 or newer, Git, and a Chrome/Edge/Chromium build for
PDF/PNG export. Playwright Chromium is needed for E2E tests.

```bash
npm ci
npx playwright install chromium   # once, for E2E
npm run build
npm run verify:fast               # lint, dependency boundaries, types, unit, integration, matrix
npm run verify                    # everything, including E2E and package smoke
```

| Command | Purpose |
| --- | --- |
| `npm run build` | Build every workspace package, including the editor and packaged `htmlppt` bundle. |
| `npm run lint` | ESLint. |
| `npm run lint:deps` | Dependency-boundary checks. |
| `npm run typecheck` | TypeScript strict checks. |
| `npm run test:unit` | Core and editor unit tests. |
| `npm run test:integration` | Builds, then tests renderer, host, MCP, and CLI against real processes and files. |
| `npm run test:e2e` | Builds, then runs Playwright Chromium tests. |
| `npm run test:package` | Builds, packs the `htmlppt` tarball, installs it in a temp project, and smokes the installed bins. |
| `npm run test:matrix` | Feature-tag coverage from `docs/features.json`. |
| `npm run verify:fast` | Fast release gate without E2E or packaging. |
| `npm run verify` | Full release gate. |

See [CONTRIBUTING.md](CONTRIBUTING.md) for the worktree, TDD, and local merge
workflow, and [docs/architecture.md](docs/architecture.md) for package
responsibilities and data flow.

## Documentation

- [docs/contract.md](docs/contract.md) - complete `htmldeck/v1` contract.
- [docs/mcp.md](docs/mcp.md) - MCP modes, tools, resources, errors, transcripts.
- [docs/architecture.md](docs/architecture.md) - packages, data flow, revisions,
  preview commits, presenter protocol, renderer pipeline, tests.
- [docs/testing.md](docs/testing.md) - test strategy and feature-matrix rules.
- [skills/htmlppt/SKILL.md](skills/htmlppt/SKILL.md) - agent-facing skill.

## License

MIT. See [LICENSE](LICENSE).
