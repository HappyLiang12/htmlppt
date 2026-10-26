# Auto-login Phase 2: Verified Liveness and Stale Host Recovery Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `open` prove a registered host can still serve the editor, repair the dead-entry hijack that produced the 2026-10-24 500, and turn the 401 page into actionable copy.

**Architecture:** `checkHost` in the MCP session helper gains an authenticated editor-shell probe on top of the health probe. The direct-key lookup is extracted so `open` can see an `unhealthy` entry together with its snapshot instead of losing it to pruning, then stop that host through the same verified path `stop` uses. Document navigations that fail auth render a short HTML page naming the recovery command.

**Tech Stack:** TypeScript, Hono, Commander, Playwright, Vitest.

**Spec:** `docs/superpowers/specs/2026-10-25-local-auto-login-design.md` (Verified liveness, Unauthorized page, Migration sections)

## Global Constraints

- The token boundary is untouched: no anonymous path, no `--no-auth`.
- Never signal a pid without a registry snapshot that matches what was checked.
- A health timeout or 5xx stays `unknown` and must not stop anything.
- One deck per host process; `POST /api/open` already moves the registry entry.
- CLI output stays English. No new dependencies.
- RED first, then GREEN, then commit. Do not weaken existing assertions.
- Branch + PR only; no direct push to `main`. Push and PR need per-round authorization.

---

## File Structure

- Modify `packages/mcp/src/host-session.ts`: `probeSessionHealth`, `lookupRegisteredSession`, refactor `findLiveSession`, editor-shell probe.
- Modify `packages/mcp/src/index.ts`: export the new helpers.
- Create `packages/mcp/test/host-session.test.ts`: liveness matrix.
- Modify `packages/cli/src/index.ts`: `open` stops an unhealthy registered host; `stopSession` accepts a snapshot.
- Modify `packages/host/src/server.ts`: actionable 401 page for document navigations.
- Modify `packages/host/test/server.test.ts`: 401 copy.
- Create `e2e/auto-login.spec.ts`: bookmark survival across browser and host restarts.

---

### Task 1: Editor-shell liveness probe

**Files:**
- Modify: `packages/mcp/src/host-session.ts:147-187` (`checkHost`), `:45-111` (`findLiveSession`)
- Modify: `packages/mcp/src/index.ts`
- Test: `packages/mcp/test/host-session.test.ts`

**Interfaces:**
- Produces: `probeSessionHealth(entry: SessionEntry): Promise<'healthy' | 'unhealthy' | 'unknown'>`, `lookupRegisteredSession(filePath: string): Promise<{ entry: SessionEntry; snapshot: string; health: 'healthy' | 'unhealthy' | 'unknown' } | null>`; `findLiveSession` keeps its current signature and pruning behavior.

- [ ] **Step 1: Write the failing test**

Create `packages/mcp/test/host-session.test.ts` with a fake host that answers health but serves no editor:

```ts
import { createServer } from 'node:http';
import { describe, expect, it } from 'vitest';
import { probeSessionHealth } from '../src/host-session.js';
import type { SessionEntry } from '@htmlppt/host';

async function fakeHost(
  handler: (path: string) => { status: number; type: string; body: string }
): Promise<{ entry: SessionEntry; close: () => Promise<void> }> {
  const server = createServer((request, response) => {
    const result = handler(request.url ?? '/');
    response.writeHead(result.status, { 'content-type': result.type });
    response.end(result.body);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('no port');
  return {
    entry: {
      path: '/decks/demo.html',
      port: address.port,
      token: 'secret',
      pid: process.pid,
      startedAt: '2026-10-25T00:00:00.000Z',
      revision: 'a'.repeat(64)
    },
    close: () =>
      new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve()))
      )
  };
}

const healthOk = JSON.stringify({
  ok: true,
  revision: 'r',
  version: '0.0.0',
  filePath: '/decks/demo.html'
});

describe('probeSessionHealth', () => {
  it('is healthy only when the editor shell is served', async () => {
    const host = await fakeHost((path) =>
      path.startsWith('/api/health')
        ? { status: 200, type: 'application/json', body: healthOk }
        : { status: 200, type: 'text/html', body: '<div id="root"></div>' }
    );
    try {
      expect(await probeSessionHealth(host.entry)).toBe('healthy');
    } finally {
      await host.close();
    }
  });

  it('is unhealthy when health answers but the editor shell is gone', async () => {
    const host = await fakeHost((path) =>
      path.startsWith('/api/health')
        ? { status: 200, type: 'application/json', body: healthOk }
        : { status: 404, type: 'text/plain', body: 'Not Found' }
    );
    try {
      expect(await probeSessionHealth(host.entry)).toBe('unhealthy');
    } finally {
      await host.close();
    }
  });

  it('stays unknown when the shell responds with a server error', async () => {
    const host = await fakeHost((path) =>
      path.startsWith('/api/health')
        ? { status: 200, type: 'application/json', body: healthOk }
        : { status: 503, type: 'text/plain', body: 'busy' }
    );
    try {
      expect(await probeSessionHealth(host.entry)).toBe('unknown');
    } finally {
      await host.close();
    }
  });
});
```

- [ ] **Step 2: Run RED**

Run: `npm run test -w @htmlppt/mcp -- host-session.test.ts`

Expected: FAIL because `probeSessionHealth` is not exported.

- [ ] **Step 3: Implement the probe**

In `packages/mcp/src/host-session.ts`, rename `checkHost` to `probeSessionHealth` and export it. After the existing `payload.filePath` check, replace `return 'healthy';` with:

```ts
    const shell = await fetch(
      `http://127.0.0.1:${entry.port}/?token=${encodeURIComponent(entry.token)}`,
      { signal: AbortSignal.timeout(HEALTH_TIMEOUT_MS) }
    );
    if (!shell.ok) {
      await shell.body?.cancel().catch(() => undefined);
      return shell.status >= 500 ? 'unknown' : 'unhealthy';
    }
    if (!(shell.headers.get('content-type') ?? '').includes('text/html')) {
      await shell.body?.cancel().catch(() => undefined);
      return 'unhealthy';
    }
    const body = await shell.text();
    return body.includes('id="root"') ? 'healthy' : 'unhealthy';
```

Keep the existing timeout and abort semantics: an aborted shell fetch returns `unknown`.

Add the direct-key lookup and point `findLiveSession` at it:

```ts
export interface RegisteredSessionCheck {
  entry: SessionEntry;
  snapshot: string;
  health: HealthStatus;
}

export async function lookupRegisteredSession(
  filePath: string
): Promise<RegisteredSessionCheck | null> {
  const resolved = path.resolve(filePath);
  const canonical = await canonicalDeckPath(resolved);
  const sessionFile = sessionEntryFile(resolved);
  const direct = await readCheckedSession(sessionFile);
  if (!direct) return null;
  if (!(await sameDeckPath(direct.entry.path, canonical))) {
    await removeSessionIfUnchanged(sessionFile, direct.snapshot);
    return null;
  }
  return {
    entry: direct.entry,
    snapshot: direct.snapshot,
    health: await probeSessionHealth(direct.entry)
  };
}

function sessionEntryFile(resolvedPath: string): string {
  return path.join(sessionsDirectory(), `${sessionKey(resolvedPath)}.json`);
}
```

In `findLiveSession`, replace the direct block (`:57-72`) with:

```ts
  const direct = await lookupRegisteredSession(filePath);
  if (direct?.health === 'healthy') {
    return direct.entry;
  }
  if (direct?.health === 'unhealthy') {
    await removeSessionIfUnchanged(sessionEntryFile(resolved), direct.snapshot);
  }
