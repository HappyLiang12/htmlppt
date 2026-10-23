# Editor URL, open-file, localization, and theming design

Date: 2026-10-23
Status: Approved in chat, pending spec review

## Context

The local editor is opened with a tokenized URL such as
`http://127.0.0.1:64006/?token=<uuid>`. Three problems follow:

1. The token dominates the address bar and looks like noise. Users expect a
   readable URL that names the deck.
2. The editor can only edit the deck the host was started with. Opening another
   HTML file requires the CLI or the standalone upload flow.
3. Editor, play mode, presenter, and runtime controls are Traditional Chinese
   only.
4. The editor chrome is dark-only; its colors are hardcoded Tailwind values with
   no theme tokens, so light mode needs a token layer before any switch can be
   added.

The token is a per-process capability secret, not a user credential. It gates
`/api/*` (bearer) and page/static requests (query token or HttpOnly cookie), and
is the only thing preventing another local process from reading or overwriting a
deck. It must stay. The fix is to hide it from the visible URL, not remove it.

## Goals

- A readable URL after the first load: `http://127.0.0.1:<port>/d/<deck-file-name>`.
- Open another deck from the editor by typing a path or using a file picker,
  without restarting the host.
- Editor UI, play mode, presenter window, and runtime controls in English,
  Traditional Chinese, and Simplified Chinese, selected from the browser
  language and overridable by the user.
- Editor chrome in Light, Dark, or System mode, persisted per browser and
  following OS changes while in System mode.

## Non-goals

- Removing authentication or making the host reachable beyond loopback.
- Translating CLI/MCP output, deck content, or author notes.
- RTL layout, locale-specific date/number formats, or translated runtime error
  messages produced by the host API.
- Changing the one-deck-per-host model. A second deck gets a new host unless it
  is opened through the new open endpoint.
- Theming deck content. Slides are arbitrary author HTML and keep their own
  colors; the light theme never repaints them.
- Theming play mode, the presenter stage, or the runtime control pill. These
  surfaces sit on or over deck content and stay dark so authored slides keep
  their intended contrast in every theme.
- Per-deck theme metadata, custom accent colors, or a theme editor.

## Decisions

- Locales: English, Traditional Chinese, Simplified Chinese.
- Scope: editor + play/presenter + runtime controls and notices. CLI/MCP stay
  English.
- First-visit language follows the browser; a manual choice persists.
- Path input uses the host (keeps save/export); the file picker uses the
  existing standalone mode and writes through the File System Access handle.
- Visible URL shape: `/d/<file-name>`.
- Theme modes: Light, Dark, System; default System; persisted per browser.
- Theme scope: editor chrome and editor-owned overlays only. Play mode,
  presenter, and runtime controls stay dark as described in Non-goals. This
  keeps arbitrary slide content untouched and avoids theming a stage that sits
  over authored colors.

## 1. Friendly URL and cookie bootstrap

### Behavior

- `GET /?token=<valid>`: set the existing `htmlppt_token` cookie
  (HttpOnly, SameSite=Strict, Path=/, no Max-Age) and `302` to
  `/d/<encodeURIComponent(basename(deckPath))>`.
- Any non-API page request carrying a valid `token` query parameter follows the
  same rule: set the cookie and redirect to the same path without the query.
  This keeps bookmarked tokenized links working and cleans the address bar.
- `GET /` with a valid cookie: `302` to `/d/<name>`.
- `GET /d/:name` with a valid cookie: serve the editor when the decoded name
  matches the current deck basename (case-insensitive on Windows, case-sensitive
  elsewhere). A mismatch returns 404. Missing/invalid auth returns 401 as today.
- Static assets keep absolute `/assets/...` URLs and are served unchanged.
- `/api/*` accepts either `Authorization: Bearer <token>` or the cookie.
  `GET /api/events` keeps accepting the query token for EventSource
  compatibility. The Origin check (http, 127.0.0.1/localhost, same port) is
  unchanged and applies to every API request that carries an Origin header.
- CLI and MCP keep printing/returning the tokenized bootstrap URL. Automation
  and first visits are unaffected; only the post-redirect URL changes.

### Editor changes

- Remove `tokenFromLocation()` and the token argument from editor API helpers.
  Requests rely on the same-origin cookie; `EventSource('/api/events')` also
  relies on the cookie.
- Keep bearer support server-side for CLI, MCP, and tests.

### Security notes

- Cookie auth does not weaken the boundary: SameSite=Strict blocks cross-site
  requests, the Origin check blocks cross-origin API calls, and no CORS headers
  are emitted. A local process that can read the cookie file could already read
  the session registry token.
- `SECURITY.md` and `docs/architecture.md` are updated to describe cookie auth
  for `/api/*` and the bootstrap redirect.

## 2. Opening another deck

### Host API

`POST /api/open` with `{ "path": "<string>" }`, body limit 64 KiB.

Path normalization:

