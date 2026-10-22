# M2 Host, MCP, Skill, and Packaging Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Deliver the backend half of v1: durable host sessions with live revision events, a real MCP stdio server with direct and host-attached modes, the `outline`/`stop`/`mcp` CLI commands, the agent skill, and a single installable `htmlppt` package with a smoke test.

**Architecture:** Host gains a session registry, a file watcher with debounced SSE broadcasts, and a 20-entry in-memory history. MCP is a new `packages/mcp` workspace package using the official MCP SDK; a `DeckService` abstraction switches between direct file access and the host HTTP API. Node file I/O and compare-and-swap writes move into `@htmlppt/core/node` so host, CLI, and MCP share one implementation. Packaging is a new `packages/htmlppt` bundle that copies editor assets and the skill and bundles all Node entry points.

**Tech Stack:** TypeScript strict, ESM, Hono 4, `@modelcontextprotocol/sdk` 1.32, zod, tsup, Vitest 3, Playwright, Node >= 20.

**Spec:** `docs/superpowers/specs/2026-10-21-html-ppt-editor-design.md` §6–§9, §13–§15; `docs/superpowers/specs/2026-10-21-test-framework-design.md` §6–§8, §13.

## Global Constraints

- Node >= 20, ESM, TypeScript strict. No retries, skips, mocks of host/filesystem/Chromium.
- Host binds to 127.0.0.1, random port, per-session token, Origin allow-list, only the opened deck/export/editor assets.
- Every write is serialized per file and atomic (unique temp + rename), with a compare-before-rename hash check. Conflicts are structured 409 errors.
- MCP direct mode checks the file hash before writing; host mode uses `baseRevision`. Tool schemas are identical in both modes.
- No telemetry. No remote calls except the deck's own assets in a browser.
- UI copy Traditional Chinese; code/docs/CLI/MCP errors English.
- Do not edit `packages/editor` in M2. Live-sync UI is M3 task 8.
- New dependencies are limited to `@modelcontextprotocol/sdk`, `zod` (in `packages/mcp`) as recorded in the roadmap.
- Local commits only.

## File Structure

```
packages/core/src/node.ts          + hash/read/atomic-write/CAS helpers, getElement? (getElement in index)
packages/core/src/index.ts         + getElement, setSlideBackground
packages/host/src/sessions.ts      session registry (new)
packages/host/src/server.ts        watcher, SSE, history, source tracking
packages/host/src/index.ts         exports
packages/host/test/sessions.test.ts
packages/host/test/server.test.ts  + SSE/watcher tests
packages/mcp/                      new workspace package
  package.json, tsconfig.json, tsup.config.ts, vitest.config.ts
  src/deck-service.ts              DeckService interface + Direct/Host implementations
  src/tools.ts                     tool/resource registration
  src/server.ts                    createMcpServer/startStdio
  src/bin.ts                       htmlppt-mcp bin
  test/deck-service.test.ts
  test/mcp-stdio.test.ts
packages/cli/src/index.ts          outline, stop, mcp; session write on open
packages/cli/test/cli.test.ts      + session/outline/stop tests
skills/htmlppt/                    SKILL.md + references + examples
packages/htmlppt/                  publishable bundle package
  package.json, tsup.config.ts, src/cli.ts, src/mcp.ts, scripts/copy-assets.mjs
scripts/package-smoke.mjs
package.json                       workspace build/test:package scripts
docs/features.json                 + mcp, live-sync (active when tested)
```

---

### Task 1: Shared node I/O and the session registry

**Files:**
- Modify: `packages/core/src/node.ts`
- Create: `packages/core/test/node-io.test.ts`
- Create: `packages/host/src/sessions.ts`
- Modify: `packages/host/src/index.ts`
- Create: `packages/host/test/sessions.test.ts`

**Interfaces:**
- `hashHtml(html: string): string` — SHA-256 hex.
- `readDeckFile(filePath): Promise<{ html; hash; mtimeMs }>`.
- `writeDeckFileAtomic(filePath, html, expectedHash?: string): Promise<{ hash; mtimeMs }>` — throws `DeckFileConflictError` (`code: 'conflict'`) if the on-disk hash differs from `expectedHash`; unique temp, cleanup on failure, re-check immediately before rename.
- `SessionEntry { path; port; token; pid; startedAt; revision }`.
- `sessionsDirectory(): string` (`HTMLPPT_HOME` override, else `~/.htmlppt` / `sessions`).
- `writeSession(entry): Promise<void>` (0600 file, 0700 dir where supported).
- `readSession(filePath): Promise<SessionEntry | null>` (removes stale entries whose PID is dead).
- `listSessions(): Promise<SessionEntry[]>`.
- `removeSession(filePath): Promise<void>`.
- `sessionKey(path): string` — SHA-256 of the resolved absolute path.

