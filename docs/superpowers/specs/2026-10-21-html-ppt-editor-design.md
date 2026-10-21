# htmlppt — Design Spec

Date: 2026-10-21
Status: revised — awaiting review
Package: `htmlppt` (npm, MIT)
Project root: `html-ppt-editor`

## 1. Problem and goal

People create presentation decks as static HTML, often with an AI agent. Updating a deck afterwards is painful: the user must edit HTML/CSS/JS, or re-prompt the agent and hope nothing else changes.

htmlppt is an open-source, PowerPoint-like editor for static HTML decks, plus an agent integration layer:

- Humans edit decks visually in a browser without touching code.
- Agents generate and modify decks through a skill and MCP tools, staying inside a lightweight HTML contract.
- One HTML file remains the source of truth. No proprietary format.
- A local host process owns the deck state and file I/O; the same host module is the seam for a future hosted sharing and co-editing platform.

## 2. Product surfaces

| Surface | Audience | Purpose |
|---|---|---|
| `skill` | Agents | Teach the deck contract, authoring patterns, and MCP workflow |
| MCP server | Agents | Create, inspect, validate, edit, export decks; open the editor |
| CLI | Humans | Scaffold, validate, open the editor, export, run the MCP server |
| Host | Editor + future platform | Own deck state, revisions, file writes, live updates, exports |
| Editor | Humans | Visual PowerPoint-like editing in the browser |

### Core principles

1. HTML is the source of truth. No sidecar data file; notes, transitions, and chart data live in the HTML.
2. Preserve agent work. The editor changes only touched nodes; the original head, styles, fonts, scripts, and structure survive.
3. Loose contract. Agents keep full CSS/HTML freedom; the contract only fixes slide containers, canvas size, and a few optional metadata attributes.
4. Top-level objects are freely transformable; nested elements are style- and text-editable. This is the reliability boundary of DOM-native editing.
5. Local-first and offline by default. The editor runs at `127.0.0.1`; no account or cloud is required.
6. Host-first architecture. Live state, revisions, and broadcasting live in the host so a future cloud platform can reuse them.

## 3. Deck contract (htmldeck/v1)

An agent-generated deck SHOULD follow this contract. The importer tolerates deviations and reports warnings; fidelity and editing reliability are best when the contract is met.

```html
<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <title>Quarterly review</title>
  <link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Inter:wght@400;700&display=swap">
  <style>
    .slide { width: 1600px; height: 900px; background: #fff; position: relative; overflow: hidden; }
    .title { font: 700 96px/1.1 Inter, sans-serif; margin: 0; }
  </style>
</head>
<body>
  <main data-ppt-deck>
    <section class="slide" data-slide-id="s1" data-width="1600" data-height="900" data-ppt-transition="fade">
      <h1 class="title" data-ppt-el="e1">Quarterly review</h1>
      <aside data-ppt-notes hidden>Welcome. Keep this to 30 seconds.</aside>
    </section>
    <section class="slide" data-slide-id="s2" data-width="1600" data-height="900">
      <h2 class="title" data-ppt-el="e2">Revenue</h2>
      <figure data-ppt-chart='{"type":"bar","title":"Revenue","labels":["Q1","Q2"],"series":[{"name":"USD","values":[12,18]}],"colors":["#e8a33d"]}'>
        <!-- rendered SVG -->
      </figure>
    </section>
  </main>
  <script data-ppt-runtime="1">/* bundled presentation runtime */</script>
</body>
</html>
```

### Required

- One self-contained HTML file with a doctype.
- Each slide: `<section class="slide" data-slide-id="...">` with a unique id and a fixed canvas size.
- Canvas size: `data-width` / `data-height` attributes, with CSS width/height as fallback. Default 1600 × 900.
- Slides stack in normal document flow. No `position: fixed` slide, no scroll-driven layout.
- All content required to render the slide is in the HTML/CSS. No JavaScript needed for layout.
- Assets are `data:` URLs or absolute `http(s)://` URLs. Relative local assets are unsupported and produce a warning.

