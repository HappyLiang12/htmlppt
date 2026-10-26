import { createHash, randomUUID } from 'node:crypto';
import {
  mkdir,
  readFile,
  realpath,
  rm,
  symlink,
  writeFile
} from 'node:fs/promises';
import { request as httpRequest } from 'node:http';
import { basename, join } from 'node:path';
import { copyFixture, makeTempDir } from '@htmlppt/test-utils';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  HOST_VERSION,
  isAllowedOrigin,
  startHost
} from '../src/server.js';
import { writeSession } from '../src/sessions.js';

interface Context {
  dir: string;
  deckPath: string;
  deckHtml: string;
  editorDir: string;
  token: string;
  host: Awaited<ReturnType<typeof startHost>>;
  base: string;
  revision: string;
}

interface SseEvent {
  event: string;
  data: unknown;
}

const TIMEOUT = Symbol('timeout');
const SSE_TIMEOUT_MS = 5_000;

class SseTimeoutError extends Error {}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

async function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number
): Promise<T | typeof TIMEOUT> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<typeof TIMEOUT>((resolve) => {
    timer = setTimeout(() => resolve(TIMEOUT), timeoutMs);
    timer.unref();
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    if (timer) {
      clearTimeout(timer);
    }
  }
}

/**
 * Incremental SSE client with a bounded wait for every read. It never sleeps
 * in a loop and it keeps at most one read in flight so a timed-out wait can
 * observe an event that arrives later.
 */
class EventStream {
  private readonly reader: ReadableStreamDefaultReader<Uint8Array>;
  private readonly decoder = new TextDecoder();
  private pendingRead:
    | Promise<ReadableStreamReadResult<Uint8Array>>
    | undefined;
  private buffer = '';
  private queue: SseEvent[] = [];
  private ended = false;

  constructor(reader: ReadableStreamDefaultReader<Uint8Array>) {
    this.reader = reader;
  }

  async next(timeoutMs = SSE_TIMEOUT_MS): Promise<SseEvent> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const queued = this.queue.shift();
      if (queued) {
        return queued;
      }
      if (this.ended) {
        throw new Error('The SSE stream ended before the expected event.');
      }
      const remaining = deadline - Date.now();
      if (remaining <= 0) {
        throw new SseTimeoutError(
          `Timed out after ${timeoutMs} ms waiting for an SSE event.`
        );
      }
      const result = await withTimeout(this.readOnce(), remaining);
      if (result === TIMEOUT) {
        throw new SseTimeoutError(
          `Timed out after ${timeoutMs} ms waiting for an SSE event.`
        );
      }
      this.pendingRead = undefined;
      if (result.done) {
        this.ended = true;
        continue;
      }
      this.buffer += this.decoder.decode(result.value, { stream: true });
      this.drain();
    }
  }

  async expectNoEvent(windowMs = 500): Promise<void> {
    try {
      const event = await this.next(windowMs);
      throw new Error(
        `Expected no SSE event, but received "${event.event}" with ${JSON.stringify(event.data)}.`
      );
    } catch (error) {
      if (!(error instanceof SseTimeoutError)) {
        throw error;
      }
    }
  }

  async outcome(
    timeoutMs = SSE_TIMEOUT_MS
  ): Promise<'ended' | 'data' | 'timeout'> {
    const result = await withTimeout(this.readOnce(), timeoutMs);
    if (result === TIMEOUT) {
      return 'timeout';
    }
    this.pendingRead = undefined;
    if (result.done) {
      this.ended = true;
      return 'ended';
    }
    this.buffer += this.decoder.decode(result.value, { stream: true });
    this.drain();
    return 'data';
  }

  async close(): Promise<void> {
    await this.reader.cancel().catch(() => undefined);
  }

  private readOnce(): Promise<ReadableStreamReadResult<Uint8Array>> {
    this.pendingRead ??= this.reader.read();
    return this.pendingRead;
  }

  private drain(): void {
    for (;;) {
      const boundary = this.buffer.indexOf('\n\n');
      if (boundary === -1) {
        return;
      }
      const block = this.buffer.slice(0, boundary);
      this.buffer = this.buffer.slice(boundary + 2);
      let eventName = 'message';
      const data: string[] = [];
      for (const rawLine of block.split('\n')) {
        const line = rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine;
        if (line.startsWith(':')) {
          continue;
        }
        const colon = line.indexOf(':');
        const field = colon === -1 ? line : line.slice(0, colon);
        const value =
          colon === -1 ? '' : line.slice(colon + 1).replace(/^ /, '');
        if (field === 'event') {
          eventName = value;
        } else if (field === 'data') {
          data.push(value);
        }
      }
      if (data.length === 0) {
        continue;
      }
      this.queue.push({
        event: eventName,
        data: JSON.parse(data.join('\n')) as unknown
      });
    }
  }
}

async function connectEvents(
  ctx: Context,
  init?: RequestInit
): Promise<EventStream> {
  const response = await fetch(
    `${ctx.base}/api/events?token=${encodeURIComponent(ctx.token)}`,
    init
  );
  expect(response.status).toBe(200);
  expect(response.headers.get('content-type')).toContain('text/event-stream');
  if (!response.body) {
    throw new Error('Expected an SSE response body.');
  }
  return new EventStream(response.body.getReader());
}

function putDeck(
  ctx: Context,
  html: string,
  options: {
    baseRevision?: string;
    force?: boolean;
    source?: 'editor' | 'mcp';
  } = {}
): Promise<Response> {
  const headers: Record<string, string> = {
    authorization: `Bearer ${ctx.token}`,
    'content-type': 'application/json'
  };
  if (options.source) {
    headers['x-htmlppt-source'] = options.source;
  }
  return fetch(`${ctx.base}/api/deck`, {
    method: 'PUT',
    headers,
    body: JSON.stringify({
      html,
      baseRevision: options.baseRevision,
      force: options.force
    })
  });
}

function countStatWatchers(): number {
  return process
    .getActiveResourcesInfo()
    .filter((resource) => resource === 'StatWatcher').length;
}

/**
 * Sends a request line verbatim. fetch() normalizes encoded dot segments
 * client-side, so traversal probes need the raw HTTP client.
 */
function rawGet(
  port: number,
  rawPath: string,
  cookie: string
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const request = httpRequest(
      {
        host: '127.0.0.1',
        port,
        path: rawPath,
        method: 'GET',
        headers: { cookie }
      },
      (response) => {
        const chunks: Buffer[] = [];
        response.on('data', (chunk: Buffer) => chunks.push(chunk));
        response.on('end', () =>
          resolve({
            status: response.statusCode ?? 0,
            body: Buffer.concat(chunks).toString('utf8')
          })
        );
      }
    );
    request.on('error', reject);
    request.end();
  });
}