- [ ] **Step 1: Write failing node I/O tests**

`packages/core/test/node-io.test.ts` with real temp files:

```ts
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { DeckFileConflictError, hashHtml, readDeckFile, writeDeckFileAtomic } from '../src/node.js';

describe('node deck I/O', () => {
  it('hashes deterministically and reads snapshots', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'htmlppt-io-'));
    const file = join(dir, 'deck.html');
    await writeFile(file, '<h1>One</h1>', 'utf8');
    const snapshot = await readDeckFile(file);
    expect(snapshot.html).toBe('<h1>One</h1>');
    expect(snapshot.hash).toBe(hashHtml('<h1>One</h1>'));
    expect(snapshot.hash).toMatch(/^[a-f0-9]{64}$/);
    await rm(dir, { recursive: true, force: true });
  });

  it('writes atomically and returns the new hash', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'htmlppt-io-'));
    const file = join(dir, 'deck.html');
    await writeFile(file, '<h1>One</h1>', 'utf8');
    const before = await readDeckFile(file);
    const result = await writeDeckFileAtomic(file, '<h1>Two</h1>', before.hash);
    expect(await readFile(file, 'utf8')).toBe('<h1>Two</h1>');
    expect(result.hash).toBe(hashHtml('<h1>Two</h1>'));
    await rm(dir, { recursive: true, force: true });
  });

  it('rejects a stale expected hash without touching the file', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'htmlppt-io-'));
    const file = join(dir, 'deck.html');
    await writeFile(file, '<h1>External</h1>', 'utf8');
    await expect(
      writeDeckFileAtomic(file, '<h1>Mine</h1>', hashHtml('<h1>Old</h1>'))
    ).rejects.toBeInstanceOf(DeckFileConflictError);
    expect(await readFile(file, 'utf8')).toBe('<h1>External</h1>');
    await rm(dir, { recursive: true, force: true });
  });
});
```

- [ ] **Step 2: RED**

`npm run test -w @htmlppt/core -- node-io` → FAIL (exports missing).

- [ ] **Step 3: Implement node I/O**

Move the host's existing temp/rename logic into `packages/core/src/node.ts` unchanged in behavior, with `randomUUID()` temp names, `finally` cleanup, and a final `readFile` hash comparison immediately before `rename`. Export from `node.ts` (not from the environment-neutral root).

- [ ] **Step 4: Write failing session registry tests**

`packages/host/test/sessions.test.ts` uses a temp `HTMLPPT_HOME` per test:

```ts
process.env.HTMLPPT_HOME = await mkdtemp(join(tmpdir(), 'htmlppt-home-'));
```

Cases: write/read round-trip with mode 0600; key is stable for the same resolved path and differs for another; `listSessions` returns entries; a dead PID (`Number.MAX_SAFE_INTEGER`) is removed on read; `removeSession` is idempotent; malformed JSON is ignored and removed.

- [ ] **Step 5: RED**

`npm run test -w @htmlppt/host -- sessions` → FAIL.

- [ ] **Step 6: Implement the registry**

Use `node:fs/promises` (`mkdir`, `readFile`, `writeFile`, `rm`, `readdir`), `node:crypto` `createHash`, `node:os` `homedir`, `node:process` (or global) `kill(pid, 0)` with ESRCH handling. Never throw for malformed or stale files; clean them.

- [ ] **Step 7: Commit**

```bash
git add packages/core packages/host
git commit -m "feat(host): add shared deck I/O and session registry"
```

---

### Task 2: Host watcher, SSE, and revision history

**Files:**
- Modify: `packages/host/src/server.ts`
- Modify: `packages/host/src/index.ts`
- Modify: `packages/host/test/server.test.ts`

