import { watchFile, unwatchFile } from 'node:fs';
import { mkdir, readFile, realpath } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { serve } from '@hono/node-server';
import { serveStatic } from '@hono/node-server/serve-static';
import {
  DeckFileConflictError,
  parseDeckHtml,
  readDeckFile,
  writeDeckFileAtomic
} from '@htmlppt/core/node';
import { detectSlides, serializeExport, validateDeck } from '@htmlppt/core';
import {
  renderPdf,
  renderPngs,
  RendererUnavailableError,
  RenderError
} from '@htmlppt/renderer';
import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { OpenPathError, resolveDeckPath } from './open-path.js';
import { listSessions, sameDeckPath, type SessionEntry } from './sessions.js';

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

export const HOST_VERSION = '0.0.0';

const HISTORY_LIMIT = 20;
const WATCH_INTERVAL_MS = 50;
const WATCH_DEBOUNCE_MS = 100;
const HEARTBEAT_MS = 15_000;
const TOKEN_COOKIE = 'htmlppt_token';
const COOKIE_MAX_AGE_SECONDS = 60 * 60 * 24 * 30;
const DECK_BODY_LIMIT = 16 * 1024 * 1024;
const EXPORT_BODY_LIMIT = 64 * 1024;
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

function readCookie(header: string | undefined, name: string): string | null {
  if (!header) {
    return null;
  }
  for (const part of header.split(';')) {
    const separator = part.indexOf('=');
    if (separator === -1) {
      continue;
    }
    if (part.slice(0, separator).trim() !== name) {
      continue;
    }
    try {
      return decodeURIComponent(part.slice(separator + 1).trim());
    } catch {
      return null;
    }
  }
  return null;
}

function tokenCookie(token: string): string {
  return `${TOKEN_COOKIE}=${encodeURIComponent(token)}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${COOKIE_MAX_AGE_SECONDS}`;
}

function friendlyDeckPath(filePath: string): string {
  return `/d/${encodeURIComponent(path.basename(filePath))}`;
}

function sessionBootstrapUrl(session: { port: number; token: string }): string {
  return `http://127.0.0.1:${session.port}/?token=${encodeURIComponent(session.token)}`;
}

