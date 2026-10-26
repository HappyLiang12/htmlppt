# Auto-login Phase 1: Deck Credential Store Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Keep a deck's port and capability token stable across restarts so a reopened `/d/<name>` URL authenticates without a CLI round-trip, while `stop` still rotates the token.

**Architecture:** A new credential store under `~/.htmlppt/decks/` records `{ token, port }` per deck, keyed with the existing `sessionKey`. `open` reads it to pick the port and token and writes it back after binding; `stop` rotates the token and keeps the port. The session cookie gains a 30-day sliding `Max-Age` on document navigations only.

**Tech Stack:** TypeScript, Hono on `@hono/node-server`, Commander, Vitest.

**Spec:** `docs/superpowers/specs/2026-10-25-local-auto-login-design.md` (Goals, Decisions, Behavior sections)

## Global Constraints

- Do not remove the token, add `--no-auth`, or bind beyond `127.0.0.1`.
- Keep `Authorization: Bearer <token>` and the SSE query token unchanged.
- One deck per host process stays.
- `HTMLPPT_HOME` overrides the base directory for both the session registry and the new credential store.
- Registry keys keep the caller's path spelling; identity comparisons use `sameDeckPath`/`canonicalDeckPath`.
- Cookie attributes stay `HttpOnly; SameSite=Strict; Path=/` plus the new `Max-Age`.
- No new dependencies. CLI output stays English.
- Every task follows RED, GREEN, commit. Never weaken an existing assertion.
- Work on a feature branch; never commit or push on `main`. Push and PR need explicit authorization per round.

---

## File Structure

- Create `packages/host/src/credentials.ts`: credential shape, directory, read/write/rotate.
- Modify `packages/host/src/index.ts`: export the credential API.
- Create `packages/host/test/credentials.test.ts`: store contract.
- Modify `packages/cli/src/index.ts`: `open` uses the credential; `stop` rotates it.
- Modify `packages/cli/test/cli.test.ts`: sticky port/token and rotation.
- Modify `packages/host/src/server.ts`: cookie `Max-Age` and renewal.
- Modify `packages/host/test/server.test.ts`: cookie expectations.

---

### Task 1: Credential store module

**Files:**
- Create: `packages/host/src/credentials.ts`
- Modify: `packages/host/src/index.ts`
- Test: `packages/host/test/credentials.test.ts`

**Interfaces:**
- Consumes: `sessionKey` from `./sessions.js`.
- Produces: `DeckCredential`, `credentialsDirectory()`, `credentialFile(filePath: string): string`, `readCredential(filePath: string): Promise<DeckCredential | null>`, `writeCredential(filePath: string, credential: DeckCredential): Promise<void>`, `rotateCredential(filePath: string, port: number, token?: string): Promise<DeckCredential>`.

- [ ] **Step 1: Write the failing tests**

Create `packages/host/test/credentials.test.ts`:

```ts
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  credentialFile,
  credentialsDirectory,
  readCredential,
  rotateCredential,
  writeCredential
} from '../src/credentials.js';
import { sessionKey } from '../src/sessions.js';

describe('credentials', () => {
  let home: string;
  let previousHome: string | undefined;

  beforeEach(async () => {
    previousHome = process.env.HTMLPPT_HOME;
    home = await mkdtemp(path.join(tmpdir(), 'htmlppt-cred-'));
    process.env.HTMLPPT_HOME = home;
  });

  afterEach(async () => {
    if (previousHome === undefined) delete process.env.HTMLPPT_HOME;
    else process.env.HTMLPPT_HOME = previousHome;
    await rm(home, { recursive: true, force: true });
  });

  it('stores and reads a credential under the session key', async () => {
    const deck = path.join(home, 'deck.html');
    const credential = {
      token: 'token-1',
      port: 41234,
      createdAt: '2026-10-25T00:00:00.000Z',
      updatedAt: '2026-10-25T00:00:00.000Z'
    };

    await writeCredential(deck, credential);

    expect(credentialsDirectory()).toBe(path.join(home, 'decks'));
    expect(credentialFile(deck)).toBe(
      path.join(home, 'decks', `${sessionKey(deck)}.json`)
    );
    expect(await readCredential(deck)).toEqual(credential);
    expect(await readFile(credentialFile(deck), 'utf8')).toContain('token-1');
  });

  it('returns null for a missing or malformed file', async () => {
    const deck = path.join(home, 'missing.html');
    expect(await readCredential(deck)).toBeNull();

    const broken = path.join(home, 'broken.html');
    await writeCredential(broken, {
      token: 't',
      port: 1000,
      createdAt: '2026-10-25T00:00:00.000Z',
      updatedAt: '2026-10-25T00:00:00.000Z'
    });
    await writeFile(credentialFile(broken), '{"token":""}');

    expect(await readCredential(broken)).toBeNull();
  });

  it('rotates the token and keeps the port and createdAt', async () => {
    const deck = path.join(home, 'deck.html');
    await writeCredential(deck, {
      token: 'old',
      port: 43210,
      createdAt: '2026-10-01T00:00:00.000Z',
      updatedAt: '2026-10-01T00:00:00.000Z'
    });

    const rotated = await rotateCredential(deck, 43210, 'new-token');

    expect(rotated.token).toBe('new-token');
    expect(rotated.port).toBe(43210);
    expect(rotated.createdAt).toBe('2026-10-01T00:00:00.000Z');
    expect(rotated.updatedAt).not.toBe('2026-10-01T00:00:00.000Z');
    expect(await readCredential(deck)).toEqual(rotated);
  });

  it('mints a token when rotating a deck without a credential', async () => {
    const deck = path.join(home, 'fresh.html');

    const rotated = await rotateCredential(deck, 42000);

    expect(rotated.token).toMatch(/^[0-9a-f-]{36}$/);
    expect(rotated.port).toBe(42000);
  });
});
```

