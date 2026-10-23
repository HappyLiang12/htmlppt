# Friendly URL and Cookie Auth Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the browser land on `/d/<deck-file-name>` instead of a tokenized URL, while keeping the existing token boundary and bearer/query compatibility for automation.

**Architecture:** The host keeps the per-process token. A tokenized page request sets the existing `htmlppt_token` HttpOnly cookie and redirects to a deck-named path. Page and `/api/*` requests accept that cookie, while bearer auth and the SSE query token keep working. The editor drops token plumbing and relies on the same-origin cookie.

**Tech Stack:** TypeScript, Hono on `@hono/node-server`, React 19, Vitest, Playwright.

**Spec:** `docs/superpowers/specs/2026-10-23-editor-open-url-i18n-design.md` (section 1 and the Phase 1 entry in Rollout)

## Global Constraints

- Do not remove the token or make the host reachable beyond `127.0.0.1`.
- Keep `Authorization: Bearer <token>` for CLI, MCP, and tests.
- Keep the SSE query token for `GET /api/events`; no other API route accepts a query token.
- Cookie attributes stay exactly `HttpOnly; SameSite=Strict; Path=/` with no `Max-Age`.
- Page paths handled by this phase: `/` and `/d/:name`. Static assets accept the cookie or a query token as today and are not redirected.
- Deck-name matching is case-insensitive on `win32` and case-sensitive elsewhere.
- No new dependencies. UI copy stays Traditional Chinese in this phase.
- Do not touch phases 2-4 (open endpoint, i18n, theming) before this phase has a green hosted CI run.
- Every task follows RED, GREEN, commit. Tests must assert concrete values; do not weaken existing assertions.

---

## File Structure

- Modify `packages/host/src/server.ts`: page routes, redirect helper, name matching, cookie auth for API.
- Modify `packages/host/test/server.test.ts`: host integration coverage and updated expectations.
- Modify `packages/editor/src/api.ts`: cookie-only host API, no token parameter.
- Modify `packages/editor/src/use-deck-controller.ts`: persistence without a token.
- Modify `packages/editor/src/App.tsx`: call sites and SSE gating by host mode.
- Create `packages/editor/src/api.test.ts`: no-header/no-token contract.
- Modify `e2e/editor.spec.ts`: harness friendly URL and strict URL assertion.
- Modify `e2e/security.spec.ts`: bootstrap redirect plus cookie-authenticated shell.
- Modify `README.md`, `SECURITY.md`, `docs/architecture.md`: URL and auth documentation.

---

### Task 1: Host page routes and bootstrap redirect

**Files:**
- Modify: `packages/host/src/server.ts:63-101` (helpers), `:661-694` (page middleware and routes)
- Test: `packages/host/test/server.test.ts:1-11` (imports), `:265-311` (helpers), `:344-409` (existing page tests), plus new tests in `describe('host', ...)`

**Interfaces:**
- Consumes: `options.token`, `options.filePath`, `options.editorDir`, `readCookie`, `TOKEN_COOKIE`.
- Produces: `friendlyDeckPath(filePath: string): string`, `matchesDeckName(name: string, filePath: string): boolean`, `tokenCookie(token: string): string`; routes `/` (302) and `/d/:name` (200/404).

- [ ] **Step 1: Add failing host tests**

In `packages/host/test/server.test.ts`, change the path import to `import { basename, join } from 'node:path';` and add this helper after `setup()`:

```ts
async function bootstrapCookie(ctx: Context): Promise<string> {
  const response = await fetch(ctx.host.url, { redirect: 'manual' });
  expect(response.status).toBe(302);
  const setCookie = response.headers.get('set-cookie') ?? '';
  return setCookie.split(';')[0] ?? '';
}
```

Replace the first test in `describe('host', ...)` with:

```ts
it('redirects the tokenized root and serves the deck', async () => {
  const ctx = await setup();
  const friendlyPath = `/d/${encodeURIComponent(basename(ctx.deckPath))}`;

  const page = await fetch(ctx.host.url, { redirect: 'manual' });
  expect(page.status).toBe(302);
  expect(page.headers.get('location')).toBe(friendlyPath);
  const setCookie = page.headers.get('set-cookie') ?? '';
  expect(setCookie).toContain(
    `htmlppt_token=${encodeURIComponent(ctx.token)}`
  );
  expect(setCookie.toLowerCase()).toContain('httponly');
  expect(setCookie).toContain('SameSite=Strict');
  expect(setCookie).toContain('Path=/');

  const friendly = await fetch(`${ctx.base}${friendlyPath}`, {
    headers: { cookie: setCookie.split(';')[0] ?? '' }
  });
  expect(friendly.status).toBe(200);
  expect(await friendly.text()).toContain('editor-shell');

  const response = await fetch(`${ctx.base}/api/deck`, {
    headers: { authorization: `Bearer ${ctx.token}` }
  });
  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({
    html: ctx.deckHtml,
    filePath: ctx.deckPath,
    revision: ctx.revision
  });
});
```

Replace the root assertion in `'serves the page and assets with the session cookie'` with:

```ts
const friendlyPath = `/d/${encodeURIComponent(basename(ctx.deckPath))}`;
const rootWithCookie = await fetch(`${ctx.base}/`, {
  headers: { cookie },
  redirect: 'manual'
});
expect(rootWithCookie.status).toBe(302);
expect(rootWithCookie.headers.get('location')).toBe(friendlyPath);

const withCookie = await fetch(`${ctx.base}${friendlyPath}`, {
  headers: { cookie }
});
expect(withCookie.status).toBe(200);
expect(await withCookie.text()).toContain('editor-shell');
```

Add these tests after `'serves the page and assets with the session cookie'`:

```ts
it('requires auth for the friendly deck route', async () => {
  const ctx = await setup();
  const path = `/d/${encodeURIComponent(basename(ctx.deckPath))}`;

  const response = await fetch(`${ctx.base}${path}`);

  expect(response.status).toBe(401);
});

it('returns 404 for a deck name that does not match', async () => {
  const ctx = await setup();
  const cookie = await bootstrapCookie(ctx);

  const response = await fetch(`${ctx.base}/d/other.html`, {
    headers: { cookie }
  });

  expect(response.status).toBe(404);
});

it('cleans the token query on a deck page', async () => {
  const ctx = await setup();
  const path = `/d/${encodeURIComponent(basename(ctx.deckPath))}`;

  const response = await fetch(
    `${ctx.base}${path}?token=${encodeURIComponent(ctx.token)}`,
    { redirect: 'manual' }
  );

  expect(response.status).toBe(302);
  expect(response.headers.get('location')).toBe(path);
  expect(response.headers.get('set-cookie')).toContain(
    `htmlppt_token=${encodeURIComponent(ctx.token)}`
  );
});

it('matches the deck name case-insensitively on Windows only', async () => {
  const ctx = await setup();
  const cookie = await bootstrapCookie(ctx);
  const name = basename(ctx.deckPath);
  const first = name[0] ?? '';
  const alternate =
    first === first.toUpperCase()
      ? `${first.toLowerCase()}${name.slice(1)}`
      : `${first.toUpperCase()}${name.slice(1)}`;

  const response = await fetch(
    `${ctx.base}/d/${encodeURIComponent(alternate)}`,
    { headers: { cookie } }
  );

  expect(response.status).toBe(process.platform === 'win32' ? 200 : 404);
});

it('rejects path separators in the deck name', async () => {
  const ctx = await setup();
  const cookie = await bootstrapCookie(ctx);

  const response = await fetch(
    `${ctx.base}/d/${encodeURIComponent('../basic.deck.html')}`,
    { headers: { cookie } }
  );

  expect(response.status).toBe(404);
});
```

- [ ] **Step 2: Run the tests and confirm RED**

Run: `npm run test -w @htmlppt/host -- server.test.ts`

Expected: the new redirect, friendly route, 404, cleanup, case, and separator tests fail; the current root test returns 200 instead of 302.

- [ ] **Step 3: Implement the helpers**

In `packages/host/src/server.ts`, after `readCookie`, add:

```ts
function tokenCookie(token: string): string {
  return `${TOKEN_COOKIE}=${encodeURIComponent(token)}; HttpOnly; SameSite=Strict; Path=/`;
}

function friendlyDeckPath(filePath: string): string {
  return `/d/${encodeURIComponent(path.basename(filePath))}`;
}

function matchesDeckName(name: string, filePath: string): boolean {
  if (!name || name === '.' || name === '..') {
    return false;
  }
  if (name.includes('/') || name.includes('\\')) {
    return false;
  }
  const expected = path.basename(filePath);
  return process.platform === 'win32'
    ? name.toLowerCase() === expected.toLowerCase()
    : name === expected;
}
```

- [ ] **Step 4: Replace the page middleware and routes**

Replace the block from `// The page, its assets...` through `app.use('/*', serveStatic(...))` with:

```ts
  async function renderEditor(): Promise<string> {
    return readFile(path.join(options.editorDir, 'index.html'), 'utf8');
  }

  // The printed bootstrap URL carries the token once. Document navigations
  // exchange it for the HttpOnly cookie and a readable deck URL; assets accept
  // either form so module and stylesheet subrequests stay authorized.
  app.use('*', async (c, next) => {
    const url = new URL(c.req.url);
    if (url.pathname.startsWith('/api/')) {
      await next();
      return;
    }
    const queryToken = url.searchParams.get('token');
    const cookieToken = readCookie(c.req.header('cookie'), TOKEN_COOKIE);
    if (queryToken !== options.token && cookieToken !== options.token) {
      return c.text(
        'Unauthorized. Open the tokenized URL printed by "htmlppt open".',
        401
      );
    }
    if (queryToken === options.token) {
      c.header('Set-Cookie', tokenCookie(options.token));
    }
    await next();
  });

  app.get('/', (c) => c.redirect(friendlyDeckPath(options.filePath), 302));

  app.get('/d/:name', async (c) => {
    const url = new URL(c.req.url);
    if (url.searchParams.has('token')) {
      return c.redirect(url.pathname, 302);
    }
    if (!matchesDeckName(c.req.param('name'), options.filePath)) {
      return c.notFound();
    }
    return c.html(await renderEditor());
  });

  app.get('/d', (c) => c.notFound());
  app.get('/d/*', (c) => c.notFound());
  app.use('/*', serveStatic({ root: options.editorDir }));
```

Delete the old `app.get('/', ...)` handler that returned `c.html(editorHtml)`. Keep `app.use('/*', serveStatic({ root: options.editorDir }))` last.

- [ ] **Step 5: Run the tests and confirm GREEN**

Run: `npm run test -w @htmlppt/host -- server.test.ts`

Expected: all host tests pass, including the unchanged API bearer/query tests and the new page tests.

- [ ] **Step 6: Typecheck and commit**

Run: `npm run typecheck -w @htmlppt/host`

Expected: exit 0.

```bash
git add packages/host/src/server.ts packages/host/test/server.test.ts
git commit -m "feat(host): redirect to deck-named editor URLs"
```

---

### Task 2: Cookie authentication for the API

**Files:**
- Modify: `packages/host/src/server.ts:322-345` (API auth middleware)
- Test: `packages/host/test/server.test.ts` (new tests after the API auth tests)

**Interfaces:**
- Consumes: `readCookie`, `TOKEN_COOKIE`, `options.token`.
- Produces: `/api/*` accepts bearer, the session cookie, or the events query token; the Origin check is unchanged.

- [ ] **Step 1: Add failing API cookie tests**

Add after `'accepts the bearer scheme case-insensitively'`:

```ts
it('accepts the session cookie for API reads and writes', async () => {
  const ctx = await setup();
  const cookie = await bootstrapCookie(ctx);

  const deck = await fetch(`${ctx.base}/api/deck`, {
    headers: { cookie }
  });
  expect(deck.status).toBe(200);
  expect(await deck.json()).toMatchObject({
    filePath: ctx.deckPath,
    revision: ctx.revision
  });

  const health = await fetch(`${ctx.base}/api/health`, {
    headers: { cookie }
  });
  expect(health.status).toBe(200);

  const save = await fetch(`${ctx.base}/api/deck`, {
    method: 'PUT',
    headers: { cookie, 'content-type': 'application/json' },
    body: JSON.stringify({
      html: ctx.deckHtml,
      baseRevision: ctx.revision
    })
  });
  expect(save.status).toBe(200);
});

it('rejects cookie authentication from a foreign origin', async () => {
  const ctx = await setup();
  const cookie = await bootstrapCookie(ctx);

  const response = await fetch(`${ctx.base}/api/deck`, {
    headers: { cookie, origin: 'http://evil.example' }
  });

  expect(response.status).toBe(403);
  expect(await response.json()).toEqual({ error: 'forbidden origin' });
});

it('accepts the session cookie for the event stream', async () => {
  const ctx = await setup();
  const cookie = await bootstrapCookie(ctx);

  const response = await fetch(`${ctx.base}/api/events`, {
    headers: { cookie }
  });
  expect(response.status).toBe(200);
  expect(response.headers.get('content-type')).toContain('text/event-stream');
  const reader = response.body?.getReader();
  if (!reader) {
    throw new Error('Expected an SSE response body.');
  }
  const first = await reader.read();
  expect(new TextDecoder().decode(first.value)).toContain('event: hello');
  await reader.cancel();
});
```

- [ ] **Step 2: Run the tests and confirm RED**

Run: `npm run test -w @htmlppt/host -- server.test.ts`

Expected: both new tests fail with 401, because the API middleware does not read the cookie.

- [ ] **Step 3: Implement cookie auth in the API middleware**

In the `/api/*` middleware, compute the cookie token and include it in the auth check:

```ts
    const cookieToken = readCookie(c.req.header('cookie'), TOKEN_COOKIE);
    if (
      bearer !== options.token &&
      queryToken !== options.token &&
      cookieToken !== options.token
    ) {
      return c.json({ error: 'unauthorized' }, 401);
    }
```

Leave the existing `allowsQueryToken` restriction and the Origin check untouched.

- [ ] **Step 4: Run the tests and confirm GREEN**

Run: `npm run test -w @htmlppt/host -- server.test.ts`

Expected: all host tests pass, including `'rejects the token when it is supplied as a query parameter'` and the SSE query-token test.

- [ ] **Step 5: Commit**

```bash
git add packages/host/src/server.ts packages/host/test/server.test.ts
git commit -m "feat(host): accept the session cookie for API requests"
```

---

### Task 3: Editor drops token plumbing

**Files:**
- Modify: `packages/editor/src/api.ts:42-53`, `:96-152`, `:154-237`
- Modify: `packages/editor/src/use-deck-controller.ts:1-14`, `:131-143`, `:222-225`
- Modify: `packages/editor/src/App.tsx:60-75`, `:411-432`, `:1330-1360`, `:1430-1443`
- Create: `packages/editor/src/api.test.ts`
- Test: `packages/editor/src/api.test.ts`

**Interfaces:**
- Consumes: the same-origin `htmlppt_token` cookie set by the host.
- Produces: `fetchDeck(): Promise<DeckResponse>`, `saveDeck(html, baseRevision, options?)`, `flushDeck(html, baseRevision)`, `hostPersistence(): DeckPersistence`, `exportDeck(format, outDir?)`, `deckEventsUrl(): string`, `openDeckEvents(onEvent)`; `DeckControllerOptions` no longer has `token`.

- [ ] **Step 1: Add the failing API unit test**

Create `packages/editor/src/api.test.ts`:

```ts
import { afterEach, describe, expect, it, vi } from 'vitest';
import { deckEventsUrl, fetchDeck, saveDeck } from './api';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' }
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('host API authentication', () => {
  it('loads the deck with the same-origin cookie only', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse({
        html: '<main data-ppt-deck></main>',
        revision: 'r1',
        filePath: 'deck.html'
      })
    );
    vi.stubGlobal('fetch', fetchMock);

    await fetchDeck();

    expect(fetchMock).toHaveBeenCalledWith('/api/deck');
  });

  it('saves without an authorization header', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse({ revision: 'r2' })
    );
    vi.stubGlobal('fetch', fetchMock);

    await saveDeck('<main data-ppt-deck></main>', 'r1');

    const call = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(call[0]).toBe('/api/deck');
    expect(call[1].method).toBe('PUT');
    expect(call[1].headers).toEqual({ 'content-type': 'application/json' });
    expect(call[1].credentials).toBeUndefined();
  });

  it('opens the event stream at the same-origin endpoint', () => {
    expect(deckEventsUrl()).toBe('/api/events');
  });
});
```