### Optional metadata

| Attribute / element | Meaning |
|---|---|
| `data-ppt-el="<id>"` on a top-level object | Stable object id used by MCP and the editor |
| `data-ppt-group` on a wrapper | Group of objects; wrapper is a top-level object |
| `data-ppt-locked="true"` | Locked in the editor; still rendered |
| inline `display:none` | Hidden object; preserved in export |
| `data-ppt-notes` on an `aside` (hidden) | Speaker notes, plain text |
| `data-ppt-transition="none\|fade\|slide"` on a slide | Slide transition for the runtime and Play mode |
| `data-ppt-chart='{...}'` on a figure | Editable chart data; rendered SVG is a child |
| `<table>` | Native table; editable cells |
| `data-ppt-runtime="1"` inline script | Presentation runtime; preserved, never executed in the editor |
| `data-ppt-deck` on a container | Optional deck root marker; detection works without it |

### Runtime

- A small, self-contained inline script (no imports) providing keyboard/click navigation, slide transitions, notes-aware presenter view, and print CSS.
- Included by `htmlppt new`, MCP `create_deck`, and the editor's "add runtime" action.
- Preserved by the editor and on export. Scripts are disabled inside the editing iframe.
- Decks with their own navigation script may omit the runtime; the editor warns that presentations may not work.

## 4. Feature scope

### v1 (first release)

**Slides**
- Thumbnail rail and slide sorter view.
- Add, duplicate, delete, reorder.
- Per-slide background (solid, gradient, image URL).
- Speaker notes.
- Transitions: none, fade, slide.

**Objects**
- Single select and Shift multi-select; clicking empty slide area clears the selection. No marquee selection in v1.
- Move, resize, rotate; snapping and alignment guides.
- Align and distribute.
- Group/ungroup; move/rotate groups; no group resize.
- Z-order: forward, backward, front, back.
- Lock and hide, with an objects panel to recover them.
- Duplicate, internal copy/paste, delete.
- Undo/redo for all content operations.

**Text**
- In-place editing with per-character formatting: bold, italic, underline, strikethrough, color, highlight, font family, font size.
- Block formatting: alignment, line height, bulleted/numbered lists.
- Hyperlinks.
- Text boxes; text inside shapes.
- Style changes apply to the current selection (characters) or the whole block when there is no selection.

**Shapes and images**
- Rectangle, rounded rectangle, ellipse, triangle, line, arrow.
- Fill, border, radius, opacity, rotation.
- Text inside shapes.
- Image insert, replace, crop (basic), border radius, opacity, alt text; embedded as data URLs.
- Drag-drop image files and paste images from the clipboard.

**Tables**
- Insert a table; edit cell text.
- Insert/delete rows and columns; toggle header row.
- Cell background, borders, text formatting.
- No cell merge/split in v1.

**Charts**
- Data-driven inline SVG: bar, line, pie.
- Title, labels, one or more series, colors, legend, value labels.
- Edit chart data and style; re-render in place.
- No external data sources, no live data.

**Presentation**
- Full-screen play mode with keyboard/click navigation and transitions.
- Presenter view: notes, next-slide preview, timer, prev/next controls; main window fullscreen.
- Exported decks present through the bundled runtime (including presenter view).

**Files and export**
- Open a local HTML file and save back in place.
- Autosave and crash recovery.
- Export static HTML.
- PDF (one page per slide) and PNG (per slide) through the host using a system Chromium browser.
- Standalone editor fallback: upload/download mode.

**Agent integration**
- Skill teaching the contract and workflow.
- MCP server with the tool set in section 6.
- CLI with scaffold, validate, outline, open, export, stop, and MCP commands.
- MCP resources exposing the contract and an example deck.

