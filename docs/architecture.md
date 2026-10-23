# Architecture

htmlppt is a TypeScript monorepo with a small contract engine, a local HTTP host,
a browser editor, an agent-facing MCP server, and export tooling. The deck file
is the integration point: every package reads or writes the same
`htmldeck/v1` HTML.

## Package responsibilities

| Package | Role |
| --- | --- |
| `@htmlppt/core` | Contract engine: slide detection, canvas and outline reads, validation, normalization, mutations (slides, objects, notes, transitions, backgrounds), tables, charts, images, rich-text helpers, insert helpers, template generation, and serialization. Runs in the browser and in Node; the `@htmlppt/core/node` subpath adds Linkedom parsing, hashing, and atomic file reads/writes. No HTTP or host code. |
| `@htmlppt/runtime` | Dependency-free vanilla JavaScript presentation runtime exported as `RUNTIME_SOURCE`. Handles navigation, hash routing, fullscreen, transitions, print, and the standalone presenter window. |
| `@htmlppt/editor` | React 19 + Vite browser app. Owns the inert master `Document`, the sandboxed preview iframe, selection/geometry, object and text commands, history, inspector, slide rail/sorter, autosave/live sync, IndexedDB crash drafts, the standalone upload/download fallback, play mode, presenter view, and the export menu. |
| `@htmlppt/host` | Hono server bound to `127.0.0.1`. Authenticates the session, serves the editor, exposes deck read/write/SSE/export APIs, serializes saves and exports, enforces request-size limits, watches the file, and manages the session registry. |
| `@htmlppt/renderer` | Headless system-Chromium rendering through `playwright-core`: PDF (one page per slide, exact page boxes) and PNG (one file per slide at 2× scale). Includes browser discovery and the renderer sandbox. |
| `@htmlppt/mcp` | Stdio MCP server built on the official SDK and Zod. Registers 25 tools and 3 resources, resolves targets, maps domain errors, and chooses direct or host-attached storage per deck. |
| `@htmlppt/cli` | Commander command surface: `new`, `validate`, `export`, `outline`, `open`, `stop`, `mcp`. Starts/reuses hosts, writes the session registry, resolves the packaged or workspace editor build, refuses export over the source path, and prints URLs and diagnostics. |
| `htmlppt` | Publishable bundle. tsup bundles the CLI and MCP entrypoints plus workspace libraries, keeps `playwright-core` external, and copies the built editor and `skills/htmlppt` into `dist/`. Bins: `htmlppt` and `htmlppt-mcp`. |
| `@htmlppt/test-utils` | Shared test helpers and fixtures. |

Dependency boundaries are enforced by `npm run lint:deps`:

- no dependency cycles;
- `core` does not import renderer, host, editor, CLI, or MCP;
- `renderer` does not import endpoints or runtime;
- `runtime` imports nothing else in the workspace;
- the editor does not import `core/node`;
- the host does not import the editor.

## Data flow

```
agent (MCP / CLI)                    human (browser)
       |                                   |
       | create / mutate                   | edit, arrange, type
       v                                   v
  deck.html  <---- atomic write ----  host (127.0.0.1)
       |             revision                ^
       |                                     | HTTP + SSE
       +---- open ----------------------> editor (master Document + iframe)
       |
       +---- export --> standalone HTML / PDF / PNG
```

1. **Author.** An agent calls MCP tools or CLI commands. Core clones the parsed
   document, normalizes it, applies one mutation, validates the whole result,
   and serializes it; the calling host/CLI/MCP layer writes it atomically. The
   new file hash becomes the revision.
2. **Open.** `htmlppt open` or MCP `open_editor` starts a host, generates a
   session token, records `{ path, port, token, pid, startedAt, revision }` in
   `~/.htmlppt/sessions/<sha256(path)>.json`, and prints an authenticated URL.
3. **Edit.** The editor fetches `/api/deck`, parses an inert master document,
   and renders the active slide into a sandboxed iframe. Human edits update
   either the iframe (gestures, inline text) or the master (inspector, slide
   settings), then enter editor history and schedule an autosave.
4. **Save.** After 800 ms of quiet, the editor sends `PUT /api/deck` with the
   full HTML and the base revision. The host takes its save lock, syncs from
   disk, checks the base revision, validates, writes atomically with the
   expected hash, updates its cached revision, and broadcasts a `revision` SSE
   event with `source: "editor"`.
5. **Sync.** A file watcher (roughly 50 ms polling plus a 100 ms debounce)
   promotes external changes to the host's current revision and broadcasts
   `source: "external"`. Host-attached MCP mutations routed through the host
   broadcast `source: "mcp"` (`create_deck` writes the new file directly).
   Clean editors apply the new deck automatically; dirty editors show a
   conflict instead of silently discarding work.