- [ ] **Step 2: Run the test and confirm RED**

Run: `npm run test -w @htmlppt/editor -- api.test.ts`

Expected: TypeScript or assertions fail because `fetchDeck`/`saveDeck` still require a token and `deckEventsUrl` requires one.

- [ ] **Step 3: Rewrite the host API helpers**

In `packages/editor/src/api.ts`, delete `tokenFromLocation` and replace the host helpers with:

```ts
export async function fetchDeck(): Promise<DeckResponse> {
  const response = await fetch('/api/deck');
  if (!response.ok) {
    throw new DeckAuthError(response.status);
  }
  return (await response.json()) as DeckResponse;
}

export async function saveDeck(
  html: string,
  baseRevision: string,
  options: SaveDeckOptions = {}
): Promise<{ revision: string }> {
  const response = await fetch('/api/deck', {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      html,
      baseRevision,
      ...(options.force ? { force: true } : {})
    })
  });
  if (!response.ok) {
    const { detail, payload } = await readErrorPayload(response);
    const conflict = conflictFromPayload(response.status, payload);
    if (conflict) throw conflict;
    throw new Error(`Save failed (${response.status}): ${detail}`);
  }
  return (await response.json()) as { revision: string };
}

export function flushDeck(html: string, baseRevision: string): void {
  void fetch('/api/deck', {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ html, baseRevision }),
    keepalive: true
  }).catch(() => undefined);
}

export function hostPersistence(): DeckPersistence {
  return {
    load: () => fetchDeck(),
    save: (html, baseRevision, options) =>
      saveDeck(html, baseRevision, options),
    flush: (html, baseRevision) => flushDeck(html, baseRevision)
  };
}

export async function exportDeck(
  format: ExportFormat,
  outDir?: string
): Promise<string[]> {
  const response = await fetch('/api/export', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      format,
      ...(outDir ? { outDir } : {})
    })
  });
  if (!response.ok) {
    const { detail, payload } = await readErrorPayload(response);
    const message =
      payload !== null &&
      typeof payload === 'object' &&
      typeof (payload as { message?: unknown }).message === 'string'
        ? (payload as { message: string }).message
        : detail || `Export failed (${response.status})`;
    throw new Error(message);
  }
  const body = (await response.json()) as { files?: unknown };
  if (!Array.isArray(body.files)) {
    throw new Error('Export response did not list files.');
  }
  return body.files.filter((file): file is string => typeof file === 'string');
}

export function deckEventsUrl(): string {
  return '/api/events';
}

export function openDeckEvents(
  onEvent: (event: DeckRevisionEvent) => void
): EventSource {
  const source = new EventSource(deckEventsUrl());
  const listen = (type: 'hello' | 'revision') => (event: Event) => {
    const message = event as MessageEvent<string>;
    const parsed = parseRevisionEvent(type, String(message.data));
    if (parsed) onEvent(parsed);
  };
  source.addEventListener('hello', listen('hello'));
  source.addEventListener('revision', listen('revision'));
  return source;
}
```

Keep `DeckResponse`, `DeckPersistence`, `DeckAuthError`, `DeckConflictError`, `conflictFromPayload`, `readErrorPayload`, and `parseRevisionEvent` unchanged.

- [ ] **Step 4: Update the controller**

In `packages/editor/src/use-deck-controller.ts`:

- Remove `tokenFromLocation` from the `./api` import.
- Delete `const tokenRef = useRef(options.token ?? tokenFromLocation());`.
- Change the persistence initializer to `useRef<DeckPersistence>(options.persistence ?? hostPersistence())`.
- Delete `token?: string;` and its doc line from `DeckControllerOptions`.

- [ ] **Step 5: Update App call sites**

In `packages/editor/src/App.tsx`:

- Remove `tokenFromLocation` from the `./api` import.
- Replace the persistence memo body with:

```ts
  const persistence = useMemo<DeckPersistence>(
    () => ({
      load: () => fetchDeck(),
      save: (html, baseRevision, options) =>
        standaloneRef.current
          ? standalonePersistence.save(html, baseRevision, options)
          : saveDeck(html, baseRevision, options),
      flush: (html, baseRevision) => {
        if (standaloneRef.current) {
          standalonePersistence.flush(html, baseRevision);
        } else {
          flushDeck(html, baseRevision);
        }
      }
    }),
    [standalonePersistence]
  );
```

- Change the export call to `await exportDeck(format);`.
- Change the mount call to `const deck = await fetchDeck();`.
- Replace the SSE effect with:

```ts
  useEffect(() => {
    if (liveEventsRef.current || !master || mode !== 'host') return;
    liveEventsRef.current = openDeckEvents((event) => {
      actionsRef.current.receiveRevision(event);
    });
  }, [master, mode]);
```

- [ ] **Step 6: Run unit tests and typecheck**

Run: `npm run test -w @htmlppt/editor -- api.test.ts`

Expected: 3 tests pass.

Run: `npm run typecheck -w @htmlppt/editor`

Expected: exit 0. If TypeScript reports unused imports or old signatures, fix every call site before proceeding.

- [ ] **Step 7: Update the editor E2E harness**

In `e2e/editor.spec.ts`:

- Add `friendlyPath: string;` to `EditorHarness`.
- In `openDeck`, after `await page.goto(host.url)`, add:

```ts
    const friendlyPath = `/d/${encodeURIComponent(file)}`;
    await expect.poll(() => new URL(page.url()).pathname).toBe(friendlyPath);
```

- Return `friendlyPath` from the harness object.
- At line ~3546, replace `expect(page.url()).toBe(editor.host.url);` with:

```ts
        expect(page.url()).toBe(new URL(editor.friendlyPath, editor.host.url).href);
```

- [ ] **Step 8: Run focused E2E**

Run: `npx playwright test e2e/editor.spec.ts -g "opens a deck|unload|beforeunload" --reporter=line`

Expected: pass. If the filter selects no tests, run `npx playwright test e2e/editor.spec.ts -g "toolbar" --reporter=line` to exercise the harness, then run the full editor spec before the phase gate.

- [ ] **Step 9: Commit**

```bash
git add packages/editor/src/api.ts packages/editor/src/api.test.ts \
  packages/editor/src/use-deck-controller.ts packages/editor/src/App.tsx \
  e2e/editor.spec.ts
git commit -m "feat(editor): authenticate through the host session cookie"
```

---

### Task 4: Security E2E, documentation, and phase gate

**Files:**
- Modify: `e2e/security.spec.ts:204-233` (rawGet cookie support), `:620-632` (shell expectation)
- Modify: `README.md:39-40`, `:185-187`
- Modify: `SECURITY.md:33-47`
- Modify: `docs/architecture.md:49-53`, `:81-89`

**Interfaces:**
- Consumes: the redirect and cookie behavior from Tasks 1-3.
- Produces: documented contract; a green full gate and hosted matrix for Phase 1.

- [ ] **Step 1: Update the security E2E helper and shell check**

Change `rawGet` to accept an optional cookie:

```ts
function rawGet(
  origin: string,
  rawPath: string,
  cookie?: string
): Promise<RawResponse> {
  const originUrl = new URL(origin);
  return new Promise((resolvePromise, reject) => {
    const request = httpRequest(
      {
        hostname: originUrl.hostname,
        port: originUrl.port,
        path: rawPath,
        method: 'GET',
        headers: cookie ? { cookie } : undefined,
        timeout: 10_000
      },
      (response) => {
        const chunks: Buffer[] = [];
        response.on('data', (chunk: Buffer) => chunks.push(chunk));
        response.on('end', () =>
          resolvePromise({
            status: response.statusCode ?? 0,
            headers: response.headers,
            body: Buffer.concat(chunks).toString('utf8')
          })
        );
      }
    );
    request.on('timeout', () =>
      request.destroy(new Error(`Raw request timed out: ${rawPath}`))
    );
    request.on('error', reject);
    request.end();
  });
}
```