**Quality**
- Import diagnostics.
- Visual round-trip tests.
- Keyboard shortcuts and accessible focus states.
- Windows, macOS, and Linux; Chromium-based browsers for the full experience; Firefox/Safari degrade to upload/download where APIs are missing.

### Out of scope for v1

- Real-time multi-user co-editing, presence, comments, accounts.
- Slide themes / master slides editing; decks keep the agent's CSS.
- Animation timeline authoring; existing CSS animations are preserved but not configurable.
- Video/audio, SmartArt, 3D, transitions beyond fade/slide.
- `.pptx` import or export.
- Merging cells; chart types beyond bar/line/pie; external data.
- Slide size changes; mixed-size decks are supported for editing but PDF uses a single page size.
- Mobile editing UI; the editor targets ≥ 1280 × 800.

## 5. Architecture

### Modules

```
packages/
  core/     deck parsing, contract detection, validation, mutations, chart SVG,
            serialization, runtime template, shared types
  host/     Node service: deck session, revisions, atomic writes, file watching,
            SSE, exports, session registry; storage adapter interface
  editor/   React SPA: iframe canvas, selection/transform, rich text, tables,
            charts, notes, play/presenter, persistence clients
  cli/      command entry points; bundles editor assets for distribution
  mcp/      stdio MCP server; direct-file and host adapters
  runtime/  presentation runtime source embedded into decks
skills/htmlppt/   agent skill (SKILL.md + references + examples)
examples/         fixture and demo decks
e2e/              Playwright tests
docs/             contract, architecture, MCP reference, contributing
```

### Distribution

- One published npm package: `htmlppt`.
- Bins: `htmlppt` (CLI) and `htmlppt-mcp` (MCP stdio server).
- The package bundles built editor assets, core, host, MCP, runtime, and the skill files.
- Internal workspace packages are implementation details; they are bundled at publish time.
- Node.js >= 20. MIT license. No telemetry.

### Source of truth

The HTML file is authoritative. The host holds a `DeckSession` for a file:

- `path`
- current HTML
- revision (content hash and monotonic counter)
- last writer (editor or external)
- file watcher

Every mutation (editor, MCP direct, MCP via host) produces a new valid HTML document. Writes are atomic (temp file + rename). The session broadcasts revision changes over SSE.

### Editors and iframes

- The editor renders the active slide inside a sandboxed iframe (`sandbox="allow-same-origin"`, scripts disabled) built from the master `<head>` plus that slide.
- Iframe viewport equals the slide canvas, scaled with a CSS transform to fit the editor; pointer coordinates are design pixels.
- Selection chrome, guides, and handles render in an overlay outside the iframe. No editor classes or attributes are written into the slide.
- The editor holds the whole deck as a master `Document`; on each commit, a cleaned clone of the active slide replaces the corresponding node in the master.
- Standalone browser mode uses the same editor with a browser persistence adapter.

### Data flow

1. Open file → host loads and normalizes → `GET /api/deck` → editor builds master document → renders thumbnails and active slide.
2. Edit gesture → overlay coordinates → command mutates iframe DOM → history snapshot → cleaned slide synced into master → `PUT /api/deck` with `baseRevision` → host writes atomically → SSE broadcasts new revision.
3. Agent MCP write → direct file adapter or host adapter → same normalization/validation → host broadcast if attached.
4. External file change → host watcher → SSE event → editor auto-reloads when clean, or shows a conflict banner when dirty.
5. Export → serialize master → write HTML/PDF/PNG.

### Repository and open-source setup

- npm workspaces; TypeScript strict; Vite for the editor; tsup for Node entry points.
- Root scripts: `dev`, `build`, `test`, `test:e2e`, `lint`, `typecheck`, `pack`, `release`.
- GitHub Actions CI on Node 20 and 22, Ubuntu and Windows: install, lint, typecheck, unit tests, build, Playwright E2E, package smoke test.
- Release workflow on git tag: build, test, `npm publish` using `NPM_TOKEN`, create a GitHub release.
- The GitHub repository and npm credentials are provided by the owner at publish time; local development does not depend on them.
- README: quick start, agent setup, CLI/MCP reference, contract link, screenshots, roadmap.
- LICENSE: MIT. CONTRIBUTING and SECURITY documents included.