let context: Context | undefined;

async function setup(
  options: { withEditorHtml?: boolean } = {}
): Promise<Context> {
  const dir = await makeTempDir('htmlppt-host-');
  let host: Awaited<ReturnType<typeof startHost>> | undefined;
  try {
    const editorDir = join(dir, 'editor');
    await mkdir(editorDir);
    if (options.withEditorHtml !== false) {
      await writeFile(
        join(editorDir, 'index.html'),
        '<!doctype html><title>Editor</title><div id="root">editor-shell</div>',
        'utf8'
      );
      await writeFile(
        join(editorDir, 'app.js'),
        'console.log("editor shell");',
        'utf8'
      );
    }
    const deckPath = await copyFixture('basic.deck.html', dir);
    const deckHtml = await readFile(deckPath, 'utf8');
    const token = randomUUID();
    host = await startHost({ filePath: deckPath, token, editorDir, port: 0 });
    const base = new URL(host.url).origin;
    const deckResponse = await fetch(`${base}/api/deck`, {
      headers: { authorization: `Bearer ${token}` }
    });
    if (!deckResponse.ok) {
      throw new Error(`Failed to read the deck: ${deckResponse.status}`);
    }
    const deck = (await deckResponse.json()) as { revision: string };
    context = {
      dir,
      deckPath,
      deckHtml,
      editorDir,
      token,
      host,
      base,
      revision: deck.revision
    };
    return context;
  } catch (error) {
    await host?.close();
    await rm(dir, { recursive: true, force: true });
    throw error;
  }
}

function expectedSessionCookie(token: string): string {
  return `htmlppt_token=${encodeURIComponent(token)}; HttpOnly; SameSite=Strict; Path=/; Max-Age=2592000`;
}

async function bootstrapCookie(ctx: Context): Promise<string> {
  const response = await fetch(ctx.host.url, { redirect: 'manual' });
  expect(response.status).toBe(302);
  const setCookies = response.headers.getSetCookie();
  expect(setCookies).toHaveLength(1);
  expect(setCookies[0]).toBe(expectedSessionCookie(ctx.token));
  return setCookies[0]?.split(';')[0] ?? '';
}

async function addDeck(
  ctx: Context,
  name: string,
  title: string
): Promise<string> {
  const source = ctx.deckHtml.replace(
    /<h1[^>]*>.*?<\/h1>/s,
    `<h1>${title}</h1>`
  );
  const target = join(ctx.dir, name);
  await writeFile(target, source, 'utf8');
  return target;
}

function openDeck(
  ctx: Context,
  cookie: string,
  target: string
): Promise<Response> {
  return fetch(`${ctx.base}/api/open`, {
    method: 'POST',
    headers: { cookie, 'content-type': 'application/json' },
    body: JSON.stringify({ path: target })
  });
}

afterEach(async () => {
  const ctx = context;
  context = undefined;
  if (!ctx) {
    return;
  }
  try {
    await ctx.host.close();
  } finally {
    await rm(ctx.dir, { recursive: true, force: true });
  }
});

describe('isAllowedOrigin', () => {
  it('normalizes default ports and accepts both loopback names', () => {
    expect(isAllowedOrigin('http://127.0.0.1', 80)).toBe(true);
    expect(isAllowedOrigin('http://localhost', 80)).toBe(true);
    expect(isAllowedOrigin('http://127.0.0.1:80', 80)).toBe(true);
    expect(isAllowedOrigin('http://127.0.0.1:8080', 8080)).toBe(true);
    expect(isAllowedOrigin('http://localhost:8080', 8080)).toBe(true);
  });

  it('rejects foreign, secured, malformed, and wrong-port origins', () => {
    expect(isAllowedOrigin('http://127.0.0.1:8080', 80)).toBe(false);
    expect(isAllowedOrigin('http://evil.example:80', 80)).toBe(false);
    expect(isAllowedOrigin('https://127.0.0.1:8080', 8080)).toBe(false);
    expect(isAllowedOrigin('http://127.0.0.1:8081', 8080)).toBe(false);
    expect(isAllowedOrigin('not a url', 8080)).toBe(false);
  });
});