6. **Export.** The editor's Export menu, CLI, and MCP call the same paths.
   HTML export serializes a cleaned standalone document; in host mode it is
   written as `<deck>.export.html`. PDF/PNG export renders a snapshot through
   the renderer. The host and MCP confine `outDir` to the deck directory; the
   CLI writes where the local user asks but refuses to overwrite the source
   deck. Host exports serialize per process and re-check directory containment
   after creation. Outputs are staged and renamed into place.

## Revision and conflict model

A revision is the SHA-256 hash of the exact file bytes. It is an opaque token,
not a parent pointer; there is no merge history in the file.

- **Pages:** `GET /` redirects to `/d/<deck-name>`, setting the session cookie
  when the request carries a valid token; a request already authorized by the
  cookie also redirects. `GET /d/<deck-name>` serves the editor
  when the decoded basename matches the current deck (case-insensitive on
  Windows) and returns 404 otherwise.
- **Host:** `GET /api/deck` returns `{ html, revision, filePath }`. `PUT`
  accepts `{ html, baseRevision, force? }`. A stale `baseRevision` returns
  `409 { error: "conflict", revision }` before validation. The atomic write
  re-checks the on-disk hash before and after staging the temporary file; a
  change in that window also returns `409`. `force: true` skips the base check
  and is used only when the person chooses **overwrite** in the conflict
  banner. Deck updates are capped at 16 MiB and export requests at 64 KiB
  (`413 payload-too-large`). Page and API requests accept the HttpOnly session
  cookie set by the tokenized bootstrap redirect; bearer auth remains for CLI,
  MCP, and tests, and only `GET /api/events` may carry the token in the query
  string because `EventSource` cannot set headers.
- **Editor:** saves are serialized through one promise chain; a pending save is
  restarted by new edits, and a save that started before a reload/load is
  invalidated. The controller tracks the last acknowledged revision, ignores
  its own SSE events by revision equality, and defers events while a save is in
  flight. A dirty editor that receives another revision surfaces a conflict
  with **reload** (discard local edits and fetch the host state) or **overwrite**
  (force write local state). A clean editor applies the new master, remaps
  selection by slide id plus `data-ppt-el`, and clears undo history.
- **MCP:** the server remembers the last revision it read or wrote per file and
  compares it before writing. Direct mode compares the file hash; host mode
  compares the host revision. A conflict requires `get_outline`/`read_slide`,
  reconciliation, and retry. MCP has no force flag.
- **Host history:** the last 20 committed snapshots are kept in memory for
  same-session recovery. They are not exposed over HTTP.

The compare-to-rename window is inherent to local filesystems. The goal is to
prevent silent overwrites, not to provide multi-writer transactional isolation.

## Iframe preview and commit model

The master `Document` is the source of truth. The active slide is rendered into
an iframe via `srcdoc` built from the master:

- the document `<head>` and the slide's ancestor chain are included so CSS
  cascade, inherited styles, and selectors still apply;
- the body attributes are copied;
- an editor base stylesheet hides notes and overflow;
- the active slide clone gets a random `data-ppt-frame-slide="<token>"` marker;
- the iframe has `sandbox="allow-same-origin"` and no `allow-scripts`, so deck
  scripts never run; the editor uses same-origin access only to measure and
  edit the DOM.

Editing has two commit paths:

- **Iframe reconciliation (`commit` / `commitSlide`):** pointer gestures, resize,
  rotate, and inline text edit the live iframe DOM. On commit, the editor finds
  the marked slide, removes `data-ppt-editing` and `contenteditable`, copies the
  slide's inner HTML into the master, serializes the document, pushes a history
  snapshot, marks the deck dirty, and schedules autosave. Commits intentionally
  do not re-render the iframe, so live gesture styles are not lost.
- **Master mutation (`commitMaster`):** inspector style/geometry changes, slide
  settings, notes, grouping, ordering, and other commands mutate the master
  directly, rebuild `srcDoc`, and refresh selection geometry.

Canceling a gesture reloads the iframe from the master. Changing slides,
applying an external revision, or reloading also rebuilds `srcDoc` from the
master. Undo/redo restores a serialized snapshot and persists it like any other
commit.

Text editing uses `contenteditable` only inside the preview; the saved master
never contains the editing marker. Thumbnails, sorter tiles, and the play view
use the same script-free iframe technique with `markFrame: false` so they do not
disturb the main preview token.

## Presenter BroadcastChannel protocol

Both the editor play mode and the standalone runtime use one origin-scoped
`BroadcastChannel` per presentation:

```
channel name: htmlppt-presenter-<sessionId>
sessionId:    8-64 characters, [A-Za-z0-9-]
```

Messages are objects with a `sessionId` field. A message with a different
session id is ignored, so two decks on the same origin cannot cross-talk.

| Type | Direction | Payload | Purpose |
| --- | --- | --- | --- |
| `request` | presenter → main | `{ sessionId, type }` | Ask for the current snapshot/state. Sent on open and every 2 s. |
| `snapshot` | main → presenter | `{ sessionId, type, html, index, total }` | Full deck HTML plus current position. |
| `state` | main → presenter | `{ sessionId, type, index, total }` | Navigation update after the snapshot. |
| `slide` | presenter → main | `{ sessionId, type, index }` | Request a slide change. The main window validates and applies it. |
| `bye` | either → other | `{ sessionId, type }` | Presenter closed or presentation ended. |

The main window is authoritative. It sends the snapshot once, then state
updates. The presenter requests again on reconnect, polls every 2 seconds, and
shows a disconnected status after 6 seconds without state. Indexes are integers
within `0..total-1`, and `total` is capped at 10,000. The editor opens its
presenter as `/?presenter=1&session=...`; the standalone runtime opens a popup
and builds the presenter UI in it. Presenter preview iframes are script-free.

## Renderer pipeline

1. **Find Chromium.** `HTMLPPT_CHROMIUM` wins. An explicitly set but invalid
   path fails instead of falling back. Otherwise discovery checks platform
   Chrome/Edge/Chromium locations and Playwright browser caches.
2. **Launch.** Headless Chromium with the Chromium sandbox enabled. The browser
   context disables JavaScript, blocks service workers, and refuses downloads.
3. **Isolate.** The page starts on an ephemeral loopback sandbox origin that
   serves an empty document with a restrictive CSP. Deck HTML is then loaded
   with `page.setContent` on that origin.
4. **Route.** Only main-frame `http(s)` image, font, and stylesheet requests are
   allowed. Navigation, `file:`, frames, workers, fetch/XHR, objects, and forms
   are aborted; WebSockets are closed. Asset failures become `RenderError`.
5. **Prepare layout.** Core detects slides from the rendered document. The
   renderer removes animation/transition/caret effects, reveals navigation-
   hidden slides (including display rules and active classes), neutralizes
   ancestor transforms/overflow, hides non-slide siblings, fixes each slide to
   its canvas size, adds page breaks, and marks images eager.
6. **Wait.** Fonts, HTTP images, and network idle must settle within a 12-second
   deadline. A timeout reports layout/asset trouble instead of hanging.
7. **Render.** PDF uses print media and the first slide's size, with backgrounds
   and no margins/header/footer; `pdf-lib` then sets each page box to
   `pixels × 72/96` and scales content to match. PNG uses screen media, a 2×
   device scale, isolates one slide at a time, clips to its rectangle, and writes
   `<basename>-sN.png`.
8. **Persist.** Each output is written to a temporary file and renamed into
   place. Errors are `RendererUnavailableError` or `RenderError` (with the slide
   number when known).

The host maps renderer unavailability to `501` and render failures to `500`;
the CLI/MCP map them to actionable messages.

## Test layers

| Layer | Command | Scope |
| --- | --- | --- |
| Unit | `npm run test:unit` | Core contract/mutation/format tests and editor controller, geometry, history, shortcut, command, live-sync, and presenter-protocol tests (jsdom). |
| Integration | `npm run test:integration` | Builds, then runs the renderer against real Chromium, the host over real HTTP, MCP over real stdio, and CLI subprocesses against real files. |
| E2E | `npm run test:e2e` | Playwright Chromium: editor flows, runtime, presenter, security, accessibility, export UI, standalone mode, crash recovery, insertion, tables, charts, and visual round trips. Visual comparisons require less than 0.1% differing pixels. |
| Package | `npm run test:package` | Packs the real `htmlppt` tarball, installs it in an empty temp project, and exercises installed bins, editor assets, skill, docs, auth, host lifecycle, and MCP handshake. |
| Matrix | `npm run test:matrix` | Checks that every feature id in `docs/features.json` has tagged `@feature:<id>` coverage. |

`npm run verify:fast` runs lint, dependency boundaries, typecheck, unit,
integration, and the matrix. `npm run verify` adds E2E and package smoke, and
`npm run verify:all` repeats package smoke as the final gate. Tests do not mock
the host or filesystem at the integration layer and do not use retries;
POSIX-only permission and symlink checks skip on Windows because the platform
cannot express them. CI gates Ubuntu and Windows; see [testing.md](testing.md).