**Interfaces:**
- `GET /api/events` — authenticated SSE. First event `event: hello` with `{ revision }`; then `event: revision` with `{ revision, source: 'editor'|'external'|'mcp' }`; heartbeat comment every 15 s.
- `PUT /api/deck` accepts optional `x-htmlppt-source: editor|mcp` (default `editor`), reflected in the revision event. It also accepts `force: true` in the body, which skips the `baseRevision` comparison for the editor's explicit "overwrite" conflict action; the response still returns the new revision.
- `HostHandle` gains `sessions?: never`; no public history API. Internal history keeps 20 `{ revision, html, at, source }` entries.
- External changes detected by a debounced `fs.watchFile` poll (50 ms interval, 100 ms debounce), hashed and compared; self-writes do not emit duplicate events.

- [ ] **Step 1: Write failing SSE tests**

In `packages/host/test/server.test.ts`, use real `fetch` and a temp deck:

```ts
const response = await fetch(`${host.url}/api/events?token=${token}`);
expect(response.headers.get('content-type')).toContain('text/event-stream');
const reader = response.body!.getReader();
```

Read until an event arrives with a bounded `Promise.race` timeout helper; never sleep-loop without a bound. Cases:
1. On connect, `hello` with the current revision.
2. External `writeFile` → `revision` event with `source: 'external'` and the new hash.
3. `PUT` with a valid base revision → `revision` event with `source: 'editor'`.
4. `PUT` with `x-htmlppt-source: mcp` → `source: 'mcp'`.
5. A no-op PUT/external write with identical content does not emit a second revision event.
6. Missing/wrong token → 401; foreign Origin → 403.
7. `PUT` with a stale `baseRevision` and `force: true` succeeds, emits a revision event, and the file matches the forced payload.
8. `host.close()` ends the stream and clears the watcher (no open handles; the Vitest process exits).

- [ ] **Step 2: RED**

`npm run test -w @htmlppt/host` → FAIL (404 on events).

- [ ] **Step 3: Implement**

- Track SSE clients (`Set<ReadableStreamDefaultController>` or Hono `streamSSE`), remove on abort.
- Keep `history` bounded to 20; push on every committed change with source.
- Start `watchFile` after the initial read; debounce with `setTimeout` 100 ms; call the existing `syncFromDisk`; if the hash changed, broadcast `external`.
- On PUT, use the core CAS writer with the accepted revision, update cache/history, broadcast with the request source.
- On close: `unwatchFile`, clear timers, close SSE streams, then server close.
- Keep M1 behavior for GET/PUT, external sync, 409s, auth, and origin checks.

- [ ] **Step 4: GREEN + full host suite**

`npm run test -w @htmlppt/host` — all pass. Repeat the SSE suite 3 times locally to check for timing flakes; fix root causes, do not add retries.

- [ ] **Step 5: Commit**

```bash
git add packages/host
git commit -m "feat(host): stream revision events with file watching"
```

---

### Task 3: MCP deck services (direct and host-attached)

**Files:**
- Create: `packages/mcp/package.json`, `tsconfig.json`, `tsup.config.ts`, `vitest.config.ts`
- Create: `packages/mcp/src/deck-service.ts`
- Create: `packages/mcp/test/deck-service.test.ts`
- Modify: `package.json` (workspace already covers `packages/*`; no change unless scripts need it)

**Interfaces:**
- `DeckSnapshot { document: Document; html: string; revision: string; filePath: string }`.
- `DeckConflictError extends Error { code: 'conflict'; currentRevision?: string }`.
- `DeckService { load(path): Promise<DeckSnapshot>; save(path, snapshot, mutation): Promise<{ revision; document }>; write(path, html, baseRevision): Promise<{ revision }> }` — `save` clones, applies the callback through `mutateDeck`, serializes, and writes with compare-and-swap.
- `DirectDeckService` — real file, `parseDeckHtml`, `normalizeDeck`, `serializeDeck`, atomic write with the loaded revision.
- `HostDeckService` — `GET/PUT /api/deck` with bearer token; 409 maps to `DeckConflictError`.
- `createDeckService(path, options?: { hostUrl?; token? }): Promise<DeckService>` — uses host when a live session exists, otherwise direct.

- [ ] **Step 1: Scaffold the package**

`package.json`:

```json
{
  "name": "@htmlppt/mcp",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "main": "./dist/index.js",
  "types": "./dist/index.d.ts",
  "bin": { "htmlppt-mcp": "./dist/bin.js" },
  "exports": {
    ".": { "types": "./dist/index.d.ts", "import": "./dist/index.js" }
  },
  "scripts": {
    "build": "tsup src/index.ts src/bin.ts --format esm --dts --clean",
    "typecheck": "tsc --noEmit",
    "test": "vitest run"
  },
  "dependencies": {
    "@htmlppt/core": "0.0.0",
    "@htmlppt/host": "0.0.0",
    "@modelcontextprotocol/sdk": "^1.32.1",
    "zod": "^3.24.0"
  },
  "devDependencies": {
    "@htmlppt/test-utils": "0.0.0",
    "tsup": "^8.3.0",
    "typescript": "^5.7.0",
    "vitest": "^3.0.0"
  }
}
```

Use a vitest config aliasing core/host sources like CLI does. Build before tests that spawn the bin.

- [ ] **Step 2: Write failing service tests**

Real temp files:
- Direct load normalizes missing ids in memory; the file is unchanged until save.
- Save applies `setText`/`addSlide`, writes normalized valid HTML, returns a new revision.
- A stale snapshot save throws `DeckConflictError` and leaves the external file byte-identical.
- Invalid mutation surfaces `DeckMutationError`.
- Host service: start a real host with a token; load/save round-trip; stale revision 409 maps to conflict; file content matches.

- [ ] **Step 3: RED**

`npm run test -w @htmlppt/mcp` → FAIL (module missing).

- [ ] **Step 4: Implement services**

Normalize on load; serialize after mutation. Direct save flow:
1. `readDeckFile` (current hash) and compare to `snapshot.revision`; on mismatch throw conflict.
2. `mutateDeck(snapshot.document, mutation)`.
3. `serializeDeck(document)`.
4. `writeDeckFileAtomic(path, html, snapshot.revision)`; map a race conflict to `DeckConflictError`.

Host service uses `fetch` with `authorization: Bearer`; no shell.

- [ ] **Step 5: GREEN and commit**

```bash
git add packages/mcp package-lock.json
git commit -m "feat(mcp): add direct and host deck services"
```

---

### Task 4: MCP tools, resources, and stdio server

**Files:**
- Modify: `packages/core/src/index.ts` (add `getElement`, `setSlideBackground`)
- Create: `packages/core/test/read-models.test.ts` (getElement)
- Create: `packages/core/test/background.test.ts` (setSlideBackground)
- Create: `packages/mcp/src/tools.ts`
- Create: `packages/mcp/src/server.ts`
- Create: `packages/mcp/src/bin.ts`
- Create: `packages/mcp/test/mcp-stdio.test.ts`

**Interfaces:**
- `getElement(doc, slideId, target): { html: string; style: string | null }`.
- `setSlideBackground(doc, slideId, background: { color?: string; gradient?: string; image?: string }): void` — exactly one field; sets inline `background`/`background-image`; clears previous values.
- `createMcpServer(options: { cwd?: string }): McpServer` registers:
  - read-only: `get_deck_contract`, `validate_deck`, `get_outline`, `read_slide`, `get_element`.
  - mutations: `create_deck`, `add_slide`, `update_slide_html`, `duplicate_slide`, `delete_slide`, `move_slide`, `set_notes`, `set_transition`, `set_slide_background`, `add_element`, `set_element_html`, `set_text`, `set_style`, `remove_element`, `set_slide_order`.
  - workflow: `open_editor` (spawn detached `htmlppt open <path> --no-browser`, wait for the session registry, return the URL), `export_deck` with `format: 'html'` only (PDF/PNG arrive in M5).
- Every tool returns JSON text content; failures return `isError: true` with `{ code, message, path?, slideId?, target? }`.
- Resources: `htmlppt://contract`, `htmlppt://authoring`, `htmlppt://example` (read from `packages/mcp/src/resources/` bundled as strings).
- `startStdio(options?)` connects `StdioServerTransport`.
- Bin has a shebang and calls `startStdio()`.

- [ ] **Step 1: Write failing core tests**

`getElement` resolves by elementId/selector/path, returns `outerHTML` and raw `style`; unknown/ambiguous targets throw `DeckMutationError`-style errors with stable codes. `setSlideBackground` writes color/gradient/image values and clears the others; invalid combination throws.

- [ ] **Step 2: RED/GREEN core**

`npm run test -w @htmlppt/core`, then implement in `outline.ts`/`mutations.ts` and export from the root.

- [ ] **Step 3: Write the stdio integration test**

