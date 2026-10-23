# Open and Import Deck Path Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let the running editor switch to another deck by typing a path or choosing a file, without restarting the host, while keeping saves, watcher state, the session registry, and the visible URL correct.

**Architecture:** Add `POST /api/open` to the host. It normalizes and validates the target, rejects a deck already served by another live host, rebinds the watcher and revision state inside the save lock, broadcasts a revision, and asks the CLI to move its registry entry. The toolbar path becomes editable in host mode and calls the endpoint after saving pending edits; a folder button reuses the existing standalone picker and File System Access path.

**Tech Stack:** TypeScript, Hono, Node `fs`/`url`, React 19, Vitest, Playwright.

**Spec:** `docs/superpowers/specs/2026-10-23-editor-open-url-i18n-design.md` (section 2)

## Global Constraints

- `POST /api/open` uses the existing page/API auth: bearer or session cookie. No new public surface.
- The host still serves exactly one deck at a time; opening another deck rebinds this host.
- Reject a target that a different live host already serves with `409 deck-already-open`.
- Save pending editor edits before calling open; a failed save or conflict aborts and keeps the current deck.
- Validate the target before touching the current deck state: a bad file must leave html, revision, watcher, and URL unchanged.
- Do not change CLI/MCP output language in this phase.
- Phase 2 starts only after Phase 1 has a green hosted CI run. Every task is RED, GREEN, commit.
- Never weaken an existing test to make a rebind pass.

---

## File Structure

- Create `packages/host/src/open-path.ts`: pure/async path normalization and extension errors.
- Create `packages/host/src/open-path.test.ts`: normalization unit tests.
- Modify `packages/host/src/server.ts`: mutable deck path, `/api/open`, rebind under the save lock, registry conflict check, `onDeckOpened`.
- Modify `packages/host/test/server.test.ts`: endpoint, rebind, watcher, SSE, registry-conflict tests.
- Modify `packages/cli/src/index.ts`: canonicalize the open path, registry-move callback, and mutable session snapshot.
- Modify `packages/mcp/src/host-session.ts`: canonicalize `findLiveSession` input before the registry key and entry comparison.
- Modify `packages/mcp/test/deck-service.test.ts`: alias-path lookup coverage.
- Modify `packages/editor/src/api.ts`: `openDeck()` and `DeckOpenError`.
- Create `packages/editor/src/file-picker.ts`: shared HTML picker used by the launcher and the toolbar.
- Create `packages/editor/src/components/PathInput.tsx`: editable path field, folder button, inline error.
- Modify `packages/editor/src/components/Toolbar.tsx`: replace the path span with `PathInput`.
- Modify `packages/editor/src/components/StandaloneLauncher.tsx`: use the shared picker.
- Modify `packages/editor/src/App.tsx`: open handler, picker handler, save guard, URL synchronisation.
- Create `e2e/open.spec.ts`: real CLI/host/second-deck coverage.
- Modify `README.md`, `docs/architecture.md`: open endpoint and editor usage.

---

### Task 1: Path normalization module

**Files:**
- Create: `packages/host/src/open-path.ts`
- Test: `packages/host/src/open-path.test.ts`

**Interfaces:**
- Produces:

```ts
export type OpenPathErrorCode =
  | 'invalid-path'
  | 'not-found'
  | 'unsupported-extension';

export class OpenPathError extends Error {
  readonly code: OpenPathErrorCode;
}

export async function resolveDeckPath(
  input: string,
  cwd: string,
  home: string
): Promise<string>;
```

- `resolveDeckPath` trims, strips one matching quote pair, converts `file://`, expands a leading `~`, resolves against `cwd`, calls `realpath`, and requires `.html`/`.htm` case-insensitively.
- `not-found` covers `ENOENT`; `invalid-path` covers unusable input and other realpath failures; `unsupported-extension` is a separate code.

- [ ] **Step 1: Write failing tests**

Create `packages/host/src/open-path.test.ts`:

```ts
import { mkdir, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { OpenPathError, resolveDeckPath } from './open-path.js';

const directories: string[] = [];

async function makeDirectory(): Promise<string> {
  const directory = await import('node:fs/promises').then(({ mkdtemp }) =>
    mkdtemp(join(tmpdir(), 'htmlppt-open-path-'))
  );
  directories.push(directory);
  return directory;
}

afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true })
    )
  );
});

describe('resolveDeckPath', () => {
  it('resolves a relative path against the supplied cwd', async () => {
    const directory = await makeDirectory();
    const deck = join(directory, 'deck.html');
    await writeFile(deck, '<main data-ppt-deck></main>', 'utf8');

    await expect(resolveDeckPath('deck.html', directory, directory)).resolves.toBe(
      await realpath(deck)
    );
  });

  it('accepts a file URL, quotes, whitespace, tilde, and htm', async () => {
    const directory = await makeDirectory();
    const deck = join(directory, 'deck.htm');
    await writeFile(deck, '<main data-ppt-deck></main>', 'utf8');
    const canonical = await realpath(deck);

    await expect(
      resolveDeckPath(`  "${pathToFileURL(deck).href}"  `, directory, directory)
    ).resolves.toBe(canonical);
    await expect(
      resolveDeckPath("'deck.htm'", directory, directory)
    ).resolves.toBe(canonical);
    await expect(
      resolveDeckPath('~/deck.htm', directory, directory)
    ).resolves.toBe(canonical);
  });

  it('rejects a missing file, an unsupported extension, and an empty value', async () => {
    const directory = await makeDirectory();
    await writeFile(join(directory, 'notes.txt'), 'nope', 'utf8');

    await expect(resolveDeckPath('missing.html', directory, directory)).rejects.toMatchObject({
      code: 'not-found'
    });
    await expect(resolveDeckPath('notes.txt', directory, directory)).rejects.toMatchObject({
      code: 'unsupported-extension'
    });
    await expect(resolveDeckPath('   ', directory, directory)).rejects.toMatchObject({
      code: 'invalid-path'
    });
    expect(new OpenPathError('not-found')).toBeInstanceOf(Error);
  });
});
```

The tilde case above is intentionally constructed from the file URL; replace the directory prefix with `~` only when `directory` is under `home`, otherwise pass a `home` equal to `dirname(directory)` and construct a `~/<name>` input. Keep the assertion exact.

- [ ] **Step 2: Run RED**

Run: `npm run test -w @htmlppt/host -- src/open-path.test.ts`

Expected: module not found.

- [ ] **Step 3: Implement**

Create `packages/host/src/open-path.ts`:

```ts
import { realpath } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export type OpenPathErrorCode =
  | 'invalid-path'
  | 'not-found'
  | 'unsupported-extension';

export class OpenPathError extends Error {
  readonly code: OpenPathErrorCode;

  constructor(code: OpenPathErrorCode) {
    super(code);
    this.name = 'OpenPathError';
    this.code = code;
  }
}

function unquote(value: string): string {
  const trimmed = value.trim();
  if (trimmed.length < 2) return trimmed;
  const first = trimmed[0];
  const last = trimmed[trimmed.length - 1];
  if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
    return trimmed.slice(1, -1).trim();
  }
  return trimmed;
}

export async function resolveDeckPath(
  input: string,
  cwd = process.cwd(),
  home = homedir()
): Promise<string> {
  let value = unquote(input);
  if (!value) throw new OpenPathError('invalid-path');

  if (value.startsWith('file://')) {
    try {
      value = fileURLToPath(value);
    } catch {
      throw new OpenPathError('invalid-path');
    }
  } else if (value === '~') {
    value = home;
  } else if (value.startsWith('~/') || value.startsWith('~\\')) {
    value = path.join(home, value.slice(2));
  }

  const resolved = path.resolve(cwd, value);

  let canonical: string;
  try {
    canonical = await realpath(resolved);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    throw new OpenPathError(code === 'ENOENT' ? 'not-found' : 'invalid-path');
  }

  if (!/\.html?$/i.test(canonical)) {
    throw new OpenPathError('unsupported-extension');
  }
  return canonical;
}
```

- [ ] **Step 4: GREEN and typecheck**

Run: `npm run test -w @htmlppt/host -- src/open-path.test.ts`

Run: `npm run typecheck -w @htmlppt/host`

- [ ] **Step 5: Commit**

```bash
git add packages/host/src/open-path.ts packages/host/src/open-path.test.ts
git commit -m "feat(host): normalize deck paths for opening"
```

---

### Task 2: Host rebind and `/api/open`

**Files:**
- Modify: `packages/host/src/server.ts`
- Test: `packages/host/test/server.test.ts`

**Interfaces:**
- Consumes: `resolveDeckPath`, `OpenPathError`, `readSession`, `friendlyDeckPath`.
- Produces:

```ts
export interface HostOptions {
  filePath: string;
  token: string;
  editorDir: string;
  port?: number;
  onDeckOpened?: (event: {
    previousPath: string;
    path: string;
    revision: string;
  }) => Promise<void> | void;
}
```

- `POST /api/open` body `{ path: string }`; response `{ html, revision, filePath, url }`.
- Error payloads are `{ error, message }` with codes `invalid-path`, `not-found`, `unsupported-extension`, `invalid-deck`, `deck-already-open`, `deck-unreadable`, `payload-too-large`.

- [ ] **Step 1: Add failing host tests**

Add a second-deck fixture helper to `packages/host/test/server.test.ts`:

```ts
async function addDeck(ctx: Context, name: string, title: string): Promise<string> {
  const source = ctx.deckHtml.replace(/<h1[^>]*>.*?<\/h1>/s, `<h1>${title}</h1>`);
  const target = join(ctx.dir, name);
  await writeFile(target, source, 'utf8');
  return target;
}
```

Add tests inside `describe('host', ...)`:

```ts
it('opens another deck and rebinds the watcher, deck API, and SSE', async () => {
  const ctx = await setup();
  const nextPath = await addDeck(ctx, 'second.html', 'Second deck');
  const cookie = await bootstrapCookie(ctx);
  const events = await connectEvents(ctx);
  try {
    await events.next();
    const response = await fetch(`${ctx.base}/api/open`, {
      method: 'POST',
      headers: { cookie, 'content-type': 'application/json' },
      body: JSON.stringify({ path: nextPath })
    });
    expect(response.status).toBe(200);
    const opened = (await response.json()) as {
      html: string;
      revision: string;
      filePath: string;
      url: string;
    };
    expect(opened.filePath).toBe(await realpath(nextPath));
    expect(opened.url).toBe('/d/second.html');
    expect(opened.html).toContain('Second deck');

    const revisionEvent = await events.next();
    expect(revisionEvent).toEqual({
      event: 'revision',
      data: { revision: opened.revision, source: 'external' }
    });

    const deck = await fetch(`${ctx.base}/api/deck`, { headers: { cookie } });
    expect(await deck.json()).toMatchObject({
      filePath: await realpath(nextPath),
      revision: opened.revision
    });
    const health = await fetch(`${ctx.base}/api/health`, { headers: { cookie } });
    expect(await health.json()).toMatchObject({
      filePath: await realpath(nextPath),
      revision: opened.revision
    });
  } finally {
    await events.close();
  }
});

it('keeps the old file unwatched after opening another deck', async () => {
  const ctx = await setup();
  const nextPath = await addDeck(ctx, 'second.html', 'Second deck');
  const cookie = await bootstrapCookie(ctx);
  const before = countStatWatchers();

  const open = await fetch(`${ctx.base}/api/open`, {
    method: 'POST',
    headers: { cookie, 'content-type': 'application/json' },
    body: JSON.stringify({ path: nextPath })
  });
  expect(open.status).toBe(200);
  expect(countStatWatchers()).toBe(before + 1);

  await writeFile(ctx.deckPath, `${ctx.deckHtml}\n<!-- old -->`, 'utf8');
  const health = await fetch(`${ctx.base}/api/health`, { headers: { cookie } });
  const afterOldWrite = (await health.json()) as { filePath: string };
  expect(afterOldWrite.filePath).toBe(await realpath(nextPath));
});

it('no-ops when the requested deck is already current', async () => {
  const ctx = await setup();
  const cookie = await bootstrapCookie(ctx);
  const response = await fetch(`${ctx.base}/api/open`, {
    method: 'POST',
    headers: { cookie, 'content-type': 'application/json' },
    body: JSON.stringify({ path: ctx.deckPath })
  });
  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({
    filePath: ctx.deckPath,
    revision: ctx.revision
  });
});

it('rejects invalid open requests without changing the deck', async () => {
  const ctx = await setup();
  const cookie = await bootstrapCookie(ctx);
  const statuses: Array<[string, number]> = [
    ['missing.html', 404],
    [ctx.dir, 422],
    [join(ctx.dir, 'notes.txt'), 422]
  ];
  for (const [target, status] of statuses) {
    const response = await fetch(`${ctx.base}/api/open`, {
      method: 'POST',
      headers: { cookie, 'content-type': 'application/json' },
      body: JSON.stringify({ path: target })
    });
    expect(response.status, target).toBe(status);
  }
  const badDeck = join(ctx.dir, 'bad.html');
  await writeFile(badDeck, '<!doctype html><p>not a deck</p>', 'utf8');
  const invalid = await fetch(`${ctx.base}/api/open`, {
    method: 'POST',
    headers: { cookie, 'content-type': 'application/json' },
    body: JSON.stringify({ path: badDeck })
  });
  expect(invalid.status).toBe(422);
  expect(await invalid.json()).toMatchObject({ error: 'invalid-deck' });

  const deck = await fetch(`${ctx.base}/api/deck`, { headers: { cookie } });
  expect(await deck.json()).toMatchObject({
    filePath: ctx.deckPath,
    revision: ctx.revision
  });
});

it('rejects a deck already served by another live host', async () => {
  const ctx = await setup();
  const other = join(ctx.dir, 'shared.html');
  await writeFile(other, ctx.deckHtml, 'utf8');
  await writeSession({
    path: await realpath(other),
    port: ctx.host.port + 1,
    token: 'other-token',
    pid: process.pid,
    startedAt: new Date().toISOString(),
    revision: ctx.revision
  });
  const cookie = await bootstrapCookie(ctx);

  const response = await fetch(`${ctx.base}/api/open`, {
    method: 'POST',
    headers: { cookie, 'content-type': 'application/json' },
    body: JSON.stringify({ path: other })
  });

  expect(response.status).toBe(409);
  expect(await response.json()).toMatchObject({ error: 'deck-already-open' });
});
```

