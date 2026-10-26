# Local auto-login for the deck host

Date: 2026-10-25
Status: approach approved in chat; spec review pending. No implementation starts
before approval.

## Context

`htmlppt open` mints a fresh capability token on every start
(`packages/cli/src/index.ts:547`) and binds an OS-assigned port because `--port`
defaults to `0` (`packages/cli/src/index.ts:514`). The bootstrap cookie is a
session cookie with no `Max-Age` (`packages/host/src/server.ts:111-113`).

Those three facts make a reopened deck URL unusable by construction. After any
restart the token differs, the port differs, and a closed browser drops the
cookie, so a bookmark, a history entry, or a restored tab always answers
`401 Unauthorized`. The only recovery is returning to a terminal for a new
tokenized URL, which is disproportionate for a loopback tool whose user is
already the owner of the machine.

`open` also trusts the session registry too readily. `findLiveSession`
(`packages/mcp/src/host-session.ts:45-67`) treats a live pid plus
`/api/health` 200 as a reusable host and `open` prints that entry's stored URL
(`packages/cli/src/index.ts:527-536`). On 2026-10-24 a host started from the
repository path used before the move stayed alive and kept answering health 200
while its editor build had moved: `/` returned 500, `/d/<name>` and the editor
assets returned 404, and `open` kept handing out that dead URL. Liveness must
prove the host can still serve the editor, not merely that a process is
listening.

## Goals

- A bookmarked or restored `/d/<name>` URL opens the editor without a CLI
  round-trip whenever that deck's host is running.
- The capability secret still rotates when the session ends.
- `open` never adopts a host that cannot serve the editor, and a stale entry
  never masks a healthy new host.
- Port conflicts, unhealthy hosts, and missing hosts each produce a specific,
  actionable message.

## Non-goals

- Removing authentication, adding a `--no-auth` mode, or binding beyond
  loopback.
- A resident daemon, launch-at-login, or a URL protocol handler. A bookmark for
  a deck whose host is not running still needs one `htmlppt open`.
- Serving several decks from one process; one deck per host stays.
- Changing bearer auth for CLI, MCP, and tests, or the token/cookie boundary
  documented in `AGENTS.md`.
- Storing anything in the browser beyond the existing cookie.

## Decisions

- Add a first-class **deck credential** store at
  `~/.htmlppt/decks/<sessionKey(deckPath)>.json`, honoring `HTMLPPT_HOME` and
  reusing the existing key derivation. Shape:
  `{ token, port, createdAt, updatedAt }`.
- Credentials live beside the session registry, not inside it. The registry
  answers "what is running now"; credentials answer "how this deck is reached
  again". Conflating them is what let the pre-move leftover entry hijack
  `open`.
- `stop` rotates the token and keeps the port.
- The cookie gains `Max-Age=2592000` (30 days) and slides on document
  navigations only.
- Reuse requires pid alive, `/api/health` 200, and the editor shell reachable.

## Behavior

### `htmlppt open <file>`

1. Resolve the deck path as today.
2. `findLiveSession` with the verified liveness check below. On success, print
   `HTMLPPT_URL=` and open the browser exactly as today.
3. Otherwise load the credential for the deck, if any, and start the host with
   `port: credential?.port ?? 0` and `token: credential?.token ?? randomUUID()`.
4. If the sticky port is owned by another process, retry once on port `0`,
   print one stderr warning that the address changed and existing bookmarks for
   the old address no longer apply, and persist the new port. The token is kept.
5. Persist `{ token, port }` and write the session entry as today.

The command surface does not change. `HTMLPPT_URL` keeps carrying the token, so
CLI automation and MCP are unaffected.

### `htmlppt stop <file>`

1. Stop the host as today.
2. Write the credential with a freshly minted token and the same port.
3. Remove the session entry.

If the credential write fails, report it on stderr and still remove the session
entry; the next `open` mints a token anyway. A stop that cannot reach a host
leaves both the credential and the entry untouched.

### Verified liveness

Extend `checkHost` in `packages/mcp/src/host-session.ts`:

- pid alive (existing),
- `/api/health` with the entry token returns 200 (existing),
- new: `GET /?token=<entry.token>` following redirects ends at 200 with an HTML
  content type whose body contains the editor shell marker, within a 2 second
  timeout.

Failures map to `unhealthy` as they do now. When `open` finds an entry that is
alive but unhealthy, it retries the probe once after 150 ms to absorb a
transient failure, then stops that entry through the regular stop path (the
registry, pid, and token already prove ownership) and continues with a fresh
host. It never kills a process the registry does not own.

### Cookie renewal

Routes that already emit the cookie (`/` and `/d/:name`) attach `Max-Age` on
every successful document navigation, including their 302 responses, so an
active session slides forward. `/api/*` responses never set the cookie.

### Migration

The first `open` after the upgrade has no credential. If a verified live session
already exists, adopt its `{ token, port }` as the credential so the running
editor keeps working without a restart. Otherwise mint both.

### Unauthorized page

The 401 text stops being a dead end. For document navigations it names the deck
and states that this browser has no valid session cookie for it, then lists the
one recovery step (`htmlppt open <deck>` prints a tokenized URL) and why the
cookie is missing. API requests keep the JSON 401 unchanged. No new endpoint is
added.

## Security notes

- The token remains an unguessable per-deck capability for a loopback listener.
  Persisting it means a leaked token stays valid until the next `stop`, which
  rotates it; rotation on stop bounds its life to one host lifetime.
- The credential file is created with owner-only permissions where the platform
  supports them and holds no deck content.
- The cookie keeps `HttpOnly; SameSite=Strict; Path=/`. A 30-day sliding window
  is not a permanent grant, and `/api/*` still enforces the Origin check.
- `SECURITY.md` documents the credential file, its rotation, and what a reader
  of that file can do. `docs/architecture.md` documents the new store and the
  verified liveness probe.

## Testing

Unit:

- Credential read/write/rotate; corrupt or foreign-shaped files are treated as
  absent; the key matches the session key for the same path spelling.
- Port selection: sticky port reused; a busy port falls back to `0` and records
  the new one.

Integration (real host process over HTTP):

- Two consecutive `open` calls for the same deck reuse the same port and token.
- `stop` rotates the token and keeps the port; the next `open` reuses the port
  and the new token.
- Cookie carries `Max-Age`, and a document navigation renews it while an
  `/api/*` call does not.
- Stale host: start a host, remove its editor build, then `open` reports the
  unhealthy entry, stops it, and starts a healthy host on the sticky port.
- Port conflict: occupy the credential port with an unrelated listener; `open`
  starts on another port, prints the warning, and persists it.
- Migration: an existing live session without a credential is adopted without a
  restart.

E2E (real browser):

- Open a deck, close the browser context, reopen the bookmarked `/d/<name>`
  while the host lives: the editor loads with no token in the URL.
- Restart the host, re-run `open`, and the same bookmark loads again.
- After `stop`, the bookmark answers the new actionable 401 page.

## Rollout

Two phases, each with RED tests first, full `npm run verify` on the final HEAD,
and a green hosted CI run before the next phase:

1. Credential store, sticky port and token, cookie `Max-Age`, migration.
2. Verified liveness, stale-entry replacement, unauthorized copy, and E2E
   bookmark survival.

Documentation updates: `README.md` (bookmarkable URL, `stop` rotation),
`SECURITY.md` (credential file and rotation), `docs/architecture.md` (credential
store, liveness probe).