`packages/mcp/test/mcp-stdio.test.ts`:
- Build the package in `beforeAll` (`npm run build -w @htmlppt/mcp`) or rely on the root pretest script.
- Spawn `node dist/bin.js` with the SDK `Client`/`StdioClientTransport`.
- `initialize` handshake; `tools/list` includes every tool above; `resources/list` includes the three URIs.
- `create_deck` in a temp dir → `validate_deck` valid → `add_slide` → `set_text` → `read_slide` reflects it; disk HTML has no editor artifacts.
- External write then `set_text` → conflict error; file unchanged.
- `open_editor` and `export_deck` are registered; their end-to-end behavior is asserted in Task 6, because `open` does not write a session entry until then.
- Use real files and real processes; no mocks; one worker.

- [ ] **Step 4: RED**

`npm run test -w @htmlppt/mcp` → FAIL (no tools).

- [ ] **Step 5: Implement tools**

Use `McpServer.registerTool` with zod schemas. Path resolution: relative paths resolve against `options.cwd` (default `process.cwd()`), and the resolved path is echoed in errors. Each tool opens a service via `createDeckService`, applies exactly one service operation, and returns the revision/result.

`open_editor` uses `node:child_process.spawn(process.execPath, [cliBin, 'open', path, '--no-browser'], { detached: true, stdio: 'ignore' }).unref()`; the CLI bin path resolves from `@htmlppt/cli` in the workspace and from the bundled package in production. Poll `readSession` for up to 5 s, then return the URL or an actionable error.

- [ ] **Step 6: GREEN and commit**

```bash
git add packages/core packages/mcp
git commit -m "feat(mcp): expose deck tools and resources over stdio"
```

---

### Task 5: Host-attached MCP mode

**Files:**
- Modify: `packages/mcp/src/deck-service.ts`
- Create: `packages/mcp/src/host-session.ts`
- Modify: `packages/mcp/test/deck-service.test.ts`, `packages/mcp/test/mcp-stdio.test.ts`

**Interfaces:**
- `findLiveSession(filePath): Promise<SessionEntry | null>` — reads the registry, verifies process liveness and `GET /api/health` with the token, removes stale entries.
- `createDeckService` auto-selects host mode when a live session exists unless `HTMLPPT_MCP_MODE=direct`.
- Host mode mutations PUT with `baseRevision` and `x-htmlppt-source: mcp`; the editor receives a `source: 'mcp'` SSE event.
- Direct mode remains the default when no host is open.

- [ ] **Step 1: Write failing tests**

- Start a host via `startCliHost`/CLI, call a mutation tool, assert the file and the host revision change, and an SSE client sees `source: 'mcp'`.
- Kill the host, call again → falls back to direct mode and succeeds.
- A dead/stale registry entry is removed.

- [ ] **Step 2: RED/GREEN/commit**

```bash
git add packages/mcp
git commit -m "feat(mcp): attach to live host sessions"
```

---

### Task 6: CLI outline, stop, and mcp commands

**Files:**
- Modify: `packages/cli/src/index.ts`
- Modify: `packages/cli/test/cli.test.ts`
- Modify: `packages/cli/package.json` (dependency on `@htmlppt/mcp`)
- Modify: `packages/mcp/test/mcp-stdio.test.ts` (deferred `open_editor` end-to-end case)

**Interfaces:**
- `htmlppt outline <file> [--json]` — human summary or `JSON.stringify(getOutline(...))`.
- `htmlppt stop [file] [--all]` — reads the registry, verifies health, sends SIGTERM (Windows-compatible), waits up to 5 s, removes the entry; exit 1 with actionable messages when nothing matches.
- `htmlppt mcp` — starts the MCP stdio server (equivalent to `htmlppt-mcp`).
- `htmlppt open` writes a session entry after listening and removes it on host close; if an existing session for the same file is live, reuse it and print its URL instead of starting a second host.

- [ ] **Step 1: Write failing CLI tests**

Real CLI processes with a temp `HTMLPPT_HOME` and temp deck:
- `open --no-browser` → stdout URL, registry entry exists with the port/token/pid.
- Second `open` for the same file → same URL, one entry.
- `stop` → exit 0, process exits within 5 s, entry removed; second `stop` → exit 1.
- `stop --all` with two hosts stops both.
- `outline --json` on the basic fixture returns title/slide ids/elements.
- `mcp --help` and a one-shot stdio handshake (spawn, send initialize, receive serverInfo, close).
- MCP `open_editor` on a temp deck starts a host through the CLI, returns a tokenized 127.0.0.1 URL, and the process is cleanly stopped (deferred from Task 4 because `open` writes sessions here).