1. Trim whitespace and strip one pair of matching single or double quotes.
2. Accept `file://` URLs via `fileURLToPath`.
3. Expand a leading `~` to the user's home directory.
4. Resolve relative paths against the host process working directory.
5. `realpath` the target and require a `.html` or `.htm` extension
   (case-insensitive).

Validation: read the file with `readDeckFile`, parse with `parseDeckHtml`, and
require `validateDeck(...).valid`. A file that is not a valid deck is rejected;
the current deck stays untouched.

Rebinding, inside the existing save lock:

1. If the target is already the current path, return the current deck (no-op).
2. If the session registry has a live entry for the target served by a
   different port, return 409 `{ error: 'deck-already-open', url }`.
3. `unwatchFile(oldPath)`, update `options.filePath`, load the new html and
   revision, reset revision history, `watchFile(newPath)`.
4. Broadcast a `revision` event so other open tabs reload the new deck.
5. Invoke an optional `onDeckOpened({ previousPath, path, revision })` callback
   supplied by the CLI to move the session registry entry: write the new entry,
   then remove the old file if its content is unchanged. Registry failures are
   logged to stderr but do not fail the open.

Response: `{ html, revision, filePath, url }` where `url` is `/d/<name>`.

Error codes: `400` invalid path, `404` not found, `409` deck-already-open,
`422` unsupported-extension or invalid-deck, `500` unreadable.

### Editor changes

- The toolbar path becomes an editable input in host mode. Enter opens, Escape
  cancels, blur opens when the value changed. `file://` prefixes are accepted.
- A folder button next to it opens the native picker. Picking a file switches
  the tab to standalone mode through the existing
  `showOpenFilePicker`/`<input type=file>` path, keeps write-back through the
  File System Access handle, and shows the existing standalone badge. Host-only
  export (PDF/PNG) is unavailable in that mode and the export menu already
  communicates this.
- Before opening by path, save pending edits (`saveNow`). A failed save or a
  conflict aborts the open and keeps the current deck.
- Errors render inline next to the input with `role="alert"` and leave the
  current deck loaded.
- On success, load the returned deck through the controller and
  `history.replaceState` the URL to `/d/<new-name>`.
- In standalone mode the path field is read-only and shows the picked file name.

## 3. Localization

### Framework

- No new dependencies. `packages/editor/src/i18n/` contains:
  - `messages/en.ts`, `messages/zh-Hant.ts`, `messages/zh-Hans.ts`
  - `index.tsx` with `LocaleProvider`, `useI18n()`, `t(key, vars)`, locale
    detection and persistence.
- `MessageKey` is `keyof typeof en`; the other dictionaries are typed as
  `Record<MessageKey, string>`, so a missing or extra key fails typechecking. A
  unit test additionally compares key sets.
- Interpolation uses `{name}` placeholders. Missing keys return the key. No
  pluralization library; copy is phrased to avoid counts where practical.

### Locale selection

- Stored in `localStorage['htmlppt.locale']`; valid stored values win.
- Otherwise map `navigator.language`:
  - `zh-TW`, `zh-HK`, `zh-MO`, `zh-Hant*` → `zh-Hant`
  - `zh-CN`, `zh-SG`, `zh-Hans*`, other `zh*` → `zh-Hans`
  - `en*` → `en`
  - anything else → `en`
- The toolbar gets a compact language menu (`English`, `繁體中文`, `简体中文`),
  `data-testid="locale-select"`, with a localized `aria-label`.
- Changing locale updates `<html lang>` and re-renders without reload. Play mode,
  presenter, dialogs, live-region announcements, titles, and aria-labels all use
  the provider.

### Copy migration

- Replace all user-visible editor strings, including `Toolbar`, `Inspector`,
  `TextToolbar`, `InsertMenu`, `ExportMenu`, `ShortcutsDialog`,
  `StandaloneLauncher`, `PresenterView`, recovery banners, and announcements.
- Host API error payloads stay English. The editor maps known error codes to
  localized copy and falls back to the raw message for unknown codes.

### Runtime and presenter

- `RUNTIME_SOURCE` gains a small string table and `runtimeLocale()`, resolved
  from `document.documentElement.dataset.pptLocale` (author override), then
  `navigator.language`, then English.
- Localized runtime strings: previous/next labels and aria-labels, page
  indicator (numeric format unchanged), fullscreen notices, presenter window
  title and section labels, status text, timer, notes placeholder, and
  "last slide".
- The presenter popup receives the resolved strings as a JSON
  `data-ppt-strings` attribute on its body; `PRESENTER_CLIENT` parses it instead
  of closing over outer variables (the client is serialized with `toString()`).
- Editor-authored play/presenter UI uses the editor locale.
- Exported decks keep the runtime script; their controls localize at view time
  from the viewer's browser.

## 4. Light, dark, and system themes

### Scope

Theme follows the editor chrome only: toolbar, path input, locale and theme
controls, sorter, thumbnail frames, inspector, text/table toolbars, insert and
export menus, dialogs, recovery banner, standalone launcher, status text, and
empty states. The slide stage inside the editor keeps its neutral presentation
frame so authored slides render against a stable background.