Import `realpath` from `node:fs/promises`, `writeSession` from `../src/sessions.js`. Ensure the test cleans the session file in `afterEach` (use `HTMLPPT_HOME` per test context or remove via `removeSession`). Prefer `removeSession(other)` in the `finally` of the 409 test.

- [ ] **Step 2: Run RED**

Run: `npm run test -w @htmlppt/host -- server.test.ts`

Expected: `/api/open` returns 404.

- [ ] **Step 3: Make the deck path mutable**

In `packages/host/src/server.ts`:

- Add imports `homedir` from `node:os`; `OpenPathError`, `resolveDeckPath` from `./open-path.js`; `readSession`, `sessionKey`, `sessionsDirectory` from `./sessions.js`.
- Extend `HostOptions` with `onDeckOpened`.
- Inside `startHost`, after the initial read, add `let filePath = options.filePath;`.
- Replace every use of `options.filePath` inside `startHost` with the mutable `filePath`: `syncFromDisk`, `deckUnreadable`, health, get/put, export snapshot, `/`, `/d/:name`, `watchFile`, `unwatchFile`.
- Add:

```ts
function sessionBootstrapUrl(session: { port: number; token: string }): string {
  return `http://127.0.0.1:${session.port}/?token=${encodeURIComponent(session.token)}`;
}
```

at module scope.

- [ ] **Step 4: Add the endpoint**

Place it after `PUT /api/deck`:

```ts
  const openBodyLimit = bodyLimit({
    maxSize: 64 * 1024,
    onError: (c) =>
      c.json(
        {
          error: 'payload-too-large',
          message: 'Open requests are limited to 64 KiB.'
        },
        413
      )
  });

  app.post('/api/open', openBodyLimit, async (c) => {
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: 'invalid-path', message: 'Invalid JSON.' }, 400);
    }
    if (body === null || typeof body !== 'object' || Array.isArray(body)) {
      return c.json({ error: 'invalid-path', message: 'A path is required.' }, 400);
    }
    const requested = (body as { path?: unknown }).path;
    if (typeof requested !== 'string' || requested.trim() === '') {
      return c.json({ error: 'invalid-path', message: 'A path is required.' }, 400);
    }

    return withSaveLock(async () => {
      let target: string;
      try {
        target = await resolveDeckPath(requested, process.cwd(), homedir());
      } catch (error) {
        if (error instanceof OpenPathError) {
          const status =
            error.code === 'not-found'
              ? 404
              : error.code === 'unsupported-extension'
                ? 422
                : 400;
          return c.json({ error: error.code, message: error.message }, status);
        }
        throw error;
      }

      if (target === (await realpath(filePath).catch(() => filePath))) {
        return c.json({
          html,
          revision,
          filePath,
          url: friendlyDeckPath(filePath)
        });
      }

      const existing = await readSession(
        path.join(sessionsDirectory(), `${sessionKey(target)}.json`)
      );
      if (existing && existing.port !== port) {
        return c.json(
          {
            error: 'deck-already-open',
            message: 'This deck is already open in another host.',
            url: sessionBootstrapUrl(existing)
          },
          409
        );
      }

      let snapshot: Awaited<ReturnType<typeof readDeckFile>>;
      try {
        snapshot = await readDeckFile(target);
      } catch (error) {
        if (isUnreadable(error)) {
          const code = (error as NodeJS.ErrnoException).code;
          const missing = code === 'ENOENT';
          return c.json(
            {
              error: missing ? 'not-found' : 'deck-unreadable',
              message: `Could not read ${target}.`
            },
            missing ? 404 : 500
          );
        }
        throw error;
      }

      let document: Document;
      try {
        document = parseDeckHtml(snapshot.html);
      } catch {
        return c.json(
          { error: 'invalid-deck', message: 'The file is not valid HTML.' },
          422
        );
      }
      const validation = validateDeck(document);
      if (!validation.valid) {
        return c.json(
          {
            error: 'invalid-deck',
            message: validation.errors.join(' ')
          },
          422
        );
      }

      const previousPath = filePath;
      unwatchFile(filePath);
      if (syncTimer) {
        clearTimeout(syncTimer);
        syncTimer = undefined;
      }
      filePath = target;
      html = snapshot.html;
      revision = snapshot.hash;
      history.length = 0;
      history.push({
        revision,
        html,
        at: new Date().toISOString(),
        source: 'external'
      });
      watchFile(filePath, { interval: WATCH_INTERVAL_MS }, onFileChange);
      broadcast('revision', { revision, source: 'external' });

      try {
        await options.onDeckOpened?.({
          previousPath,
          path: filePath,
          revision
        });
      } catch (error) {
        console.error(
          `Failed to move the session registry: ${
            error instanceof Error ? error.message : String(error)
          }`
        );
      }

      return c.json({
        html,
        revision,
        filePath,
        url: friendlyDeckPath(filePath)
      });
    });
  });