- [ ] **Step 2: Run the tests to confirm RED**

Run: `npm run test -w @htmlppt/host -- credentials.test.ts`

Expected: FAIL because `../src/credentials.js` does not exist.

- [ ] **Step 3: Implement the store**

Create `packages/host/src/credentials.ts`:

```ts
import { randomUUID } from 'node:crypto';
import { chmod, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { sessionKey } from './sessions.js';

export interface DeckCredential {
  token: string;
  port: number;
  createdAt: string;
  updatedAt: string;
}

export function credentialsDirectory(): string {
  const override = process.env.HTMLPPT_HOME;
  const base =
    override && override.length > 0
      ? path.resolve(override)
      : path.join(homedir(), '.htmlppt');
  return path.join(base, 'decks');
}

export function credentialFile(filePath: string): string {
  return path.join(credentialsDirectory(), `${sessionKey(filePath)}.json`);
}

export async function readCredential(
  filePath: string
): Promise<DeckCredential | null> {
  let raw: string;
  try {
    raw = await readFile(credentialFile(filePath), 'utf8');
  } catch {
    return null;
  }
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }
  return isDeckCredential(value) ? value : null;
}

export async function writeCredential(
  filePath: string,
  credential: DeckCredential
): Promise<void> {
  const directory = credentialsDirectory();
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await chmod(directory, 0o700).catch(() => undefined);
  const target = credentialFile(filePath);
  const temporary = `${target}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, `${JSON.stringify(credential, null, 2)}\n`, {
      encoding: 'utf8',
      mode: 0o600
    });
    await chmod(temporary, 0o600).catch(() => undefined);
    await rename(temporary, target);
  } finally {
    await rm(temporary, { force: true }).catch(() => undefined);
  }
  await chmod(target, 0o600).catch(() => undefined);
}

export async function rotateCredential(
  filePath: string,
  port: number,
  token: string = randomUUID()
): Promise<DeckCredential> {
  const existing = await readCredential(filePath);
  const now = new Date().toISOString();
  const next: DeckCredential = {
    token,
    port,
    createdAt: existing?.createdAt ?? now,
    updatedAt: now
  };
  await writeCredential(filePath, next);
  return next;
}

function isDeckCredential(value: unknown): value is DeckCredential {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return false;
  }
  const entry = value as Record<string, unknown>;
  return (
    typeof entry.token === 'string' &&
    entry.token.length > 0 &&
    typeof entry.port === 'number' &&
    Number.isInteger(entry.port) &&
    entry.port >= 1 &&
    entry.port <= 65535 &&
    typeof entry.createdAt === 'string' &&
    typeof entry.updatedAt === 'string'
  );
}
```

- [ ] **Step 4: Export from the host package**

In `packages/host/src/index.ts`, add:

```ts
export {
  credentialFile,
  credentialsDirectory,
  readCredential,
  rotateCredential,
  writeCredential
} from './credentials.js';
export type { DeckCredential } from './credentials.js';
```

- [ ] **Step 5: Run GREEN and typecheck**

Run: `npm run test -w @htmlppt/host -- credentials.test.ts`

Expected: 4 tests pass.

Run: `npm run typecheck -w @htmlppt/host`

Expected: exit 0.

- [ ] **Step 6: Commit**

```bash
git add packages/host/src/credentials.ts packages/host/src/index.ts \
  packages/host/test/credentials.test.ts
