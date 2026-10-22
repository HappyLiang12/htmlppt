# Security

htmlppt is a local-first tool. It has no accounts, cloud service, telemetry, or
remote API of its own. The security model assumes a single user on a trusted
machine opening untrusted deck HTML produced by an agent or another person.

## Threat model

Protected assets:

- the contents of files the user did not choose to open or export;
- the editor session token and the loopback HTTP surface;
- the browser and operating-system context that previews and renders a deck.

In scope:

- a malicious or compromised deck, including script tags, event handlers,
  external asset URLs, symlinks, and authored HTML/CSS;
- another local process or a web page trying to reach the editor host without
  the session token;
- a deck trying to escape the export directory or read local files through the
  renderer;
- prompt-injected MCP clients asking tools to touch unintended paths.

Out of scope:

- a compromised operating system, browser, Chrome extension, or another
  process already running with the same user privileges;
- browser zero-days and network attackers who can intercept loopback traffic;
- decks that the user deliberately executes outside htmlppt (for example by
  opening an exported HTML file directly in a browser).

## Local host and session token

`htmlppt open` starts an HTTP server bound to `127.0.0.1` (never a wildcard
address) on a random port unless `--port` is supplied.

- Each run generates a random per-session token. The printed URL carries it as
  `?token=...`; treat that URL as a secret for the session.
- Editor pages and static assets require the token once in the query string.
  The host then sets an `HttpOnly`, `SameSite=Strict` cookie so module and
  stylesheet subrequests stay authorized; page scripts can read the token from
  the URL but not from the cookie.
- `/api/*` requests require `Authorization: Bearer <token>`. The single
  exception is `GET /api/events`, where `EventSource` cannot set headers and the
  token may travel in the query string. All other routes, including health, deck
  reads/writes, and export, require the bearer header.
- If an `Origin` header is present on an API request, it must be `http:`,
  hostname `127.0.0.1` or `localhost`, and the exact port the host is listening
  on. Other origins receive `403`.
- Deck updates are limited to 16 MiB and export requests to 64 KiB; larger
  bodies receive `413 payload-too-large`.
- Responses set `Referrer-Policy: no-referrer` and
  `X-Content-Type-Options: nosniff`.
- The API exposes only the opened deck. Static serving is limited to the
  packaged editor assets; there is no directory listing and no static serving of
  the deck directory.
- Session registry files live under `~/.htmlppt/sessions` (or
  `$HTMLPPT_HOME/sessions`) and contain the token and process id. The directory
  is created with mode `0700` and entries with `0600` where the platform
  supports it. Protect your home directory accordingly.

`htmlppt open` reuses a session only when its authenticated health endpoint
answers. A live PID with a dead port is treated as stale and is not reused.

## Editor isolation

The editor parses the deck into an inert master `Document` and renders one
slide at a time into an iframe with `sandbox="allow-same-origin"`. The sandbox
deliberately omits `allow-scripts`.

- Deck scripts, inline event handlers, and `javascript:` URLs never execute in
  the editor, thumbnail rail, sorter, or play/presenter view.
- `allow-same-origin` is required only so the editor can measure and mutate the
  preview DOM (selection, resize, inline text editing) and read computed
  geometry. It does not grant script execution.
- Preview-only attributes (`data-ppt-editing`, `data-ppt-frame-slide`) and
  temporary `contenteditable` markers are removed when an edit is committed.
  Saved decks containing editor-only attributes are rejected by validation.
- The deck can still reference remote images, fonts, and stylesheets. Opening a
  preview may therefore contact those origins. Use `data:` URIs when a deck
  must remain fully offline.

## Local drafts and standalone mode

Unsaved host edits are mirrored to IndexedDB under the editor origin so a crash
can offer recovery. Drafts contain the serialized deck only; session tokens are
not stored. They are deleted after a successful save, or after an explicit
standalone download.