```

Check `readDeckFile` return shape (`{html, hash}`). Use the real field names.

- [ ] **Step 5: GREEN**

Run: `npm run test -w @htmlppt/host -- server.test.ts`

Run: `npm run typecheck -w @htmlppt/host`

Expected: all tests pass; watcher count remains one per host; SSE receives one revision event.

- [ ] **Step 6: Commit**

```bash
git add packages/host/src/server.ts packages/host/test/server.test.ts
git commit -m "feat(host): open another deck without restarting"
```

---

### Task 3: Canonicalize deck paths and move the CLI session registry entry

**Files:**
- Modify: `packages/cli/src/index.ts:517-616`
- Modify: `packages/mcp/src/host-session.ts:26-51`
- Test: `packages/mcp/test/deck-service.test.ts` (`findLiveSession` suite)
- Test: `e2e/open.spec.ts` (created in Task 4)

**Interfaces:**
- Consumes: `HostOptions.onDeckOpened`.
- Produces: `findLiveSession` canonicalizes the requested path with `realpath` before deriving the session key and comparing `entry.path`; CLI `open` canonicalizes before `findLiveSession`, `startHost`, and `writeSession`. The registry entry moves from the old path to the new path; shutdown removes the current entry.

- [ ] **Step 1: Canonicalize paths in the CLI and MCP lookup**

The host's 409 check keys the registry by `realpath(target)`, so every writer and reader must use the same canonical form.

In `packages/cli/src/index.ts` `open`:

```ts
      const requestedPath = resolve(io.cwd, file);
      const filePath = await realpath(requestedPath).catch(() => requestedPath);
```

Use `filePath` for `findLiveSession`, `hasUnresponsiveRegisteredHost`, `startHost`, session-key derivation, and the initial `readDeckFile`.

In `packages/mcp/src/host-session.ts`, import `realpath` from `node:fs/promises` and canonicalize the input before deriving the session file and comparing the entry:

```ts
  let resolved = path.resolve(filePath);
  try {
    resolved = await realpath(resolved);
  } catch {
    // A missing deck cannot have a live session; keep the resolved spelling.
  }
```

Keep the existing `entry.path !== resolved` cleanup behavior. A stale entry written with a different spelling is removed, matching the existing stale-session policy.

Add a `findLiveSession` test using a directory alias that does not require elevated privileges:
- POSIX: `symlink(realDirectory, aliasDirectory, 'dir')`.
- Windows: `symlink(realDirectory, aliasDirectory, 'junction')`.
- Write the deck and session entry using the real path, then assert `findLiveSession(join(aliasDirectory, 'deck.html'))` returns the entry.
- Do not skip on either platform; the junction form works without Developer Mode on the Windows runner.

- [ ] **Step 2: Make the registry state mutable**

In the `open` command, change `const entry`, `const sessionFile`, and `const sessionSnapshot` to `let`. Pass the callback to `startHost`:

```ts
      const moveSession = async (event: {
        previousPath: string;
        path: string;
        revision: string;
      }): Promise<void> => {
        const nextEntry: SessionEntry = {
          ...entry,
          path: event.path,
          revision: event.revision
        };
        await writeSession(nextEntry);
        const nextFile = join(
          sessionsDirectory(),
          `${sessionKey(event.path)}.json`
        );
        const nextSnapshot = `${JSON.stringify(
          { ...nextEntry, path: resolve(event.path) },
          null,
          2
        )}\n`;
        await removeSessionIfUnchanged(sessionFile, sessionSnapshot);
        entry = nextEntry;
        sessionFile = nextFile;
        sessionSnapshot = nextSnapshot;
        io.stdout(`HTMLPPT_URL=${sessionUrl(entry)}`);
      };
```

Pass `onDeckOpened: moveSession` in the `startHost` options.

- [ ] **Step 3: Run CLI and MCP tests**

Run: `npm run test -w @htmlppt/mcp -- deck-service.test.ts`

Run: `npm run test -w @htmlppt/cli`

Run: `npm run typecheck -w @htmlppt/cli -w @htmlppt/mcp`

- [ ] **Step 4: Commit**

```bash
git add packages/cli/src/index.ts packages/mcp/src/host-session.ts \
  packages/mcp/test/deck-service.test.ts
git commit -m "feat(cli): canonicalize deck paths and move the session entry"
```

---

### Task 4: Editor path input, picker, and open flow

**Files:**
- Modify: `packages/editor/src/api.ts`
- Create: `packages/editor/src/file-picker.ts`
- Create: `packages/editor/src/components/PathInput.tsx`
- Modify: `packages/editor/src/components/Toolbar.tsx`
- Modify: `packages/editor/src/components/StandaloneLauncher.tsx`
- Modify: `packages/editor/src/App.tsx`
- Create: `e2e/open.spec.ts`

**Interfaces:**
- `openDeck(path: string): Promise<OpenDeckResponse>` where `OpenDeckResponse = DeckResponse & { url: string }`.
- `DeckOpenError` carries `status` and `code`.
- `pickHtmlFile(): Promise<{ file: File; handle: FileSystemFileHandle | null } | null>`.
- `PathInput` props:

```ts
interface PathInputProps {
  value: string;
  editable: boolean;
  opening: boolean;
  error: string | null;
  onOpen: (value: string) => void;
  onPick: () => void;
}
```

- [ ] **Step 1: Add the API and unit test**

In `packages/editor/src/api.ts`:

```ts
export interface OpenDeckResponse extends DeckResponse {
  url: string;
}