describe('host', () => {
  it('redirects the tokenized root and serves the deck', async () => {
    const ctx = await setup();
    const friendlyPath = `/d/${encodeURIComponent(basename(ctx.deckPath))}`;

    const page = await fetch(ctx.host.url, { redirect: 'manual' });
    expect(page.status).toBe(302);
    expect(page.headers.get('location')).toBe(friendlyPath);
    const setCookies = page.headers.getSetCookie();
    expect(setCookies).toHaveLength(1);
    expect(setCookies[0]).toBe(expectedSessionCookie(ctx.token));

    const friendly = await fetch(`${ctx.base}${friendlyPath}`, {
      headers: { cookie: setCookies[0]?.split(';')[0] ?? '' }
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

  it('requires a token to serve the editor page and assets', async () => {
    const ctx = await setup();

    const page = await fetch(`${ctx.base}/`);
    expect(page.status).toBe(401);
    expect(page.headers.get('referrer-policy')).toBe('no-referrer');
    expect(page.headers.get('x-content-type-options')).toBe('nosniff');

    const asset = await fetch(`${ctx.base}/app.js`);
    expect(asset.status).toBe(401);

    const wrongCookie = await fetch(`${ctx.base}/app.js`, {
      headers: { cookie: 'htmlppt_token=wrong' }
    });
    expect(wrongCookie.status).toBe(401);
  });

  it('serves the page and assets with the session cookie', async () => {
    const ctx = await setup();
    const page = await fetch(ctx.host.url, { redirect: 'manual' });
    const bootCookies = page.headers.getSetCookie();
    expect(bootCookies).toHaveLength(1);
    expect(bootCookies[0]).toBe(expectedSessionCookie(ctx.token));
    const cookie = bootCookies[0]?.split(';')[0] ?? '';
    expect(cookie).toBe(`htmlppt_token=${encodeURIComponent(ctx.token)}`);

    const friendlyPath = `/d/${encodeURIComponent(basename(ctx.deckPath))}`;
    const rootWithCookie = await fetch(`${ctx.base}/`, {
      headers: { cookie },
      redirect: 'manual'
    });
    expect(rootWithCookie.status).toBe(302);
    expect(rootWithCookie.headers.get('location')).toBe(friendlyPath);
    const rootCookies = rootWithCookie.headers.getSetCookie();
    expect(rootCookies).toHaveLength(1);
    expect(rootCookies[0]).toBe(expectedSessionCookie(ctx.token));

    const withCookie = await fetch(`${ctx.base}${friendlyPath}`, {
      headers: { cookie }
    });
    expect(withCookie.status).toBe(200);
    const pageCookies = withCookie.headers.getSetCookie();
    expect(pageCookies).toHaveLength(1);
    expect(pageCookies[0]).toBe(expectedSessionCookie(ctx.token));
    expect(await withCookie.text()).toContain('editor-shell');

    const asset = await fetch(`${ctx.base}/app.js`, {
      headers: { cookie }
    });
    expect(asset.status).toBe(200);
    expect(await asset.text()).toBe('console.log("editor shell");');

    const queryAsset = await fetch(
      `${ctx.base}/app.js?token=${encodeURIComponent(ctx.token)}`
    );
    expect(queryAsset.status).toBe(200);
  });

  it('does not renew the cookie for assets and 404 responses', async () => {
    const ctx = await setup();
    const cookie = await bootstrapCookie(ctx);
    const token = encodeURIComponent(ctx.token);

    const tokenizedAsset = await fetch(`${ctx.base}/app.js?token=${token}`);
    expect(tokenizedAsset.status).toBe(200);
    expect(tokenizedAsset.headers.get('set-cookie')).toBeNull();

    const cookieAsset = await fetch(`${ctx.base}/app.js`, {
      headers: { cookie }
    });
    expect(cookieAsset.status).toBe(200);
    expect(cookieAsset.headers.get('set-cookie')).toBeNull();

    const tokenizedMiss = await fetch(
      `${ctx.base}/d/other.html?token=${token}`,
      { redirect: 'manual' }
    );
    expect(tokenizedMiss.status).toBe(404);
    expect(tokenizedMiss.headers.get('set-cookie')).toBeNull();

    const bareDeckMiss = await fetch(`${ctx.base}/d?token=${token}`, {
      redirect: 'manual'
    });
    expect(bareDeckMiss.status).toBe(404);
    expect(bareDeckMiss.headers.get('set-cookie')).toBeNull();
  });

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

    const tokenized = await fetch(
      `${ctx.base}/d/other.html?token=${encodeURIComponent(ctx.token)}`,
      { redirect: 'manual' }
    );
    expect(tokenized.status).toBe(404);
  });

  it('serves percent-encoded deck names with spaces and non-ASCII', async () => {
    const dir = await makeTempDir('htmlppt-host-name-');
    let host: Awaited<ReturnType<typeof startHost>> | undefined;
    try {
      const editorDir = join(dir, 'editor');
      await mkdir(editorDir);
      await writeFile(
        join(editorDir, 'index.html'),
        '<!doctype html><div id="root">editor-shell</div>',
        'utf8'
      );
      const fixture = await copyFixture('basic.deck.html', dir);
      const name = 'Q3 投影片.html';
      const deckPath = join(dir, name);
      await writeFile(deckPath, await readFile(fixture, 'utf8'), 'utf8');
      const token = randomUUID();
      host = await startHost({ filePath: deckPath, token, editorDir, port: 0 });
      const base = new URL(host.url).origin;

      const root = await fetch(host.url, { redirect: 'manual' });
      expect(root.status).toBe(302);
      expect(root.headers.get('location')).toBe(
        `/d/${encodeURIComponent(name)}`
      );
      const rootCookies = root.headers.getSetCookie();
      expect(rootCookies).toHaveLength(1);
      expect(rootCookies[0]).toBe(expectedSessionCookie(token));
      const cookie = rootCookies[0]?.split(';')[0] ?? '';
      const page = await fetch(`${base}${root.headers.get('location')}`, {
        headers: { cookie }
      });
      expect(page.status).toBe(200);
      expect(await page.text()).toContain('editor-shell');
    } finally {
      await host?.close();
      await rm(dir, { recursive: true, force: true });
    }
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
    const setCookies = response.headers.getSetCookie();
    expect(setCookies).toHaveLength(1);
    expect(setCookies[0]).toBe(expectedSessionCookie(ctx.token));
  });

  it('renews the cookie on the root redirect with a cookie-only request', async () => {
    const ctx = await setup();
    const cookie = await bootstrapCookie(ctx);
    const friendlyPath = `/d/${encodeURIComponent(basename(ctx.deckPath))}`;

    const root = await fetch(`${ctx.base}/`, {
      headers: { cookie },
      redirect: 'manual'
    });

    expect(root.status).toBe(302);
    expect(root.headers.get('location')).toBe(friendlyPath);
    const setCookies = root.headers.getSetCookie();
    expect(setCookies).toHaveLength(1);
    expect(setCookies[0]).toBe(expectedSessionCookie(ctx.token));
  });

  it('returns 500 without a cookie when the editor HTML cannot be read', async () => {
    const ctx = await setup({ withEditorHtml: false });
    const cookie = await bootstrapCookie(ctx);
    const path = `/d/${encodeURIComponent(basename(ctx.deckPath))}`;

    // Hono logs the expected ENOENT through console.error by default.
    const errorLog = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const response = await fetch(`${ctx.base}${path}`, {
        headers: { cookie },
        redirect: 'manual'
      });

      expect(response.status).toBe(500);
      expect(response.headers.get('set-cookie')).toBeNull();
    } finally {
      errorLog.mockRestore();
    }
  });

  it('renews the cookie on document navigations only', async () => {
    const ctx = await setup();
    const cookie = await bootstrapCookie(ctx);

    const page = await fetch(
      `${ctx.base}/d/${encodeURIComponent(basename(ctx.deckPath))}`,
      {
        headers: { cookie },
        redirect: 'manual'
      }
    );
    expect(page.status).toBe(200);
    const pageCookies = page.headers.getSetCookie();
    expect(pageCookies).toHaveLength(1);
    expect(pageCookies[0]).toBe(expectedSessionCookie(ctx.token));

    const api = await fetch(`${ctx.base}/api/deck`, { headers: { cookie } });
    expect(api.status).toBe(200);
    expect(api.headers.get('set-cookie')).toBeNull();
  });

  it('preserves non-token query parameters when redirecting', async () => {
    const ctx = await setup();
    const friendlyPath = `/d/${encodeURIComponent(basename(ctx.deckPath))}`;
    const token = encodeURIComponent(ctx.token);

    const root = await fetch(
      `${ctx.base}/?presenter=1&session=abc&token=${token}`,
      { redirect: 'manual' }
    );
    expect(root.status).toBe(302);
    expect(root.headers.get('location')).toBe(
      `${friendlyPath}?presenter=1&session=abc`
    );

    const deckPage = await fetch(
      `${ctx.base}${friendlyPath}?presenter=1&session=abc&token=${token}`,
      { redirect: 'manual' }
    );
    expect(deckPage.status).toBe(302);
    expect(deckPage.headers.get('location')).toBe(
      `${friendlyPath}?presenter=1&session=abc`
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

  it('sets security headers on API responses', async () => {
    const ctx = await setup();

    const response = await fetch(`${ctx.base}/api/health`, {
      headers: { authorization: `Bearer ${ctx.token}` }
    });

    expect(response.status).toBe(200);
    expect(response.headers.get('referrer-policy')).toBe('no-referrer');
    expect(response.headers.get('x-content-type-options')).toBe('nosniff');
  });

  it('requires a token for the API', async () => {
    const ctx = await setup();

    const response = await fetch(`${ctx.base}/api/deck`);

    expect(response.status).toBe(401);
  });

  it('accepts the bearer scheme case-insensitively', async () => {
    const ctx = await setup();

    const response = await fetch(`${ctx.base}/api/deck`, {
      headers: { authorization: `bearer ${ctx.token}` }
    });

    expect(response.status).toBe(200);
  });

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

  it('requires a bearer token for health', async () => {
    const ctx = await setup();

    const response = await fetch(`${ctx.base}/api/health`, {
      headers: { authorization: `Bearer ${ctx.token}` }
    });

    expect(response.status).toBe(200);
  });

  it('rejects the token when it is supplied as a query parameter', async () => {
    const ctx = await setup();

    const health = await fetch(
      `${ctx.base}/api/health?token=${encodeURIComponent(ctx.token)}`
    );

    expect(health.status).toBe(401);
    expect(await health.json()).toEqual({ error: 'unauthorized' });
  });

  it('accepts the token as a query parameter only for the event stream', async () => {
    const ctx = await setup();

    const response = await fetch(
      `${ctx.base}/api/events?token=${encodeURIComponent(ctx.token)}`
    );

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

  it('reports health with the current revision', async () => {
    const ctx = await setup();

    const response = await fetch(`${ctx.base}/api/health`, {
      headers: { authorization: `Bearer ${ctx.token}` }
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      ok: true,
      revision: ctx.revision,
      version: HOST_VERSION,
      filePath: ctx.deckPath
    });
  });

  it('rejects a foreign origin', async () => {
    const ctx = await setup();

    const response = await fetch(`${ctx.base}/api/deck`, {
      headers: {
        authorization: `Bearer ${ctx.token}`,
        origin: 'http://evil.example'
      }
    });

    expect(response.status).toBe(403);
  });

  it.each(['null', 'not a url'])(
    'rejects the origin value %j with 403',
    async (origin) => {
      const ctx = await setup();

      const response = await fetch(`${ctx.base}/api/deck`, {
        headers: {
          authorization: `Bearer ${ctx.token}`,
          origin
        }
      });

      expect(response.status).toBe(403);
      expect(await response.json()).toEqual({ error: 'forbidden origin' });
    }
  );

  it('allows a loopback same-origin request', async () => {
    const ctx = await setup();

    const response = await fetch(`${ctx.base}/api/deck`, {
      headers: {
        authorization: `Bearer ${ctx.token}`,
        origin: `http://127.0.0.1:${ctx.host.port}`
      }
    });

    expect(response.status).toBe(200);
  });

  it('serves static editor assets only with the session cookie', async () => {
    const ctx = await setup();
    const cookie = `htmlppt_token=${encodeURIComponent(ctx.token)}`;

    const response = await fetch(`${ctx.base}/app.js`, {
      headers: { cookie }
    });

    expect(response.status).toBe(200);
    expect(await response.text()).toBe('console.log("editor shell");');
  });

  it('does not serve deck files other than the opened deck', async () => {
    const ctx = await setup();
    const cookie = `htmlppt_token=${encodeURIComponent(ctx.token)}`;
    const marker = 'sibling-deck-marker';
    await writeFile(
      join(ctx.dir, 'other.html'),
      `<!doctype html><title>${marker}</title>`,
      'utf8'
    );

    const response = await fetch(`${ctx.base}/other.html`, {
      headers: { cookie }
    });

    expect(response.status).toBe(404);
    expect(await response.text()).not.toContain(marker);
  });

  it('rejects encoded path traversal without leaking files', async () => {
    const ctx = await setup();
    const cookie = `htmlppt_token=${encodeURIComponent(ctx.token)}`;
    const deckMarker = 'parent-secret-marker';
    await writeFile(join(ctx.dir, 'parent-secret.txt'), deckMarker, 'utf8');
    const outsideMarker = 'outside-secret-marker';
    const outsideName = `htmlppt-outside-${randomUUID()}.txt`;
    const outsidePath = join(ctx.dir, '..', outsideName);
    await writeFile(outsidePath, outsideMarker, 'utf8');

    try {
      const probes = [
        '/%2e%2e/parent-secret.txt',
        '/..%2fparent-secret.txt',
        '/%2e%2e%2fparent-secret.txt',
        `/%2e%2e/%2e%2e/${outsideName}`
      ];
      for (const probe of probes) {
        const result = await rawGet(ctx.host.port, probe, cookie);
        expect([400, 403, 404]).toContain(result.status);
        expect(result.body).not.toContain(deckMarker);
        expect(result.body).not.toContain(outsideMarker);
      }
    } finally {
      await rm(outsidePath, { force: true });
    }
  });

  it('does not expose directory listings', async () => {
    const ctx = await setup();
    const cookie = `htmlppt_token=${encodeURIComponent(ctx.token)}`;
    const marker = 'directory-secret-marker';
    await mkdir(join(ctx.editorDir, 'assets'));
    await writeFile(join(ctx.editorDir, 'assets', 'secret.txt'), marker, 'utf8');

    const response = await fetch(`${ctx.base}/assets/`, {
      headers: { cookie }
    });

    expect(response.status).toBe(404);
    const body = await response.text();
    expect(body).not.toContain(marker);
    expect(body).not.toContain('secret.txt');
  });

  it('saves a valid deck atomically and returns a new revision', async () => {
    const ctx = await setup();
    const updated = ctx.deckHtml.replace('Basic deck', 'Updated deck');

    const response = await fetch(`${ctx.base}/api/deck`, {
      method: 'PUT',
      headers: {
        authorization: `Bearer ${ctx.token}`,
        'content-type': 'application/json'
      },
      body: JSON.stringify({ html: updated, baseRevision: ctx.revision })
    });

    expect(response.status).toBe(200);
    const body = (await response.json()) as { revision: string };
    expect(body.revision).not.toBe(ctx.revision);
    expect(await readFile(ctx.deckPath, 'utf8')).toBe(updated);
  });

  it('serializes concurrent saves with the same base revision', async () => {
    const ctx = await setup();
    const updated = ctx.deckHtml.replace('Basic deck', 'Concurrent deck');
    const save = () =>
      fetch(`${ctx.base}/api/deck`, {
        method: 'PUT',
        headers: {
          authorization: `Bearer ${ctx.token}`,
          'content-type': 'application/json'
        },
        body: JSON.stringify({ html: updated, baseRevision: ctx.revision })
      });

    const responses = await Promise.all([save(), save()]);
    const statuses = responses.map((response) => response.status).sort();
    expect(statuses).toEqual([200, 409]);
    expect(await readFile(ctx.deckPath, 'utf8')).toBe(updated);

    const saved = responses.find((response) => response.status === 200);
    if (!saved) {
      throw new Error('Expected one save to succeed.');
    }
    const { revision } = (await saved.json()) as { revision: string };

    const check = await fetch(`${ctx.base}/api/deck`, {
      headers: { authorization: `Bearer ${ctx.token}` }
    });
    expect(check.status).toBe(200);
    expect(await check.json()).toMatchObject({ html: updated, revision });
  });

  it('reads external file changes and rejects a stale save', async () => {
    const ctx = await setup();
    const externalHtml = ctx.deckHtml.replaceAll(
      'Basic deck',
      'External writer wins'
    );
    await writeFile(ctx.deckPath, externalHtml, 'utf8');

    const deckResponse = await fetch(`${ctx.base}/api/deck`, {
      headers: { authorization: `Bearer ${ctx.token}` }
    });
    expect(deckResponse.status).toBe(200);
    const deckBody = (await deckResponse.json()) as {
      html: string;
      revision: string;
    };
    expect(deckBody).toMatchObject({ html: externalHtml });
    expect(deckBody.revision).not.toBe(ctx.revision);

    // Health is a cached read: once the deck endpoint observes the external
    // write, health reports the same revision without touching the file.
    const health = await fetch(`${ctx.base}/api/health`, {
      headers: { authorization: `Bearer ${ctx.token}` }
    });
    expect(health.status).toBe(200);
    expect(await health.json()).toMatchObject({
      ok: true,
      revision: deckBody.revision
    });

    const saveResponse = await fetch(`${ctx.base}/api/deck`, {
      method: 'PUT',
      headers: {
        authorization: `Bearer ${ctx.token}`,
        'content-type': 'application/json'
      },
      body: JSON.stringify({
        html: ctx.deckHtml.replaceAll('Basic deck', 'Editor tries to save'),
        baseRevision: ctx.revision
      })
    });
    expect(saveResponse.status).toBe(409);
    expect(await saveResponse.json()).toEqual({
      error: 'conflict',
      revision: deckBody.revision,
      filePath: ctx.deckPath
    });
    expect(await readFile(ctx.deckPath, 'utf8')).toBe(externalHtml);

    const followUp = await fetch(`${ctx.base}/api/deck`, {
      headers: { authorization: `Bearer ${ctx.token}` }
    });
    expect(await followUp.json()).toMatchObject({
      html: externalHtml,
      revision: deckBody.revision
    });
  });

  it('keeps GETs consistent with saves under interleaved reads and writes', async () => {
    const ctx = await setup();
    const authorization = { authorization: `Bearer ${ctx.token}` };
    const updates = Array.from({ length: 12 }, (_, index) =>
      ctx.deckHtml.replace('Basic deck', `Interleaved save ${index}`)
    );

    const requests: Promise<Response>[] = [];
    for (const html of updates) {
      requests.push(
        fetch(`${ctx.base}/api/deck`, {
          method: 'PUT',
          headers: {
            ...authorization,
            'content-type': 'application/json'
          },
          body: JSON.stringify({ html, baseRevision: ctx.revision })
        })
      );
      requests.push(fetch(`${ctx.base}/api/deck`, { headers: authorization }));
    }

    const responses = await Promise.all(requests);
    await Promise.all(responses.map((response) => response.text()));
    const putStatuses = responses
      .filter((_response, index) => index % 2 === 0)
      .map((response) => response.status)
      .sort((a, b) => a - b);
    expect(putStatuses).toEqual([200, ...Array(11).fill(409)]);

    const onDisk = await readFile(ctx.deckPath, 'utf8');
    const deckResponse = await fetch(`${ctx.base}/api/deck`, {
      headers: authorization
    });
    expect(deckResponse.status).toBe(200);
    const deck = (await deckResponse.json()) as {
      html: string;
      revision: string;
    };
    expect(deck.html).toBe(onDisk);

    const healthResponse = await fetch(`${ctx.base}/api/health`, {
      headers: authorization
    });
    expect(healthResponse.status).toBe(200);
    expect(await healthResponse.json()).toEqual({
      ok: true,
      revision: deck.revision,
      version: HOST_VERSION,
      filePath: ctx.deckPath
    });
  });

  it('returns a structured error when the deck cannot be read', async () => {
    const ctx = await setup();
    const authorization = { authorization: `Bearer ${ctx.token}` };
    await rm(ctx.deckPath);

    const deckResponse = await fetch(`${ctx.base}/api/deck`, {
      headers: authorization
    });
    expect(deckResponse.status).toBe(500);
    expect(deckResponse.headers.get('content-type')).toContain(
      'application/json'
    );
    expect(await deckResponse.json()).toEqual({
      error: 'deck-unreadable',
      message: expect.stringContaining(ctx.deckPath)
    });

    // Health never reads the deck, so a missing file cannot turn a running
    // host into an un-stoppable orphan.
    const healthResponse = await fetch(`${ctx.base}/api/health`, {
      headers: authorization
    });
    expect(healthResponse.status).toBe(200);
    expect(await healthResponse.json()).toEqual({
      ok: true,
      revision: ctx.revision,
      version: HOST_VERSION,
      filePath: ctx.deckPath
    });

    const putResponse = await fetch(`${ctx.base}/api/deck`, {
      method: 'PUT',
      headers: {
        ...authorization,
        'content-type': 'application/json'
      },
      body: JSON.stringify({
        html: ctx.deckHtml.replace('Basic deck', 'Should not be written'),
        baseRevision: ctx.revision
      })
    });
    expect(putResponse.status).toBe(500);
    expect(await putResponse.json()).toEqual({
      error: 'deck-unreadable',
      message: expect.stringContaining(ctx.deckPath)
    });
    await expect(readFile(ctx.deckPath, 'utf8')).rejects.toMatchObject({
      code: 'ENOENT'
    });

    await writeFile(ctx.deckPath, ctx.deckHtml, 'utf8');
    const restored = await fetch(`${ctx.base}/api/deck`, {
      headers: authorization
    });
    expect(restored.status).toBe(200);
    expect(await restored.json()).toMatchObject({
      html: ctx.deckHtml,
      revision: ctx.revision
    });
  });

  it('opens another deck and rebinds the watcher, deck API, and SSE', async () => {
    const ctx = await setup();
    const nextPath = await addDeck(ctx, 'second.html', 'Second deck');
    const cookie = await bootstrapCookie(ctx);
    const events = await connectEvents(ctx);
    try {
      await events.next();
      const response = await openDeck(ctx, cookie, nextPath);
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
        data: {
          revision: opened.revision,
          source: 'external',
          filePath: opened.filePath
        }
      });

      const deck = await fetch(`${ctx.base}/api/deck`, { headers: { cookie } });
      expect(await deck.json()).toMatchObject({
        filePath: await realpath(nextPath),
        revision: opened.revision
      });
      const health = await fetch(`${ctx.base}/api/health`, {
        headers: { cookie }
      });
      expect(await health.json()).toMatchObject({
        filePath: await realpath(nextPath),
        revision: opened.revision
      });

      const root = await fetch(`${ctx.base}/`, {
        headers: { cookie },
        redirect: 'manual'
      });
      expect(root.status).toBe(302);
      expect(root.headers.get('location')).toBe('/d/second.html');
    } finally {
      await events.close();
    }
  });

  it('rebinds the watcher to the opened deck and stops watching the old one', async () => {
    const ctx = await setup();
    const nextPath = await addDeck(ctx, 'second.html', 'Second deck');
    const secondHtml = await readFile(nextPath, 'utf8');
    const cookie = await bootstrapCookie(ctx);
    // setup() already installed the host's single watcher, so a rebind must
    // swap it rather than add a second one.
    const before = countStatWatchers();
    const events = await connectEvents(ctx);
    try {
      expect(await events.next()).toEqual({
        event: 'hello',
        data: { revision: ctx.revision }
      });

      const open = await openDeck(ctx, cookie, nextPath);
      expect(open.status).toBe(200);
      const opened = (await open.json()) as {
        revision: string;
        filePath: string;
      };
      expect(await events.next()).toEqual({
        event: 'revision',
        data: {
          revision: opened.revision,
          source: 'external',
          filePath: opened.filePath
        }
      });
      expect(countStatWatchers()).toBe(before);

      // The old deck is no longer watched, so writing it must not surface.
      await writeFile(ctx.deckPath, `${ctx.deckHtml}\n<!-- old -->`, 'utf8');
      await events.expectNoEvent(500);

      // The new deck is watched, so its next write becomes an external
      // revision and the deck API serves the new content.
      const updated = secondHtml.replace('Second deck', 'Second deck updated');
      await writeFile(nextPath, updated, 'utf8');
      expect(await events.next()).toEqual({
        event: 'revision',
        data: {
          revision: sha256(updated),
          source: 'external',
          filePath: await realpath(nextPath)
        }
      });

      const deck = await fetch(`${ctx.base}/api/deck`, { headers: { cookie } });
      expect(deck.status).toBe(200);
      expect(await deck.json()).toMatchObject({
        html: updated,
        filePath: await realpath(nextPath),
        revision: sha256(updated)
      });
    } finally {
      await events.close();
    }
  });

  it('no-ops when the requested deck is already current', async () => {
    const ctx = await setup();
    const cookie = await bootstrapCookie(ctx);

    const response = await openDeck(ctx, cookie, ctx.deckPath);

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      filePath: ctx.deckPath,
      revision: ctx.revision
    });
  });

  it('rejects invalid open requests without changing the deck', async () => {
    const ctx = await setup();
    const cookie = await bootstrapCookie(ctx);
    await writeFile(join(ctx.dir, 'notes.txt'), 'notes', 'utf8');
    const statuses: Array<[string, number]> = [
      ['missing.html', 404],
      [ctx.dir, 422],
      [join(ctx.dir, 'notes.txt'), 422]
    ];
    for (const [target, status] of statuses) {
      const response = await openDeck(ctx, cookie, target);
      expect(response.status, target).toBe(status);
    }
    const badDeck = join(ctx.dir, 'bad.html');
    await writeFile(badDeck, '<!doctype html><p>not a deck</p>', 'utf8');
    const invalid = await openDeck(ctx, cookie, badDeck);
    expect(invalid.status).toBe(422);
    expect(await invalid.json()).toMatchObject({ error: 'invalid-deck' });

    const deck = await fetch(`${ctx.base}/api/deck`, { headers: { cookie } });
    expect(await deck.json()).toMatchObject({
      filePath: ctx.deckPath,
      revision: ctx.revision
    });
  });

  it('rejects an open request without a usable path', async () => {
    const ctx = await setup();
    const cookie = await bootstrapCookie(ctx);

    for (const body of ['{}', '{"path":42}', '{"path":"   "}', 'null']) {
      const response = await fetch(`${ctx.base}/api/open`, {
        method: 'POST',
        headers: { cookie, 'content-type': 'application/json' },
        body
      });
      expect(response.status, body).toBe(400);
      expect(await response.json(), body).toMatchObject({
        error: 'invalid-path'
      });
    }
  });

  it('rejects an open request over 64 KiB', async () => {
    const ctx = await setup();
    const cookie = await bootstrapCookie(ctx);

    const response = await fetch(`${ctx.base}/api/open`, {
      method: 'POST',
      headers: { cookie, 'content-type': 'application/json' },
      body: JSON.stringify({ path: 'x'.repeat(70 * 1024) })
    });

    expect(response.status).toBe(413);
    expect(await response.json()).toMatchObject({
      error: 'payload-too-large'
    });

    const deck = await fetch(`${ctx.base}/api/deck`, { headers: { cookie } });
    expect(await deck.json()).toMatchObject({
      filePath: ctx.deckPath,
      revision: ctx.revision
    });
  });

  it('returns deck-unreadable when the opened path is a directory', async () => {
    const ctx = await setup();
    const cookie = await bootstrapCookie(ctx);
    const blocked = join(ctx.dir, 'blocked.html');
    await mkdir(blocked);

    const response = await openDeck(ctx, cookie, blocked);

    expect(response.status).toBe(500);
    expect(await response.json()).toMatchObject({ error: 'deck-unreadable' });

    const deck = await fetch(`${ctx.base}/api/deck`, { headers: { cookie } });
    expect(await deck.json()).toMatchObject({
      filePath: ctx.deckPath,
      revision: ctx.revision
    });
  });

  it('rejects a deck already served by another live host', async () => {
    const ctx = await setup();
    const home = await makeTempDir('htmlppt-home-');
    const previousHome = process.env.HTMLPPT_HOME;
    const other = join(ctx.dir, 'shared.html');
    try {
      process.env.HTMLPPT_HOME = home;
      await writeFile(other, ctx.deckHtml, 'utf8');
      // Register the deck under an alias spelling. The 409 scan must compare
      // entries by realpath instead of assuming a canonical registry key.
      const aliasDir = join(ctx.dir, 'shared-alias');
      await symlink(
        ctx.dir,
        aliasDir,
        process.platform === 'win32' ? 'junction' : 'dir'
      );
      await writeSession({
        path: join(aliasDir, 'shared.html'),
        port: ctx.host.port + 1,
        token: 'other-token',
        pid: process.pid,
        startedAt: new Date().toISOString(),
        revision: ctx.revision
      });
      const cookie = await bootstrapCookie(ctx);

      const response = await openDeck(ctx, cookie, other);

      expect(response.status).toBe(409);
      expect(await response.json()).toMatchObject({
        error: 'deck-already-open',
        url: `http://127.0.0.1:${ctx.host.port + 1}/?token=other-token`
      });
    } finally {
      if (previousHome === undefined) {
        delete process.env.HTMLPPT_HOME;
      } else {
        process.env.HTMLPPT_HOME = previousHome;
      }
      await rm(home, { recursive: true, force: true });
    }
  });

  it('reports the different host when a same-port entry matches first', async () => {
    const ctx = await setup();
    const home = await makeTempDir('htmlppt-home-');
    const previousHome = process.env.HTMLPPT_HOME;
    const other = join(ctx.dir, 'shared.html');
    try {
      process.env.HTMLPPT_HOME = home;
      await writeFile(other, ctx.deckHtml, 'utf8');
      // Two spellings of the same deck: the same-port duplicate sorts first,
      // so a scan that stops at the first match would hide the other host.
      const sameAlias = join(ctx.dir, 'shared-alias-a');
      const otherAlias = join(ctx.dir, 'shared-alias-b');
      await symlink(
        ctx.dir,
        sameAlias,
        process.platform === 'win32' ? 'junction' : 'dir'
      );
      await symlink(
        ctx.dir,
        otherAlias,
        process.platform === 'win32' ? 'junction' : 'dir'
      );
      await writeSession({
        path: join(sameAlias, 'shared.html'),
        port: ctx.host.port,
        token: 'same-host-token',
        pid: process.pid,
        startedAt: new Date().toISOString(),
        revision: ctx.revision
      });
      await writeSession({
        path: join(otherAlias, 'shared.html'),
        port: ctx.host.port + 1,
        token: 'other-token',
        pid: process.pid,
        startedAt: new Date().toISOString(),
        revision: ctx.revision
      });
      const cookie = await bootstrapCookie(ctx);

      const response = await openDeck(ctx, cookie, other);

      expect(response.status).toBe(409);
      expect(await response.json()).toMatchObject({
        error: 'deck-already-open',
        url: `http://127.0.0.1:${ctx.host.port + 1}/?token=other-token`
      });
    } finally {
      if (previousHome === undefined) {
        delete process.env.HTMLPPT_HOME;
      } else {
        process.env.HTMLPPT_HOME = previousHome;
      }
      await rm(home, { recursive: true, force: true });
    }
  });

  it('reports the opened deck through onDeckOpened even when it rejects', async () => {
    const dir = await makeTempDir('htmlppt-host-callback-');
    let host: Awaited<ReturnType<typeof startHost>> | undefined;
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const editorDir = join(dir, 'editor');
      await mkdir(editorDir);
      await writeFile(
        join(editorDir, 'index.html'),
        '<!doctype html><div id="root">editor-shell</div>',
        'utf8'
      );
      const deckPath = await realpath(await copyFixture('basic.deck.html', dir));
      const deckHtml = await readFile(deckPath, 'utf8');
      const nextPath = join(dir, 'callback.html');
      await writeFile(
        nextPath,
        deckHtml.replace(/<h1[^>]*>.*?<\/h1>/s, '<h1>Callback deck</h1>'),
        'utf8'
      );
      const token = randomUUID();
      const opened: Array<{
        previousPath: string;
        path: string;
        revision: string;
      }> = [];
      host = await startHost({
        filePath: deckPath,
        token,
        editorDir,
        port: 0,
        onDeckOpened: (event) => {
          opened.push(event);
          throw new Error('registry offline');
        }
      });
      const base = new URL(host.url).origin;

      const response = await fetch(`${base}/api/open`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${token}`,
          'content-type': 'application/json'
        },
        body: JSON.stringify({ path: nextPath })
      });

      expect(response.status).toBe(200);
      const body = (await response.json()) as { revision: string };
      expect(opened).toEqual([
        {
          previousPath: deckPath,
          path: await realpath(nextPath),
          revision: body.revision
        }
      ]);
      expect(errorSpy).toHaveBeenCalledWith(
        expect.stringContaining('Failed to move the session registry')
      );
    } finally {
      errorSpy.mockRestore();
      await host?.close();
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('rejects a null JSON body', async () => {
    const ctx = await setup();

    const response = await fetch(`${ctx.base}/api/deck`, {
      method: 'PUT',
      headers: {
        authorization: `Bearer ${ctx.token}`,
        'content-type': 'application/json'
      },
      body: 'null'
    });

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: 'invalid body' });
  });

  it(
    'rejects a deck update over 16 MiB and still accepts a normal save',
    async () => {
      const ctx = await setup();
      const oversized = JSON.stringify({
        html: 'x'.repeat(16 * 1024 * 1024)
      });

      const rejected = await fetch(`${ctx.base}/api/deck`, {
        method: 'PUT',
        headers: {
          authorization: `Bearer ${ctx.token}`,
          'content-type': 'application/json'
        },
        body: oversized
      });

      expect(rejected.status).toBe(413);
      const body = (await rejected.json()) as {
        error: string;
        message: string;
      };
      expect(body.error).toBe('payload-too-large');
      expect(body.message).toMatch(/16 MiB/);
      expect(await readFile(ctx.deckPath, 'utf8')).toBe(ctx.deckHtml);

      const normal = await putDeck(
        ctx,
        ctx.deckHtml.replace('Basic deck', 'After oversized update'),
        { baseRevision: ctx.revision }
      );
      expect(normal.status).toBe(200);
    },
    30_000
  );

  it('rejects an invalid deck and leaves the file unchanged', async () => {
    const ctx = await setup();
    const duplicate = `<!doctype html><html><head><title>Bad</title></head><body><section data-slide-id="same"></section><section data-slide-id="same"></section></body></html>`;

    const response = await fetch(`${ctx.base}/api/deck`, {
      method: 'PUT',
      headers: {
        authorization: `Bearer ${ctx.token}`,
        'content-type': 'application/json'
      },
      body: JSON.stringify({ html: duplicate, baseRevision: ctx.revision })
    });

    expect(response.status).toBe(400);
    expect(await readFile(ctx.deckPath, 'utf8')).toBe(ctx.deckHtml);
  });

  it('rejects a stale base revision', async () => {
    const ctx = await setup();

    const response = await fetch(`${ctx.base}/api/deck`, {
      method: 'PUT',
      headers: {
        authorization: `Bearer ${ctx.token}`,
        'content-type': 'application/json'
      },
      body: JSON.stringify({ html: ctx.deckHtml, baseRevision: 'stale' })
    });

    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({
      error: 'conflict',
      revision: ctx.revision,
      filePath: ctx.deckPath
    });
  });

  it('rejects an empty token at startup', async () => {
    const dir = await makeTempDir('htmlppt-host-');
    let host: Awaited<ReturnType<typeof startHost>> | undefined;
    try {
      const editorDir = join(dir, 'editor');
      await mkdir(editorDir);
      const deckPath = await copyFixture('basic.deck.html', dir);

      await expect(
        startHost({ filePath: deckPath, token: '', editorDir, port: 0 }).then(
          (started) => {
            host = started;
          }
        )
      ).rejects.toThrow('Host requires a non-empty token.');
    } finally {
      await host?.close();
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('resolves a second close call', async () => {
    const ctx = await setup();
    context = undefined;
    try {
      await ctx.host.close();
      await expect(ctx.host.close()).resolves.toBeUndefined();
    } finally {
      await rm(ctx.dir, { recursive: true, force: true });
    }
  });

  describe('events', () => {
    it('greets a client with the current revision', async () => {
      const ctx = await setup();
      const events = await connectEvents(ctx);
      try {
        expect(await events.next()).toEqual({
          event: 'hello',
          data: { revision: ctx.revision }
        });
      } finally {
        await events.close();
      }
    });

    it('emits an external revision when the file changes on disk', async () => {
      const ctx = await setup();
      const events = await connectEvents(ctx);
      try {
        expect((await events.next()).event).toBe('hello');

        const externalHtml = ctx.deckHtml.replaceAll(
          'Basic deck',
          'External live update'
        );
        await writeFile(ctx.deckPath, externalHtml, 'utf8');

        expect(await events.next()).toEqual({
          event: 'revision',
          data: {
            revision: sha256(externalHtml),
            source: 'external',
            filePath: ctx.deckPath
          }
        });
      } finally {
        await events.close();
      }
    });

    it('emits an editor revision after a save', async () => {
      const ctx = await setup();
      const events = await connectEvents(ctx);
      try {
        expect((await events.next()).event).toBe('hello');

        const updated = ctx.deckHtml.replace('Basic deck', 'SSE editor save');
        const response = await putDeck(ctx, updated, {
          baseRevision: ctx.revision
        });
        expect(response.status).toBe(200);
        const body = (await response.json()) as { revision: string };
        expect(body.revision).toBe(sha256(updated));

        expect(await events.next()).toEqual({
          event: 'revision',
          data: {
            revision: body.revision,
            source: 'editor',
            filePath: ctx.deckPath
          }
        });
        // The watcher must not report our own write as an external change.
        await events.expectNoEvent(500);
      } finally {
        await events.close();
      }
    });

    it('emits an mcp revision for mcp-sourced saves', async () => {
      const ctx = await setup();
      const events = await connectEvents(ctx);
      try {
        expect((await events.next()).event).toBe('hello');

        const updated = ctx.deckHtml.replace('Basic deck', 'MCP save');
        const response = await putDeck(ctx, updated, {
          baseRevision: ctx.revision,
          source: 'mcp'
        });
        expect(response.status).toBe(200);
        const body = (await response.json()) as { revision: string };
        expect(body.revision).toBe(sha256(updated));

        expect(await events.next()).toEqual({
          event: 'revision',
          data: {
            revision: body.revision,
            source: 'mcp',
            filePath: ctx.deckPath
          }
        });
      } finally {
        await events.close();
      }
    });

    it('does not emit a revision for identical content', async () => {
      const ctx = await setup();
      const events = await connectEvents(ctx);
      try {
        expect((await events.next()).event).toBe('hello');

        const response = await putDeck(ctx, ctx.deckHtml, {
          baseRevision: ctx.revision
        });
        expect(response.status).toBe(200);
        expect(await response.json()).toEqual({ revision: ctx.revision });
        await events.expectNoEvent(500);

        await writeFile(ctx.deckPath, ctx.deckHtml, 'utf8');
        await events.expectNoEvent(500);
      } finally {
        await events.close();
      }
    });

    it('requires a token and a local origin for the event stream', async () => {
      const ctx = await setup();

      const missingToken = await fetch(`${ctx.base}/api/events`);
      expect(missingToken.status).toBe(401);
      await missingToken.text();

      const wrongToken = await fetch(`${ctx.base}/api/events?token=wrong`);
      expect(wrongToken.status).toBe(401);
      await wrongToken.text();

      const foreignOrigin = await fetch(
        `${ctx.base}/api/events?token=${encodeURIComponent(ctx.token)}`,
        { headers: { origin: 'http://evil.example' } }
      );
      expect(foreignOrigin.status).toBe(403);
      expect(await foreignOrigin.json()).toEqual({ error: 'forbidden origin' });
    });

    it('overwrites with a stale base revision when force is set', async () => {
      const ctx = await setup();
      const events = await connectEvents(ctx);
      try {
        expect((await events.next()).event).toBe('hello');

        const first = ctx.deckHtml.replace('Basic deck', 'First save');
        const firstResponse = await putDeck(ctx, first, {
          baseRevision: ctx.revision
        });
        expect(firstResponse.status).toBe(200);
        const firstBody = (await firstResponse.json()) as { revision: string };
        expect(await events.next()).toEqual({
          event: 'revision',
          data: {
            revision: firstBody.revision,
            source: 'editor',
            filePath: ctx.deckPath
          }
        });

        const forced = ctx.deckHtml.replace('Basic deck', 'Forced overwrite');
        const forcedResponse = await putDeck(ctx, forced, {
          baseRevision: ctx.revision,
          force: true
        });
        expect(forcedResponse.status).toBe(200);
        const forcedBody = (await forcedResponse.json()) as { revision: string };
        expect(forcedBody.revision).toBe(sha256(forced));
        expect(await events.next()).toEqual({
          event: 'revision',
          data: {
            revision: forcedBody.revision,
            source: 'editor',
            filePath: ctx.deckPath
          }
        });
        expect(await readFile(ctx.deckPath, 'utf8')).toBe(forced);
      } finally {
        await events.close();
      }
    });

    it('ends the stream and stops the watcher on close', async () => {
      const watchersBefore = countStatWatchers();
      const ctx = await setup();
      context = undefined;
      const events = await connectEvents(ctx);
      try {
        expect((await events.next()).event).toBe('hello');
        expect(countStatWatchers()).toBe(watchersBefore + 1);

        await ctx.host.close();

        expect(await events.outcome(2_000)).toBe('ended');
        expect(countStatWatchers()).toBe(watchersBefore);
      } finally {
        await ctx.host.close();
        await events.close();
        await rm(ctx.dir, { recursive: true, force: true });
      }
    });
  });
});