git commit -m "feat(host): add a per-deck credential store"
```

---

### Task 2: `open` reuses the deck's port and token

**Files:**
- Modify: `packages/cli/src/index.ts` (imports; the `open` action around lines 512-642)
- Test: `packages/cli/test/cli.test.ts`

**Interfaces:**
- Consumes: `readCredential`, `writeCredential` from `@htmlppt/host`.
- Produces: `open` binds `credential.port ?? 0` with `credential.token ?? randomUUID()`, persists the result, adopts a live session's values when no credential exists, and falls back to port `0` with a warning when the sticky port is taken.

- [ ] **Step 1: Write the failing CLI test**

Add to `packages/cli/test/cli.test.ts`, next to the existing `open` tests:

```ts
it('reuses the deck port and token across open calls', async () => {
  const workspace = await setupWorkspace();
  const first = await runCli(['open', 'deck.html', '--no-browser'], workspace);
  const firstUrl = new URL(
    first.stdout.split('\n').find((line) => line.startsWith('HTMLPPT_URL='))!
      .slice('HTMLPPT_URL='.length)
  );

  await runCli(['stop', 'deck.html'], workspace);

  const second = await runCli(['open', 'deck.html', '--no-browser'], workspace);
  const secondUrl = new URL(
    second.stdout.split('\n').find((line) => line.startsWith('HTMLPPT_URL='))!
      .slice('HTMLPPT_URL='.length)
  );

  expect(secondUrl.port).toBe(firstUrl.port);
  expect(secondUrl.searchParams.get('token')).toBe(
    firstUrl.searchParams.get('token')
  );
  await runCli(['stop', 'deck.html'], workspace);
});
```

If `setupWorkspace`/`runCli` are not the names used in that file, reuse the existing `open` helper in the same `describe` block; do not add a second harness.

- [ ] **Step 2: Run the test to confirm RED**

Run: `npm run test -w @htmlppt/cli -- cli.test.ts -t "reuses the deck port"`

Expected: FAIL because the second port and token differ.

- [ ] **Step 3: Implement the sticky start**

In `packages/cli/src/index.ts`:

1. Extend the `@htmlppt/host` import with `readCredential` and `writeCredential`.
2. In the `existing` reuse branch, adopt the values when no credential exists:

```ts
      if (existing) {
        const url = sessionUrl(existing);
        if ((await readCredential(filePath)) === null) {
          const now = new Date().toISOString();
          await writeCredential(filePath, {
            token: existing.token,
            port: existing.port,
            createdAt: now,
            updatedAt: now
          }).catch(() => undefined);
        }
        io.stdout(`HTMLPPT_URL=${url}`);
        if (options.browser) {
          await openBrowser(url, io);
        }
        return;
      }
```

3. Replace the existing `const token = randomUUID();` with the credential-aware identity:

```ts
      const credential = await readCredential(filePath);
      const token = credential?.token ?? randomUUID();
      const requestedPort = Number(options.port);
      const stickyPort =
        requestedPort !== 0 ? requestedPort : credential?.port ?? 0;
```

4. Replace the single `startHost` call with an attempt helper that falls back on `EADDRINUSE`:

```ts
      const start = (port: number) =>
        startHost({
          filePath,
          token,
          editorDir: directory,
          port,
          onDeckOpened: moveSession
        });
      let host: Awaited<ReturnType<typeof startHost>>;
      try {
        host = await start(stickyPort);
      } catch (error) {
        if (
          stickyPort !== 0 &&
          (error as NodeJS.ErrnoException).code === 'EADDRINUSE'
        ) {
          io.stderr(
            `Port ${stickyPort} is in use; starting ${file} on a new port. Existing bookmarks for this deck will stop working.`
          );
          host = await start(0);
        } else {
          throw error;
        }
      }
```

Keep the surrounding `try/catch` that formats host start errors; the fallback rethrow must still reach it.

5. After `HTMLPPT_URL` is printed, persist the binding:

```ts
      await writeCredential(filePath, {
        token,
        port: host.port,
        createdAt: credential?.createdAt ?? new Date().toISOString(),
        updatedAt: new Date().toISOString()
      }).catch((error: unknown) => {
        io.stderr(
          `Could not record the deck credential: ${error instanceof Error ? error.message : String(error)}. The editor still works; the next open will print a new URL.`
        );
      });