```

Leave the alias scan unchanged except for using `probeSessionHealth` instead of `checkHost`.

- [ ] **Step 4: Export from the MCP package**

In `packages/mcp/src/index.ts`, add `lookupRegisteredSession`, `probeSessionHealth` to the existing `host-session` exports (and `RegisteredSessionCheck` to the type exports if that file re-exports types).

- [ ] **Step 5: Run GREEN**

Run: `npm run test -w @htmlppt/mcp -- host-session.test.ts`

Expected: 3 tests pass.

Run: `npm run test -w @htmlppt/mcp`

Expected: all MCP tests pass; the stricter probe must not break tool tests, which run against a real built host.

- [ ] **Step 6: Commit**

```bash
git add packages/mcp/src/host-session.ts packages/mcp/src/index.ts \
  packages/mcp/test/host-session.test.ts
git commit -m "fix(mcp): require the editor shell before trusting a session"
```

---

### Task 2: `open` replaces an unhealthy registered host

**Files:**
- Modify: `packages/cli/src/index.ts` (`stopSession` around `:213`; `open` around `:527-600`)
- Test: `packages/cli/test/cli.test.ts`

**Interfaces:**
- Consumes: `lookupRegisteredSession`, `probeSessionHealth` from `@htmlppt/mcp`.
- Produces: `stopSession(session, io, snapshot?)`; `open` stops a live-but-unhealthy host after one 150 ms retry, then starts a healthy host on the sticky port.

- [ ] **Step 1: Write the failing test**

```ts
it('replaces a registered host that no longer serves the editor', async () => {
  const workspace = await setupWorkspace();
  const first = await runCli(['open', 'deck.html', '--no-browser'], workspace);
  const firstUrl = new URL(
    first.stdout.split('\n').find((line) => line.startsWith('HTMLPPT_URL='))!
      .slice('HTMLPPT_URL='.length)
  );

  // Break the running host the way a moved repository does: remove the editor
  // shell it serves from disk.
  await rm(path.join(workspace.editorDir, 'index.html'));

  const second = await runCli(['open', 'deck.html', '--no-browser'], workspace);
  const secondUrl = new URL(
    second.stdout.split('\n').find((line) => line.startsWith('HTMLPPT_URL='))!
      .slice('HTMLPPT_URL='.length)
  );

  expect(secondUrl.port).toBe(firstUrl.port);
  const page = await fetch(`${secondUrl.origin}/d/deck.html`, {
    headers: { cookie: `htmlppt_token=${secondUrl.searchParams.get('token')}` }
  });
  expect(page.status).toBe(200);
  await runCli(['stop', 'deck.html'], workspace);
});
```

`workspace.editorDir` must already exist in the helper (the CLI test builds a fake editor dir to avoid needing the real build). If it is named differently, use the existing editor-directory field in that helper.

- [ ] **Step 2: Run RED**

Run: `npm run test -w @htmlppt/cli -- cli.test.ts -t "no longer serves the editor"`

Expected: FAIL because `open` accepts the broken host from the registry.

- [ ] **Step 3: Implement snapshot-aware stop**

Change `stopSession`'s signature and the snapshot read:

```ts
async function stopSession(
  session: SessionEntry,
  io: CliIO,
  snapshotOverride?: string
): Promise<boolean> {
```

When `snapshotOverride` is provided, use it and skip `readFile`; keep every other check, including the pid-shape guard before `process.kill`.

- [ ] **Step 4: Implement the recovery in `open`**

**Order matters:** capture `registered` before calling `findLiveSession`, because that call prunes unhealthy direct-key entries. Then place the recovery block after the `existing` reuse branch and before starting a host:

```ts
      const registered = await lookupRegisteredSession(filePath);
      const existing = await findLiveSession(filePath);
      if (existing) {
        // existing reuse branch, unchanged
      }
      if (registered?.health === 'unhealthy') {
        await new Promise((resolve) => setTimeout(resolve, 150));
        const retry = await probeSessionHealth(registered.entry);
        if (retry === 'unhealthy') {
          io.stderr(
            `The editor registered for ${file} is running but does not serve the editor (stale build). Stopping it and starting a fresh one.`
          );
          await stopSession(registered.entry, io, registered.snapshot);
        }
      }
```

Import `lookupRegisteredSession` and `probeSessionHealth` from `@htmlppt/mcp`.

- [ ] **Step 5: Run GREEN**

Run: `npm run test -w @htmlppt/cli -- cli.test.ts -t "no longer serves the editor"`

Expected: PASS.

Run: `npm run test -w @htmlppt/cli`

Expected: all CLI tests pass.

- [ ] **Step 6: Commit**

```bash
git add packages/cli/src/index.ts packages/cli/test/cli.test.ts
git commit -m "fix(cli): replace a stale editor host instead of reusing it"
```

---

### Task 3: Actionable unauthorized page

**Files:**
- Modify: `packages/host/src/server.ts` (page middleware 401 branch, around `:901-919`)
- Test: `packages/host/test/server.test.ts`

**Interfaces:**
- Produces: document navigations without valid auth return `401` with `text/html` copy naming the deck and the recovery command; `/api/*` keeps `{"error":"unauthorized"}`.

- [ ] **Step 1: Write the failing test**

```ts
it('explains how to recover from a missing session', async () => {
  const ctx = await setup();

  const page = await fetch(`${ctx.base}/d/${encodeURIComponent(basename(ctx.deckPath))}`);

  expect(page.status).toBe(401);
  expect(page.headers.get('content-type')).toContain('text/html');
  const body = await page.text();
  expect(body).toContain(basename(ctx.deckPath));
  expect(body).toContain(`htmlppt open`);
});
```

- [ ] **Step 2: Run RED**

Run: `npm run test -w @htmlppt/host -- server.test.ts -t "missing session"`

Expected: FAIL because the body is plain text.

- [ ] **Step 3: Implement**

Replace the 401 branch in the page middleware:

```ts
      const deckName = path.basename(options.filePath);
      return c.html(
        `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>htmlppt</title></head>` +
          `<body><main><h1>This browser has no session for ${escapeHtml(deckName)}</h1>` +
          `<p>The editor host is running, but this browser has no valid session cookie for it.</p>` +
          `<p>Run <code>htmlppt open &lt;deck&gt;</code> in a terminal and open the printed URL once; ` +
          `this browser is signed in for 30 days afterwards.</p></main></body></html>`,
        401
      );
```

Add a local `escapeHtml` helper (replace `&`, `<`, `>`, `"`). Do not import a sanitizer dependency.

- [ ] **Step 4: Run GREEN**

Run: `npm run test -w @htmlppt/host -- server.test.ts`

Expected: all host tests pass; update any assertion that expected the old plain-text body.

- [ ] **Step 5: Commit**

```bash
git add packages/host/src/server.ts packages/host/test/server.test.ts
git commit -m "fix(host): explain how to recover from a missing session"
```

---

### Task 4: Bookmark-survival E2E and docs

**Files:**
- Create: `e2e/auto-login.spec.ts`
- Modify: `README.md`, `SECURITY.md`, `docs/architecture.md`

**Interfaces:**
- Consumes: the shipped CLI (`packages/cli/dist/bin.js`) and a built editor.
- Produces: browser-level proof that a cookie survives a browser restart and a host restart.

- [ ] **Step 1: Write the E2E**

Create `e2e/auto-login.spec.ts`:

```ts
import { execa } from 'execa';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test } from '@playwright/test';

const repoRoot = fileURLToPath(new URL('..', import.meta.url));
const cli = path.join(repoRoot, 'packages/cli/dist/bin.js');

test('a bookmarked deck URL survives browser and host restarts', async ({ browser }) => {
  const dir = await mkdtemp(path.join(tmpdir(), 'htmlppt-login-'));
  const deck = path.join(dir, 'deck.html');
  await writeFile(
    deck,
    '<!doctype html><html><body><main data-ppt-deck><section data-slide-id="s1"><h1 data-ppt-el="e1">Deck</h1></section></main></body></html>'
  );
  const env = { ...process.env, HTMLPPT_HOME: path.join(dir, 'home') };
  const open = () =>
    execa('node', [cli, 'open', deck, '--no-browser'], { env });

  const first = open();
  const url = await new Promise<string>((resolve, reject) => {
    first.stdout?.on('data', (chunk: Buffer) => {
      const match = /HTMLPPT_URL=(\S+)/.exec(String(chunk));
      if (match?.[1]) resolve(match[1]);
    });
    first.on('error', reject);
  });

  const context = await browser.newContext();
  const page = await context.newPage();
  await page.goto(url);
  const friendly = `/d/${encodeURIComponent('deck.html')}`;
  await expect.poll(() => new URL(page.url()).pathname).toBe(friendly);
  const state = await context.storageState();
  await context.close();

  const restored = await browser.newContext({ storageState: state });
  const bookmarked = await restored.newPage();
  await bookmarked.goto(`${new URL(url).origin}${friendly}`);
  await expect(bookmarked.locator('#root')).toBeVisible();

  await execa('node', [cli, 'stop', deck], { env });
  first.kill();
  const reopened = open();
  const secondUrl = await new Promise<string>((resolve, reject) => {
    reopened.stdout?.on('data', (chunk: Buffer) => {
      const match = /HTMLPPT_URL=(\S+)/.exec(String(chunk));
      if (match?.[1]) resolve(match[1]);
    });
    reopened.on('error', reject);
  });

  expect(new URL(secondUrl).port).toBe(new URL(url).port);
  const again = await restored.newPage();
  await again.goto(`${new URL(url).origin}${friendly}`);
  await expect(again.locator('#root')).toBeVisible();

  await execa('node', [cli, 'stop', deck], { env });
  reopened.kill();
  const afterStop = await restored.newPage();
  const response = await afterStop.goto(`${new URL(url).origin}${friendly}`).catch(() => null);
  if (response) expect(response.status()).toBe(401);
  await restored.close();
  await rm(dir, { recursive: true, force: true });
});
```

- [ ] **Step 2: Run the E2E**

Run: `npm run build && npx playwright test e2e/auto-login.spec.ts --reporter=line`

Expected: PASS. If the build is already current, `npx playwright test e2e/auto-login.spec.ts --reporter=line` is enough.

- [ ] **Step 3: Update documentation**

- `README.md`: after the `HTMLPPT_URL` paragraph, state that the deck URL is bookmarkable while its host runs, that `stop` rotates the token, and that a 30-day sliding cookie keeps the browser signed in.
- `SECURITY.md`: document `~/.htmlppt/decks/<key>.json` (owner-only, holds `token` and `port`), rotation on `stop`, and that a reader of that file holds the deck capability until rotation.
- `docs/architecture.md`: add the credential store and the editor-shell liveness probe to the host/MCP description.

- [ ] **Step 4: Full gate**

Run: `npm run verify`

Expected: all suites pass.

- [ ] **Step 5: Commit, push the branch, open the PR**

```bash
git add e2e/auto-login.spec.ts README.md SECURITY.md docs/architecture.md
git commit -m "docs: describe the bookmarkable deck URL and credential rotation"
git push -u origin feat/auto-login-verified-liveness
gh pr create --title "feat: keep deck URLs signed in and recover stale hosts" --body-file pr-body.md
```

Write `pr-body.md` at the repository root with the summary and test plan, create the PR, then delete the file before any further commit; never commit it.

Wait for the hosted matrix on the newest run to be green before proposing a merge.

---

## Phase Exit Criteria

- `probeSessionHealth` requires the editor shell; a health-only host is unhealthy.
- `open` stops and replaces a stale host instead of printing its URL.
- The 401 page names the deck and the recovery command; `/api/*` JSON is unchanged.
- Bookmark survival passes in a real browser across browser and host restarts.
- `npm run verify` is green locally and the hosted matrix is green at the pushed HEAD.