function queryWithoutToken(url: URL): string {
  const params = new URLSearchParams(url.search);
  params.delete('token');
  const query = params.toString();
  return query ? `?${query}` : '';
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

let saveChain: Promise<unknown> = Promise.resolve();

function withSaveLock<T>(task: () => Promise<T>): Promise<T> {
  const run = saveChain.then(task, task);
  saveChain = run.then(
    () => undefined,
    () => undefined
  );
  return run;
}

function createSerialLock(): <T>(task: () => Promise<T>) => Promise<T> {
  let chain: Promise<unknown> = Promise.resolve();
  return <T>(task: () => Promise<T>): Promise<T> => {
    const run = chain.then(task, task);
    chain = run.then(
      () => undefined,
      () => undefined
    );
    return run;
  };
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

/**
 * Accepts only this host's loopback origin. Default ports are normalized so a
 * host listening on port 80 still matches `http://127.0.0.1` (URL omits :80).
 */
export function isAllowedOrigin(origin: string, port: number): boolean {
  let parsed: URL;
  try {
    parsed = new URL(origin);
  } catch {
    return false;
  }
  if (parsed.protocol !== 'http:') return false;
  if (parsed.hostname !== '127.0.0.1' && parsed.hostname !== 'localhost') {
    return false;
  }
  return (parsed.port || '80') === String(port);
}

function isInside(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return (
    relative === '' ||
    (!path.isAbsolute(relative) &&
      relative !== '..' &&
      !relative.startsWith(`..${path.sep}`))
  );
}

/**
 * Resolves the export directory inside the deck directory, including through
 * symlinks that already exist. The caller creates the directory only after it
 * passed this check.
 */
async function resolveExportDir(
  deckDir: string,
  requested: string | undefined
): Promise<string | null> {
  const root = path.resolve(deckDir);
  const target = path.resolve(root, requested ?? '.');
  if (!isInside(root, target)) {
    return null;
  }
  let existing = target;
  const missing: string[] = [];
  for (;;) {
    try {
      const canonicalRoot = await realpath(root);
      const canonicalCandidate = path.join(
        await realpath(existing),
        ...missing.reverse()
      );
      return isInside(canonicalRoot, canonicalCandidate)
        ? canonicalCandidate
        : null;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        throw error;
      }
      const parent = path.dirname(existing);
      if (parent === existing) {
        return null;
      }
      missing.push(path.basename(existing));
      existing = parent;
    }
  }
}

export async function startHost(options: HostOptions): Promise<HostHandle> {
  if (!options.token) {
    throw new Error('Host requires a non-empty token.');
  }

  const initial = await readDeckFile(options.filePath);
  let filePath = options.filePath;
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
  const withExportLock = createSerialLock();

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
    const snapshot = await readDeckFile(filePath);
    if (snapshot.hash === revision) {
      return;
    }
    html = snapshot.html;
    revision = snapshot.hash;
    remember('external');
    // Every revision carries the deck it belongs to: a dirty tab compares it
    // with the file it loaded so an ordinary edit to a switched deck cannot
    // clear the switched-file conflict.
    broadcast('revision', { revision, source: 'external', filePath });
  }

  const app = new Hono();

  // The editor iframe injects the deck head, so a tokenized parent URL must
  // never leak through the Referer header. No response should be sniffed as a
  // different content type than it declares.
  app.use('*', async (c, next) => {
    await next();
    c.res.headers.set('Referrer-Policy', 'no-referrer');
    c.res.headers.set('X-Content-Type-Options', 'nosniff');
  });

  app.use('/api/*', async (c, next) => {
    const authorization = c.req.header('authorization') ?? '';
    const bearerPrefix = 'bearer ';
    const bearer = authorization.toLowerCase().startsWith(bearerPrefix)
      ? authorization.slice(bearerPrefix.length)
      : '';
    // EventSource cannot set headers, so its query token stays supported for
    // automation. Browser API requests use the HttpOnly session cookie; CLI,
    // MCP, and tests may also use a bearer token.
    const allowsQueryToken =
      c.req.method === 'GET' && c.req.path === '/api/events';
    const queryToken = allowsQueryToken
      ? new URL(c.req.url).searchParams.get('token') ?? ''
      : '';
    const cookieToken = readCookie(c.req.header('cookie'), TOKEN_COOKIE);
    if (
      bearer !== options.token &&
      queryToken !== options.token &&
      cookieToken !== options.token
    ) {
      return c.json({ error: 'unauthorized' }, 401);
    }

    const origin = c.req.header('origin');
    if (origin && !isAllowedOrigin(origin, port)) {
      return c.json({ error: 'forbidden origin' }, 403);
    }

    await next();
  });

  function deckUnreadable(): { error: string; message: string } {
    return {
      error: 'deck-unreadable',
      message: `Could not read ${filePath}. Restore the deck file or stop the host with "htmlppt stop".`
    };
  }

  const deckBodyLimit = bodyLimit({
    maxSize: DECK_BODY_LIMIT,
    onError: (c) =>
      c.json(
        {
          error: 'payload-too-large',
          message:
            'Deck updates are limited to 16 MiB. Remove large embedded assets or split the deck into a smaller file.'
        },
        413
      )
  });

  const exportBodyLimit = bodyLimit({
    maxSize: EXPORT_BODY_LIMIT,
    onError: (c) =>
      c.json(
        {
          error: 'payload-too-large',
          message:
            'Export requests are limited to 64 KiB. Send only { "format": "pdf" | "png", "outDir": "..." }.'
        },
        413
      )
  });

  // Health is a cached liveness probe: it must stay available even when the
  // deck was deleted, otherwise a live host becomes an orphan that stop cannot
  // verify. /api/deck remains the endpoint that surfaces read errors.
  app.get('/api/health', (c) => {
    return c.json({
      ok: true,
      revision,
      version: HOST_VERSION,
      filePath
    });
  });

  app.get('/api/deck', async (c) => {
    return withSaveLock(async () => {
      try {
        await syncFromDisk();
      } catch (error) {
        if (isUnreadable(error)) {
          return c.json(deckUnreadable(), 500);
        }
        throw error;
      }
      return c.json({ html, revision, filePath });
    });
  });

  app.put('/api/deck', deckBodyLimit, async (c) => {
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
          return c.json(deckUnreadable(), 500);
        }
        throw error;
      }
      if (
        !forced &&
        typeof baseRevision === 'string' &&
        baseRevision !== revision
      ) {
        // The rejected save may be the first signal of a deck switch when the
        // SSE event is delayed or lost, so the conflict names the deck too.
        return c.json({ error: 'conflict', revision, filePath }, 409);
      }

      const result = validateDeck(parseDeckHtml(nextHtml));
      if (!result.valid) {
        return c.json({ error: 'invalid deck', diagnostics: result.errors }, 400);
      }

      let writtenHash: string;
      try {
        const written = await writeDeckFileAtomic(
          filePath,
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
          return c.json({ error: 'conflict', revision, filePath }, 409);
        }
        if (isUnreadable(error)) {
          return c.json(deckUnreadable(), 500);
        }
        throw error;
      }

      if (writtenHash !== revision) {
        html = nextHtml;
        revision = writtenHash;
        remember(source);
        broadcast('revision', { revision, source, filePath });
      }
      return c.json({ revision });
    });
  });

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
      return c.json(
        { error: 'invalid-path', message: 'A path is required.' },
        400
      );
    }
    const requested = (body as { path?: unknown }).path;
    if (typeof requested !== 'string' || requested.trim() === '') {
      return c.json(
        { error: 'invalid-path', message: 'A path is required.' },
        400
      );
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

      // Registry keys keep the spelling their writer used, so a direct key
      // lookup can miss an entry for the same deck. Scan instead and compare
      // canonical paths; target is already canonical. Skip entries on this
      // host's own port so a duplicate cannot mask another host.
      let existing: SessionEntry | undefined;
      for (const entry of await listSessions()) {
        if (entry.port === port) {
          continue;
        }
        if (await sameDeckPath(entry.path, target)) {
          existing = entry;
          break;
        }
      }
      if (existing) {
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
          const missing = (error as NodeJS.ErrnoException).code === 'ENOENT';
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
            message: validation.errors
              .map((diagnostic) => diagnostic.message)
              .join(' ')
          },
          422
        );
      }

      // close() does not take the save lock, so it can run while the reads
      // above are in flight. Check it once every await is done and stay
      // synchronous through watchFile: a closing host must not install a
      // watcher that close() already ran past.
      if (closed) {
        return c.json(
          {
            error: 'host-closing',
            message: 'The host is closing; retry after it has restarted.'
          },
          503
        );
      }

      const previousPath = filePath;
      unwatchFile(filePath, onFileChange);
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
      // A deck switch is a different document, not an edit of the current one;
      // the file path lets a dirty tab refuse to force-write into the new deck.
      broadcast('revision', { revision, source: 'external', filePath });

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

  app.post('/api/export', exportBodyLimit, async (c) => {
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: 'invalid json' }, 400);
    }
    if (body === null || typeof body !== 'object' || Array.isArray(body)) {
      return c.json({ error: 'invalid body' }, 400);
    }

    const { format, outDir } = body as {
      format?: unknown;
      outDir?: unknown;
    };
    if (format !== 'pdf' && format !== 'png' && format !== 'html') {
      return c.json(
        {
          error: 'unsupported format',
          message: 'Export format must be "html", "pdf", or "png".'
        },
        400
      );
    }
    if (outDir !== undefined && (typeof outDir !== 'string' || !outDir.trim())) {
      return c.json({ error: 'invalid outDir' }, 400);
    }

    // Rendering works on a snapshot so a slow export never blocks edits. The
    // snapshot is also what keeps the source deck untouched.
    const snapshot = await withSaveLock(async () => {
      try {
        await syncFromDisk();
      } catch (error) {
        if (isUnreadable(error)) {
          return null;
        }
        throw error;
      }
      return { html, filePath };
    });
    if (!snapshot) {
      return c.json(deckUnreadable(), 500);
    }

    const deckDir = path.dirname(path.resolve(snapshot.filePath));
    const resolvedOutDir = await resolveExportDir(deckDir, outDir as
      | string
      | undefined);
    if (!resolvedOutDir) {
      return c.json(
        {
          error: 'invalid outDir',
          message: 'outDir must stay inside the deck directory.'
        },
        400
      );
    }

    const first = detectSlides(parseDeckHtml(snapshot.html))[0];
    const basename =
      path.basename(snapshot.filePath).replace(/\.html?$/i, '') || 'deck';

    // Fixed output names make concurrent renders destructive. Serialize the
    // filesystem work per host, and re-check containment after mkdir so a
    // symlink swapped in after resolution cannot redirect the writes.
    return withExportLock(async () => {
      await mkdir(resolvedOutDir, { recursive: true });
      const [canonicalDeckDir, canonicalOutDir] = await Promise.all([
        realpath(deckDir),
        realpath(resolvedOutDir)
      ]);
      if (!isInside(canonicalDeckDir, canonicalOutDir)) {
        return c.json(
          {
            error: 'invalid outDir',
            message: 'outDir must stay inside the deck directory.'
          },
          400
        );
      }

      try {
        if (format === 'html') {
          const outPath = path.join(
            canonicalOutDir,
            `${basename}.export.html`
          );
          await writeDeckFileAtomic(
            outPath,
            serializeExport(parseDeckHtml(snapshot.html))
          );
          return c.json({ files: [outPath] });
        }
        if (format === 'pdf') {
          const outPath = path.join(canonicalOutDir, `${basename}.pdf`);
          await renderPdf({
            html: snapshot.html,
            width: first.width,
            height: first.height,
            outPath
          });
          return c.json({ files: [outPath] });
        }
        const files = await renderPngs({
          html: snapshot.html,
          width: first.width,
          height: first.height,
          outDir: canonicalOutDir,
          basename
        });
        return c.json({ files });
      } catch (error) {
        if (error instanceof RendererUnavailableError) {
          return c.json(
            {
              error: 'renderer-unavailable',
              message: error.message,
              hint: 'Install Google Chrome, Microsoft Edge or Chromium, or set HTMLPPT_CHROMIUM to its executable path.'
            },
            501
          );
        }
        if (error instanceof RenderError) {
          return c.json({ error: 'render-failed', message: error.message }, 500);
        }
        throw error;
      }
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

  app.get('/', (c) => {
    const url = new URL(c.req.url);
    c.header('Set-Cookie', tokenCookie(options.token));
    return c.redirect(
      `${friendlyDeckPath(filePath)}${queryWithoutToken(url)}`,
      302
    );
  });

  app.get('/d/:name', async (c) => {
    const url = new URL(c.req.url);
    if (!matchesDeckName(c.req.param('name'), filePath)) {
      return c.notFound();
    }
    c.header('Set-Cookie', tokenCookie(options.token));
    if (url.searchParams.has('token')) {
      return c.redirect(`${url.pathname}${queryWithoutToken(url)}`, 302);
    }
    return c.html(await renderEditor());
  });

  app.get('/d', (c) => c.notFound());
  app.get('/d/*', (c) => c.notFound());
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
  watchFile(filePath, { interval: WATCH_INTERVAL_MS }, onFileChange);

  return {
    url,
    port,
    async close() {
      if (closed) {
        return;
      }
      closed = true;
      unwatchFile(filePath, onFileChange);
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
