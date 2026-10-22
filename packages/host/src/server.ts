import { watchFile, unwatchFile } from 'node:fs';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { serve } from '@hono/node-server';
import { serveStatic } from '@hono/node-server/serve-static';
import {
  DeckFileConflictError,
  parseDeckHtml,
  readDeckFile,
  writeDeckFileAtomic
} from '@htmlppt/core/node';
import { validateDeck } from '@htmlppt/core';
import { Hono } from 'hono';

export interface HostOptions {
  filePath: string;
  token: string;
  editorDir: string;
  port?: number;
}

export type RevisionSource = 'editor' | 'external' | 'mcp';

export interface HostHandle {
  url: string;
  port: number;
  sessions?: never;
  close: () => Promise<void>;
}

interface RevisionEntry {
  revision: string;
  html: string;
  at: string;
  source: RevisionSource;
}

interface SseClient {
  controller: ReadableStreamDefaultController<Uint8Array>;
  heartbeat: NodeJS.Timeout;
  closed: boolean;
  finished: Promise<void>;
}

interface ResponseHandle {
  writableFinished: boolean;
  once(event: 'finish' | 'close', listener: () => void): unknown;
}

const HISTORY_LIMIT = 20;
const WATCH_INTERVAL_MS = 50;
const WATCH_DEBOUNCE_MS = 100;
const HEARTBEAT_MS = 15_000;
const encoder = new TextEncoder();
const SSE_HEADERS = {
  'content-type': 'text/event-stream',
  'cache-control': 'no-cache, no-transform',
  connection: 'close',
  'x-accel-buffering': 'no'
};

const UNREADABLE_CODES = new Set(['ENOENT', 'EISDIR', 'EACCES']);

function isUnreadable(error: unknown): boolean {
  return UNREADABLE_CODES.has(
    (error as NodeJS.ErrnoException | undefined)?.code ?? ''
  );
}

let saveChain: Promise<unknown> = Promise.resolve();

function withSaveLock<T>(task: () => Promise<T>): Promise<T> {
  const run = saveChain.then(task, task);
  saveChain = run.then(
    () => undefined,
    () => undefined
  );
  return run;
}

function sseChunk(event: string, data: unknown): Uint8Array {
  return encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

function responseFinished(outgoing: ResponseHandle | undefined): Promise<void> {
  if (!outgoing || outgoing.writableFinished) {
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    outgoing.once('finish', resolve);
    outgoing.once('close', resolve);
  });
}

async function waitFor(
  promises: Promise<unknown>,
  timeoutMs: number
): Promise<void> {
  let timer: NodeJS.Timeout | undefined;
  try {
    await Promise.race([
      promises,
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, timeoutMs);
        timer.unref();
      })
    ]);
  } finally {
    if (timer) {
      clearTimeout(timer);
    }
  }
}