```

- [ ] **Step 4: Run GREEN**

Run: `npm run test -w @htmlppt/cli -- cli.test.ts -t "reuses the deck port"`

Expected: PASS.

Run: `npm run test -w @htmlppt/cli`

Expected: all CLI tests pass.

- [ ] **Step 5: Commit**

```bash
git add packages/cli/src/index.ts packages/cli/test/cli.test.ts
git commit -m "feat(cli): keep the deck port and token stable across opens"
```

---

### Task 3: `stop` rotates the token and keeps the port

**Files:**
- Modify: `packages/cli/src/index.ts` (`stopSession`, around lines 213-260)
- Test: `packages/cli/test/cli.test.ts`

**Interfaces:**
- Consumes: `rotateCredential` from `@htmlppt/host`.
- Produces: after a successful stop, the credential carries a new token and the same port.

- [ ] **Step 1: Write the failing test**

```ts
it('rotates the token on stop and keeps the port', async () => {
  const workspace = await setupWorkspace();
  const opened = await runCli(['open', 'deck.html', '--no-browser'], workspace);
  const url = new URL(
    opened.stdout.split('\n').find((line) => line.startsWith('HTMLPPT_URL='))!
      .slice('HTMLPPT_URL='.length)
  );

  await runCli(['stop', 'deck.html'], workspace);

  const { readCredential } = await import('@htmlppt/host');
  const credential = await readCredential(path.join(workspace.root, 'deck.html'));
  expect(credential?.port).toBe(Number(url.port));
  expect(credential?.token).not.toBe(url.searchParams.get('token'));
});
```

- [ ] **Step 2: Run RED**

Run: `npm run test -w @htmlppt/cli -- cli.test.ts -t "rotates the token"`

Expected: FAIL because the credential still holds the old token.

- [ ] **Step 3: Implement rotation**

In `packages/cli/src/index.ts`, inside `stopSession`, after the process is confirmed gone and before returning `true`, add:

```ts
  await rotateCredential(session.path, session.port).catch((error: unknown) => {
    io.stderr(
      `Stopped the editor, but could not rotate its credential: ${error instanceof Error ? error.message : String(error)}. The next open will mint a new token.`
    );
  });
```

Import `rotateCredential` from `@htmlppt/host` with the other host imports.

- [ ] **Step 4: Run GREEN**

Run: `npm run test -w @htmlppt/cli -- cli.test.ts -t "rotates the token"`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/cli/src/index.ts packages/cli/test/cli.test.ts
git commit -m "feat(cli): rotate the deck token when a session stops"
```

---

### Task 4: 30-day sliding cookie

**Files:**
- Modify: `packages/host/src/server.ts` (`tokenCookie`, `/` and `/d/:name` handlers)
- Test: `packages/host/test/server.test.ts`

**Interfaces:**
- Produces: `tokenCookie` adds `Max-Age=2592000`; `/` and `/d/:name` emit `Set-Cookie` on success; `/api/*` never does.

- [ ] **Step 1: Write the failing tests**

In `packages/host/test/server.test.ts`, extend the bootstrap test:

```ts
  expect(setCookie).toContain('Max-Age=2592000');
```

Add:

```ts
it('renews the cookie on document navigations only', async () => {
  const ctx = await setup();
  const cookie = await bootstrapCookie(ctx);

  const page = await fetch(`${ctx.base}/d/${encodeURIComponent(basename(ctx.deckPath))}`, {
    headers: { cookie },
    redirect: 'manual'
  });
  expect(page.status).toBe(200);
  expect(page.headers.get('set-cookie')).toContain('Max-Age=2592000');

  const api = await fetch(`${ctx.base}/api/deck`, { headers: { cookie } });
  expect(api.status).toBe(200);
  expect(api.headers.get('set-cookie')).toBeNull();
});
```

- [ ] **Step 2: Run RED**

Run: `npm run test -w @htmlppt/host -- server.test.ts -t "renews the cookie"`

Expected: FAIL because no `Set-Cookie` is emitted and `Max-Age` is absent.

- [ ] **Step 3: Implement**

Replace `tokenCookie`:

```ts
const COOKIE_MAX_AGE_SECONDS = 60 * 60 * 24 * 30;

function tokenCookie(token: string): string {
  return `${TOKEN_COOKIE}=${encodeURIComponent(token)}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${COOKIE_MAX_AGE_SECONDS}`;
}
```

In `app.get('/', ...)` and in the `app.get('/d/:name', ...)` success branch, set the header before responding:

```ts
    c.header('Set-Cookie', tokenCookie(options.token));
```

Do not add it to any `/api/*` route or to the static middleware.

- [ ] **Step 4: Run GREEN**

Run: `npm run test -w @htmlppt/host -- server.test.ts`

Expected: all host tests pass, including the existing cookie tests updated for `Max-Age`.

- [ ] **Step 5: Commit**

```bash
git add packages/host/src/server.ts packages/host/test/server.test.ts
git commit -m "feat(host): persist the session cookie for 30 days and renew it"
```

---

## Phase Exit Criteria

- A second `open` for the same deck reuses port and token; `stop` rotates the token and keeps the port.
- The cookie carries `Max-Age=2592000`, renews on `/` and `/d/:name`, and is absent from `/api/*` responses.
- `npm run verify` is green on the final HEAD, then the hosted CI matrix is green before Phase 2 starts.