When `/api/deck` is unavailable, the editor switches to standalone mode. A file
is read only after the user picks or drops it. With File System Access it saves
back through the handle the user granted; otherwise it stores a crash draft and
offers an explicit HTML download. Standalone mode has no host API, no session
token, and no PDF/PNG renderer; those formats stay disabled. Downloaded or
written decks are ordinary local files with the same trust level as any HTML
file the user opens.

## Renderer isolation

PDF and PNG export run a headless system Chrome, Edge, or Chromium with the
Chromium sandbox enabled.

- JavaScript is disabled for the whole browser context; service workers are
  blocked and downloads are refused.
- The page starts on an ephemeral loopback "sandbox origin" with a restrictive
  CSP:
  `sandbox allow-same-origin; default-src 'none'; script-src 'none';
  style-src 'unsafe-inline' http: https:; img-src http: https: data:;
  font-src http: https: data:; frame-src 'none'; worker-src 'none';
  connect-src 'none'; object-src 'none'; form-action 'none';
  base-uri http: https:`.
- Request interception permits only `http:`/`https:` image, font, and
  stylesheet requests made by the main frame. Navigation, `file:` URLs,
  fetch/XHR, frames, workers, objects, and forms are aborted; WebSocket
  connections are closed.
- The renderer reads a snapshot of the deck; it never writes back to the source
  file. PDF and PNG outputs are staged in a temporary file and renamed into
  place.
- When no usable Chromium is found, export fails with an actionable error. An
  explicitly invalid `HTMLPPT_CHROMIUM` does not fall back to another browser.

## Export path confinement

The host export endpoint accepts HTML, PDF, or PNG plus an optional `outDir`.
The directory is resolved inside the deck's directory, including existing
symlinks and missing trailing path components; a target that escapes the deck
directory is rejected with `400`. HTML output is written as
`<deck>.export.html`, so it cannot replace the source. The host serializes concurrent exports and re-checks
containment after creating the directory, which narrows the window for a
symlink swap. A process that can write to the deck directory while an export
runs can still race the final write; that attacker already has the same
filesystem access as the export itself. File names are derived from the deck
name, and PNG basenames are validated as filenames.

The MCP `export_deck` tool applies the same rule in both modes: `outDir` is
resolved against the deck directory and must stay inside it; otherwise the call
fails with `invalid-out-dir`. This applies to HTML, PDF, and PNG output.

The CLI export writes where the local user asks, subject to operating-system
permissions, but refuses to overwrite the source deck path (including a symlink
alias). The CLI and MCP direct mode still read and write deck/image paths with
the process's own permissions; they are not general filesystem jails.

## MCP trust boundaries

The MCP server uses stdio only and does not listen on a network port. It runs
with the permissions of the process that starts it.

- **Direct mode** reads and writes the deck file and explicit image paths. A
  relative path resolves against the server working directory; absolute paths
  are allowed. It is not a sandbox. Point it at a trusted workspace.
- **Host-attached mode** is selected automatically when a healthy editor session
  owns the deck. Reads, most mutations, and PDF/PNG exports route through the
  authenticated loopback host, so the editor receives revision events. Set
  `HTMLPPT_MCP_MODE=direct` to force file access even when a host is live.
- `export_deck` confines `outDir` to the deck directory in direct and
  host-attached mode.
- `add_image` can embed a local image as a data URL. A prompt-injected agent
  could therefore copy a file the process can read into a deck. Review tool
  calls and generated decks before sharing them.
- MCP tools validate decks before writing and never execute deck scripts or
  shell commands.

## Reporting a vulnerability

Do not open a public issue for a sensitive security report. Use the repository's
GitHub Security Advisories page and choose **Report a vulnerability** to start a
private advisory. Include:

- the htmlppt version and operating system;
- a minimal deck or exact reproduction steps;
- the impact you observed, including whether the host, editor, MCP server, or
  renderer was involved.

Please allow time for a fix and coordinated disclosure before publishing
details. Non-sensitive hardening suggestions may be filed as normal issues.