## 6. MCP server

### Modes

1. **Direct file (default).** Stdio MCP server started by the agent client. Reads/writes the target file through core, with content-hash checking and atomic writes. No host or browser required.
2. **Host-attached.** If an editor host session is registered for the file, the MCP server discovers it (`~/.htmlppt/sessions/*.json`) and routes mutations through the host API so open editors update live.
3. **Remote (future).** The host exposes an HTTP MCP endpoint; the same tool schemas connect to a shared deck on a platform. Not implemented in v1; the tool layer is transport-agnostic.

MCP tools are transport-agnostic adapters over the same `DeckService`. Tool schemas do not change between modes.

### Tools

Read-only:

- `get_deck_contract` — returns the contract and authoring guidance.
- `validate_deck({ path })` — errors/warnings/info with locations.
- `get_outline({ path })` — title, canvas, slide ids, object ids/paths/tags/text summaries, notes, transitions, runtime presence.
- `read_slide({ path, slideId })` — slide HTML plus notes and metadata.
- `get_element({ path, slideId, target })` — outerHTML and the inline `style` attribute (no layout computation).

Mutations (all validate before writing; return the new revision):

- `create_deck({ path, title?, width?, height?, slides?, html?, runtime? })`
- `add_slide({ path, html?, afterSlideId?, notes?, transition? })`
- `update_slide_html({ path, slideId, html })`
- `duplicate_slide({ path, slideId })`
- `delete_slide({ path, slideId })`
- `move_slide({ path, slideId, toIndex })`
- `set_notes({ path, slideId, notes })`
- `set_transition({ path, slideId, transition })`
- `set_slide_background({ path, slideId, background })`
- `add_element({ path, slideId, html, target? })` — raw HTML, inserted as a top-level object
- `set_element_html({ path, slideId, target, html })`
- `set_text({ path, slideId, target, text })` — replaces the element's text content
- `set_style({ path, slideId, target, styles })` — inline CSS properties
- `remove_element({ path, slideId, target })`
- `add_image({ path, slideId, source, width?, target? })` — source is a data URL, absolute URL, or local path (embedded as data URL)
- `add_table({ path, slideId, rows, columns, target? })`
- `update_chart({ path, slideId, target, chart })`
- `set_slide_order({ path, slideIds })`

Workflow:

- `open_editor({ path, port?, open? })` — ensures a host session exists, opens the browser, returns the URL. Detached host; a CLI `stop` command manages lifetime.
- `export_deck({ path, format: "html" | "pdf" | "png", outDir? })` — writes files via host/CLI; returns absolute paths.

Target selector:

- `{ elementId }` referencing `data-ppt-el`, or `{ selector }` matching exactly one element within the slide, or `{ path: number[] }` of child indices from the slide.
- Ambiguous or missing targets produce an actionable error.

MCP resources:

- `htmlppt://contract` — the deck contract.
- `htmlppt://example` — a minimal multi-slide deck with text, image, shape, table, chart, notes, transition, and runtime.
- `htmlppt://authoring` — best practices for agents.

Safety:

- Writes are serialized per file within the MCP process.
- Direct mode checks the file hash before writing; if it changed since read, the tool fails with a conflict and asks the agent to re-read.
- Host mode uses optimistic concurrency (`baseRevision`); on 409 the agent must re-read.
- Errors are structured and include the file, slide, and target.

## 7. CLI

```
htmlppt new <file> [--title <t>] [--slides <n>] [--size 1600x900]
htmlppt open <file> [--port 0] [--no-browser]
htmlppt validate <file> [--json]
htmlppt outline <file> [--json]
htmlppt export <file> --format html|pdf|png [--out <path>]
htmlppt mcp [--host <url>]
htmlppt stop [<file> | --all]
htmlppt --version
```