export class DeckOpenError extends Error {
  readonly status: number;
  readonly code: string;
  readonly url?: string;

  constructor(status: number, code: string, message: string, url?: string) {
    super(message);
    this.name = 'DeckOpenError';
    this.status = status;
    this.code = code;
    this.url = url;
  }
}

export async function openDeck(path: string): Promise<OpenDeckResponse> {
  const response = await fetch('/api/open', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ path })
  });
  if (!response.ok) {
    const { detail, payload } = await readErrorPayload(response);
    const body =
      payload !== null && typeof payload === 'object'
        ? (payload as { error?: unknown; message?: unknown; url?: unknown })
        : {};
    throw new DeckOpenError(
      response.status,
      typeof body.error === 'string' ? body.error : 'open-failed',
      typeof body.message === 'string' ? body.message : detail,
      typeof body.url === 'string' ? body.url : undefined
    );
  }
  return (await response.json()) as OpenDeckResponse;
}
```

Add to `api.test.ts`:

```ts
it('opens a deck path and surfaces its error code', async () => {
  const fetchMock = vi
    .fn()
    .mockResolvedValueOnce(
      jsonResponse({
        html: '<main data-ppt-deck></main>',
        revision: 'r1',
        filePath: 'D:/decks/next.html',
        url: '/d/next.html'
      })
    )
    .mockResolvedValueOnce(
      new Response(
        JSON.stringify({ error: 'not-found', message: 'Could not read it.' }),
        { status: 404, headers: { 'content-type': 'application/json' } }
      )
    );
  vi.stubGlobal('fetch', fetchMock);

  await expect(openDeck('next.html')).resolves.toMatchObject({
    url: '/d/next.html'
  });
  await expect(openDeck('missing.html')).rejects.toMatchObject({
    name: 'DeckOpenError',
    status: 404,
    code: 'not-found'
  });
  const call = fetchMock.mock.calls[0] as [string, RequestInit];
  expect(call[0]).toBe('/api/open');
  expect(call[1].body).toBe(JSON.stringify({ path: 'next.html' }));
});
```

- [ ] **Step 2: Extract the picker**

Create `packages/editor/src/file-picker.ts` by moving the `chooseFile` logic out of `StandaloneLauncher`:

```ts
export interface PickedHtmlFile {
  file: File;
  handle: FileSystemFileHandle | null;
}

type PickerWindow = Window & {
  showOpenFilePicker?: (options?: {
    multiple?: boolean;
    types?: Array<{
      description?: string;
      accept: Record<string, string[]>;
    }>;
  }) => Promise<FileSystemFileHandle[]>;
};

const PICKER_TYPES = [
  {
    description: 'HTML deck',
    accept: { 'text/html': ['.html', '.htm'] }
  }
];

export async function pickHtmlFile(): Promise<PickedHtmlFile | null> {
  const picker = (window as PickerWindow).showOpenFilePicker;
  if (typeof picker === 'function') {
    try {
      const [handle] = await picker({ multiple: false, types: PICKER_TYPES });
      if (!handle) return null;
      return { file: await handle.getFile(), handle };
    } catch (error) {
      if ((error as DOMException).name === 'AbortError') return null;
      throw error;
    }
  }

  return new Promise((resolve, reject) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.html,.htm,text/html';
    input.style.display = 'none';
    input.dataset.testid = 'file-picker-input';
    const cleanup = (): void => input.remove();
    input.addEventListener('change', () => {
      const file = input.files?.[0] ?? null;
      cleanup();
      resolve(file ? { file, handle: null } : null);
    });
    input.addEventListener('cancel', () => {
      cleanup();
      resolve(null);
    });
    document.body.append(input);
    input.click();
  });
}
```

Change `StandaloneLauncher` to call `pickHtmlFile()` and keep its existing error handling; remove its private `chooseFile`, hidden input, and picker typing. Run the standalone spec after the change.

- [ ] **Step 3: Add `PathInput`**

Create `packages/editor/src/components/PathInput.tsx`:

```tsx
import { useEffect, useRef, useState } from 'react';

export interface PathInputProps {
  value: string;
  editable: boolean;
  opening: boolean;
  error: string | null;
  onOpen: (value: string) => void;
  onPick: () => void;
}