export async function startHost(options: HostOptions): Promise<HostHandle> {
  if (!options.token) {
    throw new Error('Host requires a non-empty token.');
  }

  const initial = await readDeckFile(options.filePath);
  let html = initial.html;
  let revision = initial.hash;
  let port = 0;
  let closed = false;
  let syncTimer: NodeJS.Timeout | undefined;

  // The history is internal: it keeps the last twenty committed snapshots for
  // same-session recovery and is deliberately not exposed over HTTP.
  const history: RevisionEntry[] = [
    {
      revision,
      html,
      at: new Date().toISOString(),
      source: 'external'
    }
  ];

  const clients = new Set<SseClient>();

  function remember(source: RevisionSource): void {
    history.push({
      revision,
      html,
      at: new Date().toISOString(),
      source
    });
    if (history.length > HISTORY_LIMIT) {
      history.splice(0, history.length - HISTORY_LIMIT);
    }
  }

  function forgetClient(client: SseClient): void {
    if (client.closed) {
      return;
    }
    client.closed = true;
    clearInterval(client.heartbeat);
    clients.delete(client);
  }

  function endClient(client: SseClient): void {
    forgetClient(client);
    try {
      client.controller.close();
    } catch {
      // The client already cancelled the stream.
    }
  }

  function broadcast(event: string, data: unknown): void {
    const chunk = sseChunk(event, data);
    for (const client of clients) {
      try {
        client.controller.enqueue(chunk);
      } catch {
        forgetClient(client);
      }
    }
  }

  /**
   * Re-reads the deck and promotes the disk state to the current revision when
   * it changed. Any change observed here is external by definition because
   * our own writes update the cache before releasing the save lock.
   */
  async function syncFromDisk(): Promise<void> {
    const snapshot = await readDeckFile(options.filePath);
    if (snapshot.hash === revision) {
      return;
    }
    html = snapshot.html;
    revision = snapshot.hash;
    remember('external');
    broadcast('revision', { revision, source: 'external' });
  }

  const app = new Hono();

  app.use('/api/*', async (c, next) => {
    const authorization = c.req.header('authorization') ?? '';
    const bearerPrefix = 'bearer ';
    const bearer = authorization.toLowerCase().startsWith(bearerPrefix)
      ? authorization.slice(bearerPrefix.length)
      : '';
    const queryToken = new URL(c.req.url).searchParams.get('token') ?? '';
    if (bearer !== options.token && queryToken !== options.token) {
      return c.json({ error: 'unauthorized' }, 401);
    }

    const origin = c.req.header('origin');
    if (origin) {
      let parsed: URL;
      try {
        parsed = new URL(origin);
      } catch {
        return c.json({ error: 'forbidden origin' }, 403);
      }
      const isLocal =
        parsed.hostname === '127.0.0.1' || parsed.hostname === 'localhost';
      if (parsed.protocol !== 'http:' || !isLocal || parsed.port !== String(port)) {
        return c.json({ error: 'forbidden origin' }, 403);
      }
    }

    await next();
  });

  app.get('/api/health', async (c) => {
    return withSaveLock(async () => {
      try {
        await syncFromDisk();
      } catch (error) {
        if (isUnreadable(error)) {
          return c.json({ error: 'deck-unreadable' }, 500);
        }
        throw error;
      }
      return c.json({ ok: true, revision });
    });
  });

  app.get('/api/deck', async (c) => {
    return withSaveLock(async () => {
      try {
        await syncFromDisk();
      } catch (error) {
        if (isUnreadable(error)) {
          return c.json({ error: 'deck-unreadable' }, 500);
        }
        throw error;
      }
      return c.json({ html, revision, filePath: options.filePath });
    });
  });

  app.put('/api/deck', async (c) => {
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: 'invalid json' }, 400);
    }

    if (body === null || typeof body !== 'object' || Array.isArray(body)) {
      return c.json({ error: 'invalid body' }, 400);
    }

    const { html: nextHtml, baseRevision, force } = body as {
      html?: unknown;
      baseRevision?: unknown;
      force?: unknown;
    };
    if (typeof nextHtml !== 'string') {
      return c.json({ error: 'html is required' }, 400);
    }

    const source: RevisionSource =
      c.req.header('x-htmlppt-source') === 'mcp' ? 'mcp' : 'editor';
    const forced = force === true;

    return withSaveLock(async () => {
      try {
        await syncFromDisk();
      } catch (error) {
        if (isUnreadable(error)) {
          return c.json({ error: 'deck-unreadable' }, 500);
        }
        throw error;
      }
      if (
        !forced &&
        typeof baseRevision === 'string' &&
        baseRevision !== revision
      ) {
        return c.json({ error: 'conflict', revision }, 409);
      }

      const result = validateDeck(parseDeckHtml(nextHtml));
      if (!result.valid) {
        return c.json({ error: 'invalid deck', diagnostics: result.errors }, 400);
      }

      let writtenHash: string;
      try {
        const written = await writeDeckFileAtomic(
          options.filePath,
          nextHtml,
          forced ? undefined : revision
        );
        writtenHash = written.hash;
      } catch (error) {
        if (error instanceof DeckFileConflictError) {
          // The deck changed between the accepted revision and the write.
          // Refresh the cached revision so the next request reports the truth.
          try {
            await syncFromDisk();
          } catch (syncError) {
            if (!isUnreadable(syncError)) {
              throw syncError;
            }
          }
          return c.json({ error: 'conflict', revision }, 409);
        }
        if (isUnreadable(error)) {
          return c.json({ error: 'deck-unreadable' }, 500);
        }
        throw error;
      }

      if (writtenHash !== revision) {
        html = nextHtml;
        revision = writtenHash;
        remember(source);
        broadcast('revision', { revision, source });
      }
      return c.json({ revision });
    });
  });

  app.get('/api/events', (c) => {
    let client: SseClient | undefined;
    const outgoing = (c.env as { outgoing?: ResponseHandle }).outgoing;
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        const current: SseClient = {
          controller,
          heartbeat: setInterval(() => {
            try {
              controller.enqueue(encoder.encode(': heartbeat\n\n'));
            } catch {
              forgetClient(current);
            }
          }, HEARTBEAT_MS),
          closed: false,
          finished: responseFinished(outgoing)
        };
        current.heartbeat.unref();
        client = current;
        clients.add(current);
        controller.enqueue(sseChunk('hello', { revision }));

        const signal = c.req.raw.signal;
        if (signal.aborted) {
          forgetClient(current);
          return;
        }
        signal.addEventListener('abort', () => forgetClient(current), {
          once: true
        });
      },
      cancel() {
        if (client) {
          forgetClient(client);
        }
      }
    });
    return new Response(stream, { headers: SSE_HEADERS });
  });

  app.get('/', async (c) => {
    const editorHtml = await readFile(
      path.join(options.editorDir, 'index.html'),
      'utf8'
    );
    return c.html(editorHtml);
  });
  app.use('/*', serveStatic({ root: options.editorDir }));

  const server = await new Promise<ReturnType<typeof serve>>((resolve, reject) => {
    const instance = serve(
      {
        fetch: app.fetch,
        port: options.port ?? 0,
        hostname: '127.0.0.1'
      },
      () => resolve(instance)
    );
    instance.on('error', reject);
  });

  const address = server.address();
  if (!address || typeof address === 'string') {
    throw new Error('Host did not expose a TCP address.');
  }
  port = address.port;
  const url = `http://127.0.0.1:${port}/?token=${encodeURIComponent(options.token)}`;

  const onFileChange = (): void => {
    if (closed) {
      return;
    }
    if (syncTimer) {
      clearTimeout(syncTimer);
    }
    syncTimer = setTimeout(() => {
      syncTimer = undefined;
      void withSaveLock(async () => {
        if (closed) {
          return;
        }
        try {
          await syncFromDisk();
        } catch {
          // A temporarily missing or unreadable deck keeps the last known
          // revision; the API surfaces the error to its callers.
        }
      }).catch(() => undefined);
    }, WATCH_DEBOUNCE_MS);
    syncTimer.unref();
  };
  watchFile(options.filePath, { interval: WATCH_INTERVAL_MS }, onFileChange);

  return {
    url,
    port,
    async close() {
      if (closed) {
        return;
      }
      closed = true;
      unwatchFile(options.filePath, onFileChange);
      if (syncTimer) {
        clearTimeout(syncTimer);
        syncTimer = undefined;
      }
      const closing = new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
      const pending: Promise<void>[] = [];
      for (const client of [...clients]) {
        pending.push(client.finished);
        endClient(client);
      }
      if (pending.length > 0) {
        // Let the ended event-stream responses reach the socket before the
        // remaining idle keep-alive connections are destroyed.
        await waitFor(Promise.all(pending), 1_000);
      }
      (
        server as unknown as { closeAllConnections?: () => void }
      ).closeAllConnections?.();
      await closing;
    }
  };
}