- `new` scaffolds a contract deck with the runtime and a sample title slide.
- `open` starts the host, writes a session registry entry, opens the browser to `http://127.0.0.1:<port>/?token=...`, and prints the URL. `--no-browser` is useful for remote shells.
- `export html` can run without a host; PDF/PNG use the host renderer.
- `mcp` and the `htmlppt-mcp` bin are equivalent.
- All commands support `--help`; errors are actionable and non-zero on failure.

## 8. Agent skill

Location: `skills/htmlppt/SKILL.md` plus references and examples. Installed by copying into the agent's skills directory or through the agent's supported skill installation mechanism; the README documents both.

The skill MUST cover:

- When to use it: creating or updating an HTML presentation deck.
- The contract and a complete starter template.
- Editor-friendly authoring: fixed canvas, top-level object structure, real text nodes, tables, chart data attributes, notes, transitions, runtime.
- Styling freedom: arbitrary CSS, fonts via absolute URLs, inline SVG, flex/grid inside objects, CSS animations; no JS layout, no scroll-driven slides.
- Round-trip rules: unique slide ids; optional `data-ppt-el`; no editor artifacts; self-contained assets.
- MCP workflow: create or write → `validate_deck` → fix errors → optionally `open_editor` for human edits → read back with `get_outline`/`read_slide` before further edits.
- Examples: multi-slide deck, table slide, chart slide, notes, transitions.
- Common failures and fixes: missing canvas size, relative images, nested object transforms, JS-dependent layout.

The skill is authored with the skill-creator workflow during implementation.

## 9. Host

### API

Local HTTP server bound to `127.0.0.1` (port 0 by default), serving the editor and a JSON API.

- `GET /` and static assets — editor SPA.
- `GET /api/deck` → `{ html, revision, filePath, mtime, title }`.
- `PUT /api/deck` `{ html, baseRevision, force? }` → `{ revision }`; 409 on conflict.
- `GET /api/events` — SSE: `revision` events with `source: "editor" | "external" | "mcp"`, plus heartbeats.
- `POST /api/export` `{ format, outDir? }` → `{ files: [absolute paths] }`; 501 with instructions when no Chromium is available.
- `GET /api/health` → version, file path, revision.

Security:

- Random token generated per session, required for page and API (query token or `Authorization: Bearer`).
- Reject requests with a foreign `Origin`; allow only the host origin.
- Only the opened file can be read or written; no arbitrary paths.
- No directory listing, no shell execution from API input.
- Token is not written to logs.

### Sessions

- Session registry: `~/.htmlppt/sessions/<sha256(path)>.json` with `{ path, port, token, pid, startedAt, revision }`, written with user-only permissions (0600).
- `htmlppt stop` reads the registry, terminates the process, removes the entry.
- Stale entries are cleaned on read.

### Live updates and conflicts

- The host watches the file with a debounced watcher. External writes produce a new revision and SSE events.
- The editor tracks the last synced revision and dirty state. Clean + external change → apply automatically; dirty + external change → banner offering reload or overwrite.
- Autosave: editor sends `PUT` 800 ms after a commit with the last known `baseRevision`.
- Self-writes are detected by content hash and do not re-trigger external events.
- The host keeps an in-memory revision history of 20 snapshots for recovery within a session; browser IndexedDB keeps the unsaved editor state for crash recovery.

### Export

- HTML: serialize master; cleanup; insert one generator comment after the doctype (`<!-- Edited with htmlppt. Format: htmldeck/v1. -->`); write/download.
- PDF/PNG: render with a system Chromium via `playwright-core` (Chrome, Edge, Chromium, or `HTMLPPT_CHROMIUM` env path); if unavailable, return actionable instructions.
- PDF: one page per slide at the deck's canvas size (first slide size for mixed decks; warning). Print backgrounds and hidden runtime state correctly; no editor chrome.
- PNG: per-slide screenshots at 2× device scale.
- Outputs go to `outDir` or next to the deck as `<basename>.pdf` / `<basename>-s1.png`, etc.