export function PathInput({
  value,
  editable,
  opening,
  error,
  onOpen,
  onPick
}: PathInputProps) {
  const [draft, setDraft] = useState(value);
  const submittingRef = useRef(false);

  useEffect(() => {
    setDraft(value);
  }, [value]);

  const submit = (): void => {
    if (!editable || opening || submittingRef.current) return;
    const next = draft.trim();
    if (!next || next === value) return;
    submittingRef.current = true;
    onOpen(next);
    queueMicrotask(() => {
      submittingRef.current = false;
    });
  };

  return (
    <div className="flex min-w-0 items-center gap-1">
      <input
        data-testid="deck-path"
        aria-label="簡報路徑"
        aria-invalid={error ? true : undefined}
        aria-describedby={error ? 'deck-path-error' : undefined}
        className="w-64 truncate rounded border border-white/40 bg-black/30 px-2 py-1 text-xs text-zinc-100 outline-none focus:border-amber-400/70"
        value={draft}
        readOnly={!editable}
        disabled={opening}
        onChange={(event) => setDraft(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === 'Enter') {
            event.preventDefault();
            submit();
          } else if (event.key === 'Escape') {
            setDraft(value);
            event.currentTarget.blur();
          }
        }}
        onBlur={submit}
      />
      <button
        type="button"
        data-testid="deck-picker"
        className="rounded border border-white/40 px-2 py-1 text-xs text-zinc-300 hover:border-white/60"
        title="開啟另一個 HTML 檔"
        aria-label="開啟另一個 HTML 檔"
        disabled={opening}
        onPointerDown={(event) => event.preventDefault()}
        onClick={onPick}
      >
        開啟…
      </button>
      {error && (
        <span
          id="deck-path-error"
          role="alert"
          className="max-w-64 truncate text-xs text-red-300"
          title={error}
        >
          {error}
        </span>
      )}
    </div>
  );
}
```

`onPointerDown` prevents the input blur from submitting a draft when the user clicks the folder button.

- [ ] **Step 4: Wire the toolbar**

In `Toolbar.tsx`, replace the path `<span>` with `<PathInput ... />`. Add props:

```ts
  pathEditable: boolean;
  openingDeck: boolean;
  openDeckError: string | null;
  onOpenDeck: (path: string) => void;
  onPickDeck: () => void;
```

Pass them from `App.tsx` at the toolbar render. Keep the file-name display in standalone mode by passing `editable={false}`.

- [ ] **Step 5: Add the App open flow**

Add `openDeckAtPath` and `pickDeck` **after** `openStandaloneFile` is defined, so the useCallback dependency is initialized. In `App.tsx`:

```ts
  const [openingDeck, setOpeningDeck] = useState(false);
  const [openDeckError, setOpenDeckError] = useState<string | null>(null);

  const openDeckAtPath = useCallback(
    async (input: string): Promise<void> => {
      if (mode !== 'host' || openingDeck) return;
      setOpenDeckError(null);
      if (!actions.settlePendingEdits()) return;
      setOpeningDeck(true);
      try {
        await actions.saveNow();
        if (stateRef.current.conflict || stateRef.current.error) return;
        const opened = await openDeck(input);
        await actions.load(opened);
        window.history.replaceState(null, '', opened.url);
      } catch (cause) {
        setOpenDeckError(
          cause instanceof DeckOpenError
            ? openErrorMessage(cause)
            : cause instanceof Error
              ? cause.message
              : String(cause)
        );
      } finally {
        setOpeningDeck(false);
      }
    },
    [mode, openingDeck, actions]
  );

  const pickDeck = useCallback(async (): Promise<void> => {
    if (openingDeck) return;
    try {
      const picked = await pickHtmlFile();
      if (!picked) return;
      if (!actions.settlePendingEdits()) return;
      await actions.saveNow();
      if (stateRef.current.conflict || stateRef.current.error) return;
      await openStandaloneFile(picked.file, picked.handle);
    } catch (cause) {
      setOpenDeckError(
        cause instanceof Error ? cause.message : String(cause)
      );
    }
  }, [openingDeck, actions, openStandaloneFile]);
```

Add the error mapper near the component:

```ts
function openErrorMessage(error: DeckOpenError): string {
  switch (error.code) {
    case 'invalid-path':
      return '路徑無效；請輸入 HTML 檔案路徑。';
    case 'not-found':
      return '找不到檔案。';
    case 'unsupported-extension':
      return '只支援 .html 或 .htm 檔案。';
    case 'invalid-deck':
      return '這個檔案不是有效的簡報。';
    case 'deck-already-open':
      return error.url
        ? `已在另一個 host 開啟：${error.url}`
        : '此簡報已在另一個 host 開啟。';
    default:
      return error.message || '開啟失敗。';
  }
}
```

Use the 409 `url` if present: extend `DeckOpenError` with `url?: string` and show `已在另一個 host 開啟：${url}`. Do not auto-navigate.

- [ ] **Step 6: Keep the URL in sync for rebinds**

Add an effect so other tabs update their address after a broadcast rebind:

```ts
  useEffect(() => {
    if (mode !== 'host' || !filePath || !window.location.pathname.startsWith('/d/')) {
      return;
    }
    const name = filePath.split(/[\\/]/).pop() ?? '';
    if (!name) return;
    const next = `/d/${encodeURIComponent(name)}`;
    if (window.location.pathname !== next) {
      window.history.replaceState(null, '', next);
    }
  }, [mode, filePath]);