Replace the shell check in the static-serving security test with:

```ts
      const shell = await rawGet(origin, `/${query}`);
      expect(shell.status).toBe(302);
      expect(shell.headers.location).toBe('/d/security.html');
      const cookie = shell.headers['set-cookie']?.[0]?.split(';')[0] ?? '';
      const pageShell = await rawGet(origin, '/d/security.html', cookie);
      expect(pageShell.status).toBe(200);
      expect(pageShell.body).toContain(editorMarker);
```

Keep the sibling and traversal probes as they are; they still use the query token on non-document paths.

- [ ] **Step 2: Run the focused security test and confirm GREEN**

Run: `npx playwright test e2e/security.spec.ts -g "editor page rejects|static" --reporter=line`

Expected: pass.

- [ ] **Step 3: Update documentation**

In `README.md`, after the `HTMLPPT_URL` sentence, add:

```md
The printed URL carries the session token once. The browser exchanges it for an
HttpOnly session cookie and lands on `http://127.0.0.1:<port>/d/<deck-file-name>`,
which is safe to keep in history for that session. CLI and MCP output still print
the tokenized bootstrap URL for automation.
```

In the security bullet, replace the API sentence with:

```md
- The editor host binds to `127.0.0.1` only and uses a random per-session token.
  The tokenized first visit sets an HttpOnly `SameSite=Strict` cookie; page and
  API requests accept that cookie, while CLI, MCP, and tests may continue to use
  `Authorization: Bearer`. When an `Origin` header is present it must be this
  host's loopback origin.
```

In `SECURITY.md`, replace the page/API bullets with:

```md
- Each run generates a random per-session token. The printed URL carries it as
  `?token=...`; treat that URL as a secret for the session.
- A tokenized request for `/` or `/d/<name>` sets an `HttpOnly`,
  `SameSite=Strict`, `Path=/` cookie and redirects to `/d/<name>`, so the address
  bar no longer contains the token. Static assets accept either the cookie or a
  query token.
- `/api/*` requests accept the cookie, or `Authorization: Bearer <token>` for
  CLI, MCP, and tests. The single query-string exception remains
  `GET /api/events`, where `EventSource` cannot set headers. Every API request
  that carries an `Origin` header must match this host's loopback origin.
```

In `docs/architecture.md`, replace the API bearer sentence with:

```md
  (`413 payload-too-large`). Page and API requests accept the HttpOnly session
  cookie set by the tokenized bootstrap redirect; bearer auth remains for CLI,
  MCP, and tests, and only `GET /api/events` may carry the token in the query
  string because `EventSource` cannot set headers.
```

Add the page routes to the Host section:

```md
- **Pages:** `GET /` redirects to `/d/<deck-name>`, setting the session cookie
  when the request carries a valid token. `GET /d/<deck-name>` serves the editor
  when the decoded basename matches the current deck (case-insensitive on
  Windows) and returns 404 otherwise.
```

- [ ] **Step 4: Run the full local gate**

Run: `npm run verify`

Expected: lint, dependency rules, typecheck, unit, integration, feature matrix, all E2E, and package smoke pass.

- [ ] **Step 5: Commit and push**

```bash
git add e2e/security.spec.ts README.md SECURITY.md docs/architecture.md
git commit -m "docs: describe the friendly URL and cookie session"
git push origin main
```

Expected: the push starts a hosted matrix run for the new HEAD.

- [ ] **Step 6: Gate on hosted CI**

Run: `gh run list --limit 1 --json databaseId,headSha,status --jq '.[0]'`

Confirm the newest run belongs to the pushed HEAD, then watch it:

```bash
gh run watch <run-id> --interval 30
```

Expected: every job succeeds. Do not start Phase 2 on a red or pending matrix. If a job fails, classify it (product, environment, path, flake, clean-install, generated drift), fix the batch locally, and push once.

---

## Phase Exit Criteria

- `/` and `/d/<name>` behave as specified, including 404 and name matching.
- Page, API, and SSE auth work through the cookie; bearer and SSE query tokens still work.
- The editor contains no `tokenFromLocation` references.
- `npm run verify` is green locally.
- The hosted matrix is green at the pushed HEAD.