## 10. Editor

### Layout

- Top bar: file name, sync state, undo/redo, view toggle (Normal / Sorter), zoom, Play, Export, More.
- Left rail: thumbnails, add/duplicate/delete, reorder.
- Center: canvas with ruler-free snapping guides and slide shadow.
- Right inspector: Design, Text, Notes tabs; objects panel; slide settings (background, transition, runtime).
- Contextual toolbars: table row/column controls, chart edit, text formatting.
- Bottom: slide index, zoom, object count.
- Empty state: drop zone, Open, recent files, contract link.

### Selection and transform

- Click selects the nearest top-level object; Shift toggles multi-select; Alt-click drills into nested elements; double-click edits text or drills.
- Top-level objects pin to absolute geometry on first transform. Nested elements show read-only geometry with "Detach to slide".
- Eight resize handles; rotation handle; Shift snaps rotation to 15°; Alt disables snapping.
- 6 px (screen) snapping to slide edges/centers and sibling edges/centers; guides rendered in the overlay.
- Numeric X/Y/W/H/rotation inputs in the inspector.
- Arrow keys nudge 1 px, Shift+arrows 10 px.

### Rich text

- Double-click enters `contenteditable` on the text-bearing block; caret and selection live inside the iframe.
- Toolbar actions apply inline styles to the current character selection, or to the whole block when the caret is collapsed: bold, italic, underline, strikethrough, color, highlight, font family, font size.
- Block actions: alignment, line height, bullet/numbered list, link (http/https/mailto/#), clear formatting.
- Pasting inserts plain text.
- Toolbar state derives from computed styles at the selection.
- Native in-editing undo is allowed; on commit the change becomes one app history entry.
- Committing strips `contenteditable` and editor-only markup before syncing.

### Objects and slides

- Groups wrap selected top-level objects in `div[data-ppt-group]`; move/rotate only; ungroup restores positions.
- Lock prevents transform and selection via canvas; the objects panel can select and unlock.
- Hide sets inline `display:none`; the objects panel can unhide.
- Text boxes, shapes, images, tables, and charts are inserted as top-level objects with generated ids.
- Slide operations update the master; the sorter view supports click, drag reorder, duplicate, delete.
- Slide background supports color, gradient, and image URL. Transitions are selected in slide settings.
- Notes are edited in the Notes tab and stored in the hidden aside.

### Tables

- Native `<table>` object; contenteditable cells.
- Context toolbar: insert row above/below, insert column left/right, delete row/column, toggle header.
- Cell background and borders via the inspector; text formatting via the text toolbar.
- No merge/split in v1.

### Charts

- Chart dialog with type, title, labels, series values, colors, legend, value labels.
- Stored as JSON in `data-ppt-chart`; rendered SVG is regenerated by core.
- Insert as a top-level figure; resize re-renders at the new size; style options for colors/legend.
- Invalid JSON is reported by validation and shown as a placeholder in the editor.

### History

- Whole-master snapshots per commit; 100 entries.
- Coalesce drags on pointerup and rapid style/text changes within 500 ms.
- Undo/redo re-renders the affected slide and thumbnails.

### Play and presenter view

- Play mode hides editor chrome, scales the current slide to the screen, and uses transitions.
- Presenter view opens a same-origin popup: notes, next-slide preview, timer, prev/next, and a sync indicator.
- State sync via `BroadcastChannel`; popup-blocked fallback shows instructions.
- The exported runtime provides equivalent presentation and presenter-view behavior for static decks.

### Persistence clients

- Host mode when `/api/deck` is available. A host session is single-file; switching decks means starting a new session (`htmlppt open` or the recent-files launcher).
- Standalone mode otherwise: File System Access API if supported, else file input + download; IndexedDB autosave and recovery in both modes. Standalone mode can open any file but cannot export PDF/PNG.
- Live sync indicator: synced, saving, external update, conflict.

### Keyboard shortcuts

Cmd/Ctrl: Z undo, Shift+Z redo, S save, Shift+E export, D duplicate, G group, Shift+G ungroup, +/- zoom, 0 fit, A select all objects (when not editing text), C/V copy/paste objects internally.
Other: Delete, arrows/Shift+arrows, Escape (exit text/drill/selection), Enter (edit text), F5 (play), Shift+F5 (play from current), Alt+click drill, while presenting arrows/space/PageUp/PageDown/Home/End/Escape, `P` presenter view, `F` fullscreen, `?` shortcut help.

## 11. Import, validation, and normalization

### Detection

1. `[data-slide-id]`.
2. `.slide`, `.page`, `.slide-page`.
3. Direct children of the most common parent that are `<section>`.
4. Single-body fallback; slide operations disabled; editing allowed.

### Normalization (master document)

- Assign missing `data-slide-id` (`s1`, `s2`, …) and missing `data-ppt-el` ids to top-level objects (`e1`, `e2`, … per slide).
- Ensure slides have `position: relative` when computed position is static.
- Do not alter other markup or styles.

### Validation

Errors (block MCP writes; editor shows a blocking notice for exports):

- Duplicate slide ids or object ids within a slide.
- Missing/invalid canvas size.
- Invalid chart JSON, transition value, or runtime marker.
- Editor-only artifacts left in the document.
- Notes element nested incorrectly.

Warnings (never block):

- No slides detected; single-body fallback.
- Relative assets.
- `<script>` other than the runtime and JSON data.
- `position: fixed`, `100vh`, or scroll-driven layout hints.
- Mixed canvas sizes.
- Missing runtime; missing title.
- `<canvas>` or runtime-rendered content.
- Unsupported group nesting.

Diagnostics include slide id and a short location hint. The CLI and MCP return them as JSON.

## 12. Error handling

| Situation | Behavior |
|---|---|
| Invalid HTML / no slides | Single-body fallback + warning |
| Relative assets / JS layout | Warning; editing continues |
| Duplicate ids | Error; MCP refuses writes; editor repairs on explicit action |
| File changed externally while dirty | Conflict banner: reload or overwrite |
| Save permission/file error | Toast with retry; export/download fallback |
| No Chromium for PDF/PNG | Actionable install/configure message |
| Popup blocked for presenter view | Instructions overlay |
| Last slide deletion | Blocked |
| Nested transform attempt | Blocked; offer Detach |
| Invalid chart data | Placeholder + validation error |
| Host crash | Editor switches to offline mode; retry reconnect; unsaved state recovered |
| MCP conflict | Structured 409 error; agent re-reads and retries |
| Ambiguous MCP target | Error listing matches |

## 13. Security

- Host binds to `127.0.0.1`, random port, per-session token, origin checks.
- Only the opened deck, its exports, and the editor assets are reachable.
- No remote content is proxied; the editor loads deck assets directly.
- Scripts are disabled in editing iframes; exported scripts are preserved but never executed by the host/CLI.
- PDF/PNG rendering loads the deck in a sandboxed browser context without network access beyond the deck's own assets (best effort).
- MCP local mode only reads/writes paths explicitly provided by the agent.
- No telemetry; no remote calls except loading deck assets (fonts/images) in the browser.

## 14. Testing and verification

### Unit (Vitest)

- Slide detection, canvas inference, normalization, id assignment.
- Validation rules.
- Pin geometry, coordinate conversion, snapping, rotation decomposition.
- Rich-text inline style application and cleanup (jsdom).
- Group/ungroup, table mutations, chart JSON and SVG generation.
- Serialization cleanup and runtime injection.
- Revision/hash logic, session registry, target resolution.

### Integration

- Host API: deck CRUD, atomic writes, 409 conflicts, SSE events, file watching, session registry, token/origin rejection, export error handling.
- MCP: stdio handshake, tool schemas, direct-file writes, host auto-attach, conflict errors, resources.
- CLI: new/validate/outline/open/stop/export with real files.

### E2E (Playwright)

- Open via CLI host; thumbnails and canvas render.
- Transform, multi-select, align/distribute, group, z-order, lock/hide.
- Rich text formatting across a selection; list and link.
- Insert text box, shape, image, table, chart; edit and persist.
- Slide add/duplicate/reorder/delete; sorter; notes; transitions.
- Undo/redo across object, text, table, chart, and slide ops.
- Play and presenter view sync (popup).
- Live update: external file change; dirty conflict banner.
- Export HTML, PDF, PNG; PDF page count/size; PNG count.
- Standalone upload/download mode.
- Visual round-trip: unedited export pixel-identical per slide (< 0.1% differing pixels); edited export matches the editor canvas.

### Fixtures

- Contract deck with all object types.
- Messy legacy deck.
- Deck with CSS animations and scripts.
- Deck with external assets.
- Mixed-size deck.

### Packaging

- `npm pack`, install the tarball in a temp project; `htmlppt --help`, `new`, `validate`, `open` (headless), MCP handshake; assert the editor assets and skill files are present.

### Gate

`eslint`, `tsc --noEmit`, `vitest run`, `playwright test`, `npm run build`, and the package smoke test must pass. CI runs on Ubuntu and Windows with Node 20 and 22.

## 15. Acceptance criteria

- A user can run `npx htmlppt open deck.html`, edit a deck visually, and save back to the same file with autosave and recovery.
- All v1 features in section 4 work and are covered by E2E tests.
- An agent can install/use the skill, generate a contract-compliant deck, validate it via MCP, and open the editor.
- MCP direct mode works without a host; with an editor open, MCP edits appear live.
- An unedited export is visually identical to the source; an edited export matches the editor.
- Exported HTML has no editor artifacts, keeps notes/transitions/charts, and includes the runtime when present.
- PDF and PNG exports succeed with a system Chromium and fail with actionable guidance when unavailable.
- Presenter view works in Play mode and in exported decks (runtime).
- Host security checks pass; only the opened file is accessible and tokens are required.
- CLI and MCP are packaged in one npm tarball with the editor and skill; CI is green.
- README, contract docs, MCP reference, skill, examples, LICENSE, CONTRIBUTING, and SECURITY are present.

## 16. Risks and limitations

- **Scope:** this is a large v1. Sequencing and test gates are mandatory; sections are modular so failures stay contained.
- **Arbitrary CSS:** rich text and inline styling can interact with deck CSS in unexpected ways; the editor normalizes inline styles and tests against real decks.
- **Layout model:** nested elements cannot be freely transformed; document this early in the skill and UI.
- **PDF fidelity:** depends on the installed Chromium and available fonts; tests cover page count and basic rendering, not cross-platform pixel equality.
- **Live sync:** v1 handles single-editor plus external writes, not concurrent multi-user editing; the host revision model is the seam for CRDT later.
- **File watching:** debounced and hash-checked to avoid loops; Windows path cases are covered in CI.
- **Performance:** many slides are rendered lazily; very large decks (100+ slides with heavy images) may need virtualization later.
- **Runtime conflicts:** decks with custom navigation scripts may conflict with the bundled runtime; detection warns instead of silently modifying behavior.

## 17. Future platform

The host is designed to become a hosted service without changing the editor or MCP tool schemas:

- Storage adapter interface: local filesystem now; object storage/database later.
- Session registry local now; auth and multi-deck routing later.
- SSE now; WebSocket/CRDT and presence later.
- MCP stdio now; Streamable HTTP MCP from the host later.
- Sharing links, permissions, comments, version history, and accounts are platform features layered on the host.