Play mode, the presenter stage, and the runtime control pill stay dark, as
stated in Non-goals.

### Tokens

- `packages/editor/src/index.css` defines semantic CSS variables under
  `:root[data-theme='light']` and `:root[data-theme='dark']`: canvas, surface,
  raised surface, border, strong border, primary/secondary/faint text, accent,
  on-accent, danger, warning, success, and overlay. Light and dark values are
  the only two palettes.
- Tailwind 4 `@theme inline` maps those variables to utilities used by
  components (for example `bg-surface`, `border-line`, `text-secondary`,
  `text-on-accent`). Components stop using raw `bg-zinc-*`, `bg-[#...]`,
  `border-white/*`, and `text-white` classes for chrome.
- Status colors keep their meaning: amber status text maps to the warning token,
  red to danger. Contrast targets are WCAG AA for body text (4.5:1) and 3:1 for
  borders and focus indicators in both palettes.
- Deck content, thumbnails, and slide backgrounds are never recolored by the
  theme.

### Behavior

- Modes: `light`, `dark`, `system`. Default is `system`.
- `localStorage['htmlppt.theme']` stores the mode; an absent or invalid value
  falls back to `system`.
- System mode resolves through `matchMedia('(prefers-color-scheme: dark)')` and
  updates live when the OS preference changes, removing the listener on
  cleanup. Explicit light/dark modes ignore media changes.
- The resolved value is written to `<html data-theme="light|dark">` and
  `style.colorScheme`, so form controls and scrollbars match. Tests also read
  `data-theme-mode` with the selected mode.
- `packages/editor/index.html` runs a small inline bootstrap before the module
  script: it reads the stored mode, falls back to the media query, and sets
  `data-theme` to prevent a light flash before React mounts. The provider adopts
  the same value on first render instead of repainting.
- The toolbar gets a compact three-state control next to the language menu with
  `data-testid="theme-select"` and a localized `aria-label`. Options are
  localized Light, Dark, and System labels.
- The provider lives in `packages/editor/src/theme/` with `ThemeProvider`,
  `useTheme()`, and pure helpers for resolution and storage. It composes with
  `LocaleProvider`; the phase ordering keeps theme labels in the dictionaries
  from day one.

## Testing

Host integration:

- Bootstrap: tokenized `/` sets the cookie and 302s to `/d/<name>`;
  `?token=` on another page path also cleans the URL.
- `/d/<name>` with cookie serves the editor; wrong name returns 404; missing
  auth returns 401; root with cookie redirects.
- `/api/deck` succeeds with cookie and with bearer; Origin rejection still
  applies; SSE works with cookie and with query token.
- Open: success rebinds path, revision, watcher, and registry callback; no-op
  same path; 409 for a deck open on another port; 400/404/422 errors; invalid
  deck leaves the current deck intact; other tabs receive a revision event.

Editor E2E:

- Path input opens a second deck, updates the URL to `/d/<name>`, and autosaves
  to the new file.
- Open failure shows an inline alert and keeps editing the current deck.
- Pending edits are saved before opening; a forced save failure aborts.
- Picker path switches to standalone with write-back.
- Language menu switches to English and Simplified Chinese, updates labels and
  `<html lang>`, and persists across reload.
- First visit under an en-US, zh-CN, and zh-TW browser locale shows the expected
  language.

Runtime E2E:

- Controls and notices localize under en-US, zh-CN, and zh-TW browser locales.
- `data-ppt-locale` overrides the browser language.
- Presenter window uses the same locale.

Theming unit tests:

- Mode resolution: stored `light`/`dark` wins; missing or invalid values become
  `system`; system reads the media query.
- A media-query change re-resolves only in system mode and stops after the
  provider unmounts.

Theming E2E:

- With `colorScheme: 'light'` and no stored preference, the chrome renders the
  light palette; with `'dark'` it renders the dark palette.
- Choosing Light or Dark overrides emulated OS preference, updates
  `data-theme` and `data-theme-mode`, and survives reload.
- Choosing System resumes following `colorScheme` changes.
- Primary text against its surface meets a 4.5:1 contrast ratio in both
  palettes, and focus outlines remain visible.
- A slide's computed text and background colors are identical in both themes.

Existing suites: `playwright.config.ts` sets `locale: 'zh-TW'` so the current
Chinese assertions remain valid; new tests opt into other locales explicitly.
Unit tests that render editor components wrap them in `LocaleProvider` with an
explicit locale and in `ThemeProvider` with an explicit mode.

## Rollout

Four independently verifiable phases, each with RED tests first, full
`npm run verify`, and a green hosted CI run before the next phase:

1. Friendly URL and cookie auth.
2. `POST /api/open` plus editor path input and picker.
3. i18n framework, editor copy migration, runtime/presenter localization.
4. Theme tokens, provider, toolbar control, and light/dark/system E2E.

Documentation updates: `README.md` (URL, open-file usage, theme menu),
`SECURITY.md` (cookie auth), `docs/architecture.md` (routes and provider state),
and `docs/contract.md` (the optional `data-ppt-locale` author override).