- [ ] **Step 2: RED/GREEN**

Run `npm run test -w @htmlppt/cli`. Implement with the existing `runCli` IO abstraction; never kill a PID without a matching live session health check.

- [ ] **Step 3: Commit**

```bash
git add packages/cli
git commit -m "feat(cli): add outline, stop, and mcp commands"
```

---

### Task 7: Agent skill and examples

**Files:**
- Create: `skills/htmlppt/SKILL.md`
- Create: `skills/htmlppt/references/contract.md`, `authoring.md`, `mcp-tools.md`, `troubleshooting.md`
- Create: `skills/htmlppt/examples/basic.html`, `table-chart.html`, `notes-transitions.html`
- Create: `packages/core/test/skill-examples.test.ts` or `packages/cli/test/examples.test.ts`

**Interfaces:** no runtime API; the skill teaches the contract, MCP workflow, editor-friendly authoring, styling freedom, round-trip rules, and common failures. Examples are valid contract decks with the runtime.

- [ ] **Step 1: Author the skill**

Use `superpowers:writing-skills`/`skill-creator` conventions: frontmatter with name/description, "when to use", contract summary, starter template, MCP workflow, examples, troubleshooting. Reference the MCP tool names exactly as implemented.

- [ ] **Step 2: Write failing example tests**

An integration test runs the built CLI `validate` on each example (exit 0) and asserts the examples contain `data-ppt-runtime="1"` and unique slide ids. Add the test, watch it fail while files are absent, then add the examples.

- [ ] **Step 3: Commit**

```bash
git add skills packages/cli/test
git commit -m "docs(skill): add agent skill and example decks"
```

---

### Task 8: Single-package bundle and smoke test

**Files:**
- Create: `packages/htmlppt/package.json`, `tsup.config.ts`, `scripts/copy-assets.mjs`
- Create: `packages/htmlppt/src/cli.ts`, `src/mcp.ts`
- Modify: `packages/cli/src/index.ts` (editor-dir resolution for packaged layout)
- Create: `scripts/package-smoke.mjs`
- Modify: `package.json` (build order, `test:package`)

**Interfaces:**
- Package name `htmlppt`, bins `htmlppt` → `dist/cli.js`, `htmlppt-mcp` → `dist/mcp.js`.
- `files`: `dist`, `README.md`, `LICENSE`, `SECURITY.md`.
- `dist/editor/index.html` + assets copied from `packages/editor/dist`.
- `dist/skill/**` copied from `skills/htmlppt`.
- CLI editor resolution: `HTMLPPT_EDITOR_DIR` → `<packageRoot>/dist/editor` → workspace `packages/editor/dist` (existing behavior).
- `npm run test:package` builds everything, runs `npm pack`, installs the tarball in a temp project, and runs: `htmlppt --help`, `new`, `validate`, `open --no-browser` then `stop`, and an MCP initialize handshake. It asserts `dist/editor/index.html` and `dist/skill/SKILL.md` exist.

- [ ] **Step 1: Write the smoke script and make it fail**

`scripts/package-smoke.mjs` uses `node:child_process.execFile`, `mkdtemp`, and `npm pack --json`. It must not use a global install; install the tarball with `npm install --no-save <tarball>` in the temp dir. Assert real stdout/exit codes and clean up.

- [ ] **Step 2: Implement the bundle**

tsup `noExternal` for `@htmlppt/*`; bundle `@modelcontextprotocol/sdk`/zod or leave them as dependencies (choose bundle for a single tarball, verify with the smoke test). Copy assets after build.

- [ ] **Step 3: Full gate**

```bash
npm run verify
npm run test:package
npm run test:matrix
```

- [ ] **Step 4: Commit**

```bash
git add packages/htmlppt packages/cli scripts package.json package-lock.json
git commit -m "feat(package): bundle editor, core, host, mcp, and skill"
```

---

## M2 Exit

- `npm run verify` green.
- `npm run test:package` green.
- Manually: `htmlppt new`, `open`, edit, external write → SSE event (verified by tests), `stop`, MCP direct and host-attached mutations.
- Update `docs/features.json`: `mcp` active with an MCP-tagged integration/E2E test; `live-sync` stays planned until M3 task 8.
- Whole-branch review, merge to main, post-merge `npm run verify`.