```

- [ ] **Step 7: Add the open E2E**

Create `e2e/open.spec.ts` with a host started by `startCliHost` and a second deck created by `node packages/cli/dist/bin.js new second.html --slides 1` in the same directory. Cover:

```ts
test('opens another deck from the path input and saves into it', async ({ page }) => {
  // start first host, create second deck, then replace its <h1> with "Second deck"
  await page.goto(host.url);
  await expect(page.getByTestId('deck-path')).toHaveValue(/first\.html$/);
  await page.getByTestId('deck-path').fill(secondPath);
  await page.getByTestId('deck-path').press('Enter');
  await expect(
    page.frameLocator('iframe[title="投影片預覽"]').locator('h1')
  ).toContainText('Second deck');
  expect(new URL(page.url()).pathname).toBe('/d/second.html');
  // edit the heading, wait for 已儲存, then read second.html and assert the edit
  // read first.html and assert it did not change
});

test('accepts a file URL and keeps the current deck on failure', async ({ page }) => {
  await page.goto(host.url);
  await page.getByTestId('deck-path').fill(pathToFileURL(secondPath).href);
  await page.getByTestId('deck-path').press('Enter');
  await expect(
    page.frameLocator('iframe[title="投影片預覽"]').locator('h1')
  ).toContainText('Second deck');
  await page.getByTestId('deck-path').fill(join(directory, 'missing.html'));
  await page.getByTestId('deck-path').press('Enter');
  await expect(page.locator('#deck-path-error')).toContainText('找不到檔案');
  expect(new URL(page.url()).pathname).toBe('/d/second.html');
});
```

Add a registry E2E:

```ts
test('moves the CLI registry so open and stop find the new deck', async () => {
  // start host, POST /api/open with the session token, then run
  // `htmlppt open second.html` and assert it reuses the same port
  // (no new HTMLPPT_URL with a different port), then `htmlppt stop second.html`.
});
```

Use `host.url`'s token for the POST, and assert the old path's session file no longer exists after the move.

- [ ] **Step 8: Run focused tests**

Run:

```bash
npm run build
npx playwright test e2e/open.spec.ts --reporter=line
npx playwright test e2e/standalone.spec.ts --reporter=line
npx playwright test e2e/editor.spec.ts -g "toolbar|save" --reporter=line
```

- [ ] **Step 9: Commit**

```bash
git add packages/editor/src/api.ts packages/editor/src/api.test.ts \
  packages/editor/src/file-picker.ts packages/editor/src/components/PathInput.tsx \
  packages/editor/src/components/Toolbar.tsx \
  packages/editor/src/components/StandaloneLauncher.tsx \
  packages/editor/src/App.tsx e2e/open.spec.ts
git commit -m "feat(editor): open another deck from the toolbar"
```

---

### Task 5: Documentation and phase gate

**Files:**
- Modify: `README.md`
- Modify: `docs/architecture.md`

- [ ] **Step 1: Document usage**

Add to the `open` section of `README.md`:

```md
Inside the editor, type an absolute path or `file://` URL into the path field and
press Enter to switch this host to another HTML deck. A successful switch keeps
the host, its token, and its session; the address bar becomes
`/d/<new-deck-name>` and saves go to the new file. Use the folder button to pick
a file through the standalone editor instead, which writes through the File
System Access handle.
```

Add to `docs/architecture.md`:

```md
- **Open:** `POST /api/open { path }` normalizes quotes, `file://`, `~`, and
  relative paths, validates the target deck, rejects a target already served by
  another live host with `409`, and rebinds the watcher, revision, and SSE state
  inside the save lock. The CLI callback moves the session registry entry.
```

- [ ] **Step 2: Run the full gate**

Run: `npm run verify`

Expected: all gates pass.

- [ ] **Step 3: Commit, push, and watch CI**

```bash
git add README.md docs/architecture.md
git commit -m "docs: describe opening another deck from the editor"
git push origin main
gh run list --limit 1 --json databaseId,headSha,status --jq '.[0]'
```

Watch the run for the pushed HEAD. Do not start Phase 3 until every job is green.

---

## Phase Exit Criteria

- `POST /api/open` handles file URLs, quotes, `~`, relative paths, extension and deck validation, 409 for another live host, and leaves state untouched on failure.
- The watcher, revision, history, health/deck APIs, export root, and SSE all follow the new deck.
- The CLI registry entry moves and shutdown removes the current entry.
- The toolbar path opens a deck; the picker switches to standalone; pending edits are saved first; failures show inline.
- The URL becomes `/d/<new-name>` in the initiating tab and other tabs after a broadcast rebind.
- `npm run verify` and the hosted matrix are green.
