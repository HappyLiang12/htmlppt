import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { copyFixture, makeTempDir } from '@htmlppt/test-utils';
import { afterEach, describe, expect, it } from 'vitest';
import { HOST_VERSION, startHost } from '../src/server.js';

interface Context {
  dir: string;
  deckPath: string;
  deckHtml: string;
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

let context: Context | undefined;

async function setup(): Promise<Context> {
  const dir = await makeTempDir('htmlppt-host-');
  let host: Awaited<ReturnType<typeof startHost>> | undefined;
  try {
    const editorDir = join(dir, 'editor');
    await mkdir(editorDir);
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
    context = { dir, deckPath, deckHtml, token, host, base, revision: deck.revision };
    return context;
  } catch (error) {
    await host?.close();
    await rm(dir, { recursive: true, force: true });
    throw error;
  }
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

describe('host', () => {
  it('serves the editor and the deck', async () => {
    const ctx = await setup();

    const page = await fetch(ctx.host.url);
    expect(page.status).toBe(200);
    expect(await page.text()).toContain('editor-shell');
    const setCookie = page.headers.get('set-cookie') ?? '';
    expect(setCookie).toContain(
      `htmlppt_token=${encodeURIComponent(ctx.token)}`
    );
    expect(setCookie.toLowerCase()).toContain('httponly');
    expect(setCookie).toContain('SameSite=Strict');
    expect(setCookie).toContain('Path=/');

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
    const page = await fetch(ctx.host.url);
    const cookie = page.headers.get('set-cookie')?.split(';')[0] ?? '';
    expect(cookie).toBe(`htmlppt_token=${encodeURIComponent(ctx.token)}`);

    const withCookie = await fetch(`${ctx.base}/`, {
      headers: { cookie }
    });
    expect(withCookie.status).toBe(200);
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

  it('accepts the token as a query parameter', async () => {
    const ctx = await setup();

    const response = await fetch(
      `${ctx.base}/api/health?token=${encodeURIComponent(ctx.token)}`
    );

    expect(response.status).toBe(200);
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
            source: 'external'
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
          data: { revision: body.revision, source: 'editor' }
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
          data: { revision: body.revision, source: 'mcp' }
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
          data: { revision: firstBody.revision, source: 'editor' }
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
          data: { revision: forcedBody.revision, source: 'editor' }
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
