import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer, type Socket } from 'node:net';
import { join } from 'node:path';
import {
  DeckMutationError,
  addSlide,
  deleteSlide,
  setText,
  validateDeck
} from '@htmlppt/core';
import { hashHtml, parseDeckHtml, readDeckFile } from '@htmlppt/core/node';
import {
  readSession,
  sessionKey,
  sessionsDirectory,
  startHost,
  writeSession,
  type HostHandle,
  type SessionEntry
} from '@htmlppt/host';
import { copyFixture, makeTempDir } from '@htmlppt/test-utils';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  DeckConflictError,
  DirectDeckService,
  HostDeckService,
  createDeckService
} from '../src/deck-service.js';
import { findLiveSession } from '../src/host-session.js';

interface HostContext {
  host: HostHandle;
  base: string;
  token: string;
  revision: string;
}

let dir: string;
let deckPath: string;
let host: HostHandle | undefined;
let previousHome: string | undefined;
let previousMode: string | undefined;

interface SseEvent {
  event: string;
  data: Record<string, unknown>;
}

interface HangingHost {
  port: number;
  close: () => Promise<void>;
}

const TIMEOUT = Symbol('timeout');
const SSE_TIMEOUT_MS = 5_000;

function requireElement(root: ParentNode, selector: string): Element {
  const element = root.querySelector(selector);
  if (!element) {
    throw new Error(`Expected "${selector}" to match an element.`);
  }
  return element;
}

async function rejection(promise: Promise<unknown>): Promise<Error> {
  try {
    await promise;
  } catch (error) {
    return error as Error;
  }
  throw new Error('Expected the promise to reject.');
}

function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number
): Promise<T | typeof TIMEOUT> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<typeof TIMEOUT>((resolve) => {
    timer = setTimeout(() => resolve(TIMEOUT), timeoutMs);
    timer.unref();
  });
  return Promise.race([promise, timeout]).finally(() => {
    if (timer) {
      clearTimeout(timer);
    }
  });
}

/** Minimal SSE reader with a bounded wait for each event. */
class SseStream {
  private readonly reader: ReadableStreamDefaultReader<Uint8Array>;
  private readonly decoder = new TextDecoder();
  private buffer = '';
  private readonly queue: SseEvent[] = [];
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
        throw new Error(
          `Timed out after ${timeoutMs} ms waiting for an SSE event.`
        );
      }
      const result = await withTimeout(this.reader.read(), remaining);
      if (result === TIMEOUT) {
        throw new Error(
          `Timed out after ${timeoutMs} ms waiting for an SSE event.`
        );
      }
      if (result.done) {
        this.ended = true;
        continue;
      }
      this.buffer += this.decoder.decode(result.value, { stream: true });
      this.drain();
    }
  }

  async close(): Promise<void> {
    await this.reader.cancel().catch(() => undefined);
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
      const parsed: unknown = JSON.parse(data.join('\n'));
      if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
        throw new Error('The SSE data is not a JSON object.');
      }
      this.queue.push({
        event: eventName,
        data: parsed as Record<string, unknown>
      });
    }
  }
}

async function connectEvents(ctx: HostContext): Promise<SseStream> {
  const response = await fetch(
    `${ctx.base}/api/events?token=${encodeURIComponent(ctx.token)}`
  );
  if (!response.ok || !response.body) {
    throw new Error(`Failed to open the event stream: ${response.status}`);
  }
  return new SseStream(response.body.getReader());
}

function sessionFilePath(filePath: string): string {
  return join(sessionsDirectory(), `${sessionKey(filePath)}.json`);
}

function staleEntry(overrides: Partial<SessionEntry> = {}): SessionEntry {
  return {
    path: deckPath,
    port: 43123,
    token: 'stale-token',
    pid: process.pid,
    startedAt: '2026-10-22T00:00:00.000Z',
    revision: 'a'.repeat(64),
    ...overrides
  };
}

async function writeHostSession(ctx: HostContext): Promise<SessionEntry> {
  const entry: SessionEntry = {
    path: deckPath,
    port: ctx.host.port,
    token: ctx.token,
    pid: process.pid,
    startedAt: new Date().toISOString(),
    revision: ctx.revision
  };
  await writeSession(entry);
  return entry;
}

async function exitedPid(): Promise<number> {
  const child = spawn(process.execPath, ['-e', ''], { stdio: 'ignore' });
  const pid = child.pid;
  if (pid === undefined) {
    throw new Error('Failed to spawn a short-lived process.');
  }
  await new Promise<void>((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', () => resolve());
  });
  return pid;
}

async function closedPort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  if (address === null || typeof address === 'string') {
    throw new Error('The probe server did not expose a TCP port.');
  }
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
  return address.port;
}

/** Accepts TCP connections but never answers, to prove health checks time out. */
async function hangingHost(): Promise<HangingHost> {
  const sockets = new Set<Socket>();
  const server = createServer((socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  if (address === null || typeof address === 'string') {
    throw new Error('The hanging server did not expose a TCP port.');
  }
  return {
    port: address.port,
    close: async () => {
      for (const socket of sockets) {
        socket.destroy();
      }
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  };
}

async function setupHost(): Promise<HostContext> {
  const editorDir = join(dir, 'editor');
  await mkdir(editorDir);
  await writeFile(
    join(editorDir, 'index.html'),
    '<!doctype html><title>Editor</title><div id="root">editor-shell</div>',
    'utf8'
  );
  deckPath = await copyFixture('basic.deck.html', dir);
  const token = randomUUID();
  host = await startHost({ filePath: deckPath, token, editorDir, port: 0 });
  const base = new URL(host.url).origin;
  const response = await fetch(`${base}/api/deck`, {
    headers: { authorization: `Bearer ${token}` }
  });
  if (!response.ok) {
    throw new Error(`Failed to read the deck from the host: ${response.status}`);
  }
  const payload = (await response.json()) as { revision: string };
  return { host, base, token, revision: payload.revision };
}

beforeEach(async () => {
  dir = await makeTempDir('htmlppt-mcp-');
  previousHome = process.env.HTMLPPT_HOME;
  previousMode = process.env.HTMLPPT_MCP_MODE;
  process.env.HTMLPPT_HOME = join(dir, 'home');
  delete process.env.HTMLPPT_MCP_MODE;
});

afterEach(async () => {
  try {
    await host?.close();
  } finally {
    host = undefined;
    if (previousHome === undefined) {
      delete process.env.HTMLPPT_HOME;
    } else {
      process.env.HTMLPPT_HOME = previousHome;
    }
    if (previousMode === undefined) {
      delete process.env.HTMLPPT_MCP_MODE;
    } else {
      process.env.HTMLPPT_MCP_MODE = previousMode;
    }
    await rm(dir, { recursive: true, force: true });
  }
});

describe('DirectDeckService', () => {
  it('loads a deck and normalizes missing ids in memory without writing', async () => {
    const messyPath = await copyFixture('messy.deck.html', dir);
    const original = await readFile(messyPath);
    const originalHtml = original.toString('utf8');
    const service = new DirectDeckService();

    const snapshot = await service.load(messyPath);

    expect(snapshot.filePath).toBe(messyPath);
    expect(snapshot.html).toBe(originalHtml);
    expect(snapshot.revision).toBe(hashHtml(originalHtml));
    const slides = Array.from(snapshot.document.querySelectorAll('section'));
    expect(slides.map((slide) => slide.getAttribute('data-slide-id'))).toEqual([
      's1',
      's2'
    ]);
    expect(
      requireElement(snapshot.document, 'section h1').getAttribute('data-ppt-el')
    ).toBe('e1');
    expect(await readFile(messyPath)).toEqual(original);
  });

  it('saves a mutation as normalized valid html with a new revision', async () => {
    deckPath = await copyFixture('basic.deck.html', dir);
    const original = await readFile(deckPath, 'utf8');
    const service = new DirectDeckService();
    const snapshot = await service.load(deckPath);

    const result = await service.save(deckPath, snapshot, (draft) => {
      setText(requireElement(draft, '[data-ppt-el="e1"]'), 'Edited heading');
      addSlide(draft, {
        html: '<h1>Added slide</h1>',
        notes: 'Added by the service test'
      });
    });

    expect(result.revision).not.toBe(snapshot.revision);
    expect(result.document).not.toBe(snapshot.document);
    expect(
      requireElement(snapshot.document, '[data-ppt-el="e1"]').textContent
    ).toBe('Basic deck');
    expect(result.document.querySelectorAll('[data-slide-id]').length).toBe(3);
    const saved = await readDeckFile(deckPath);
    expect(saved.hash).toBe(result.revision);
    expect(saved.html).not.toBe(original);
    expect(saved.html).toContain('Edited heading');
    expect(saved.html).toContain('Added slide');
    expect(validateDeck(parseDeckHtml(saved.html)).valid).toBe(true);
    const savedDocument = parseDeckHtml(saved.html);
    expect(savedDocument.querySelector('section h1')?.getAttribute('data-ppt-el')).toBe(
      'e1'
    );
    for (const slide of Array.from(
      savedDocument.querySelectorAll('[data-slide-id]')
    )) {
      expect(slide.getAttribute('data-slide-id')).toBeTruthy();
    }
  });

  it('rejects a stale snapshot and leaves the external file byte-identical', async () => {
    deckPath = await copyFixture('basic.deck.html', dir);
    const service = new DirectDeckService();
    const snapshot = await service.load(deckPath);
    const external = (await readFile(deckPath, 'utf8')).replace(
      'Basic deck',
      'External edit'
    );
    await writeFile(deckPath, external, 'utf8');
    const externalBytes = await readFile(deckPath);

    const error = await rejection(
      service.save(deckPath, snapshot, (draft) => {
        setText(requireElement(draft, '[data-ppt-el="e1"]'), 'MCP edit');
      })
    );

    expect(error).toBeInstanceOf(DeckConflictError);
    expect((error as DeckConflictError).code).toBe('conflict');
    expect((error as DeckConflictError).currentRevision).toBe(hashHtml(external));
    expect(await readFile(deckPath)).toEqual(externalBytes);
  });

  it('surfaces DeckMutationError and does not write', async () => {
    deckPath = await copyFixture('basic.deck.html', dir);
    const original = await readFile(deckPath);
    const snapshot = await new DirectDeckService().load(deckPath);

    const error = await rejection(
      new DirectDeckService().save(deckPath, snapshot, (draft) => {
        deleteSlide(draft, 'missing-slide');
      })
    );

    expect(error).toBeInstanceOf(DeckMutationError);
    expect((error as DeckMutationError).code).toBe('slide-not-found');
    expect(await readFile(deckPath)).toEqual(original);
  });

  it('writes raw html with compare-and-swap', async () => {
    deckPath = await copyFixture('basic.deck.html', dir);
    const service = new DirectDeckService();
    const snapshot = await service.load(deckPath);
    const next = snapshot.html.replace('Basic deck', 'Raw write');

    const result = await service.write(deckPath, next, snapshot.revision);

    expect(result.revision).toBe(hashHtml(next));
    expect(await readFile(deckPath, 'utf8')).toBe(next);

    const stale = await rejection(
      service.write(deckPath, next.replace('Raw write', 'Second write'), snapshot.revision)
    );
    expect(stale).toBeInstanceOf(DeckConflictError);
    expect((stale as DeckConflictError).currentRevision).toBe(result.revision);
    expect(await readFile(deckPath, 'utf8')).toBe(next);
  });
});

describe('HostDeckService', () => {
  it('loads and saves through a live host', async () => {
    const ctx = await setupHost();
    const service = new HostDeckService({ hostUrl: ctx.base, token: ctx.token });
    const snapshot = await service.load(deckPath);

    expect(snapshot.filePath).toBe(deckPath);
    expect(snapshot.revision).toBe(ctx.revision);
    expect(snapshot.html).toBe(await readFile(deckPath, 'utf8'));

    const result = await service.save(deckPath, snapshot, (draft) => {
      setText(requireElement(draft, '[data-ppt-el="e2"]'), 'Host edit');
      addSlide(draft, { html: '<h2>Host slide</h2>' });
    });

    expect(result.revision).not.toBe(snapshot.revision);
    expect(result.document.querySelectorAll('[data-slide-id]').length).toBe(3);
    const saved = await readDeckFile(deckPath);
    expect(saved.hash).toBe(result.revision);
    expect(saved.html).toContain('Host edit');
    expect(saved.html).toContain('Host slide');
    expect(validateDeck(parseDeckHtml(saved.html)).valid).toBe(true);
    const response = await fetch(`${ctx.base}/api/deck`, {
      headers: { authorization: `Bearer ${ctx.token}` }
    });
    const payload = (await response.json()) as { revision: string };
    expect(payload.revision).toBe(result.revision);
  });

  it('maps a stale revision to DeckConflictError and leaves the external file unchanged', async () => {
    const ctx = await setupHost();
    const service = new HostDeckService({ hostUrl: ctx.base, token: ctx.token });
    const snapshot = await service.load(deckPath);
    const external = (await readFile(deckPath, 'utf8')).replace(
      'Basic deck',
      'External host edit'
    );
    await writeFile(deckPath, external, 'utf8');
    const externalBytes = await readFile(deckPath);

    const error = await rejection(
      service.save(deckPath, snapshot, (draft) => {
        setText(requireElement(draft, '[data-ppt-el="e1"]'), 'MCP host edit');
      })
    );

    expect(error).toBeInstanceOf(DeckConflictError);
    expect((error as DeckConflictError).code).toBe('conflict');
    expect((error as DeckConflictError).currentRevision).toBe(hashHtml(external));
    expect(await readFile(deckPath)).toEqual(externalBytes);
  });

  it('writes raw html against the host revision', async () => {
    const ctx = await setupHost();
    const service = new HostDeckService({ hostUrl: ctx.base, token: ctx.token });
    const snapshot = await service.load(deckPath);
    const next = snapshot.html.replace('Basic deck', 'Host raw write');

    const result = await service.write(deckPath, next, snapshot.revision);

    expect(result.revision).toBe(hashHtml(next));
    expect(await readFile(deckPath, 'utf8')).toBe(next);

    const stale = await rejection(
      service.write(
        deckPath,
        next.replace('Host raw write', 'Host second write'),
        snapshot.revision
      )
    );
    expect(stale).toBeInstanceOf(DeckConflictError);
    expect((stale as DeckConflictError).currentRevision).toBe(result.revision);
  });
});

describe('findLiveSession', () => {
  it('returns a live, healthy session from the registry', async () => {
    const ctx = await setupHost();
    const entry = await writeHostSession(ctx);

    const found = await findLiveSession(deckPath);

    expect(found).toEqual(entry);
    expect(await readSession(sessionFilePath(deckPath))).toEqual(entry);
  });

  it('removes a session whose pid is dead and returns null', async () => {
    deckPath = await copyFixture('basic.deck.html', dir);
    const entry = staleEntry({ pid: await exitedPid() });
    await writeSession(entry);

    expect(await findLiveSession(deckPath)).toBeNull();
    await expect(
      readFile(sessionFilePath(deckPath), 'utf8')
    ).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('removes a session whose port is closed and returns null', async () => {
    deckPath = await copyFixture('basic.deck.html', dir);
    const entry = staleEntry({ port: await closedPort() });
    await writeSession(entry);

    expect(await findLiveSession(deckPath)).toBeNull();
    await expect(
      readFile(sessionFilePath(deckPath), 'utf8')
    ).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('falls back within a bounded time when the host never answers', async () => {
    deckPath = await copyFixture('basic.deck.html', dir);
    const hanging = await hangingHost();
    try {
      const entry = staleEntry({ port: hanging.port });
      await writeSession(entry);

      const startedAt = Date.now();
      expect(await findLiveSession(deckPath)).toBeNull();

      expect(Date.now() - startedAt).toBeLessThan(5_000);
      await expect(
        readFile(sessionFilePath(deckPath), 'utf8')
      ).rejects.toMatchObject({ code: 'ENOENT' });
    } finally {
      await hanging.close();
    }
  });
});

describe('createDeckService', () => {
  it('honors explicit host options', async () => {
    const ctx = await setupHost();

    const service = await createDeckService(deckPath, {
      hostUrl: ctx.base,
      token: ctx.token
    });

    expect(service).toBeInstanceOf(HostDeckService);
    const snapshot = await service.load(deckPath);
    expect(snapshot.revision).toBe(ctx.revision);
  });

  it('attaches to a live session from the registry', async () => {
    const ctx = await setupHost();
    await writeSession({
      path: deckPath,
      port: ctx.host.port,
      token: ctx.token,
      pid: process.pid,
      startedAt: new Date().toISOString(),
      revision: ctx.revision
    });

    const service = await createDeckService(deckPath);

    expect(service).toBeInstanceOf(HostDeckService);
    const snapshot = await service.load(deckPath);
    expect(snapshot.revision).toBe(ctx.revision);
  });

  it('attaches to a live session and routes saves through the host as mcp', async () => {
    const ctx = await setupHost();
    await writeHostSession(ctx);
    const service = await createDeckService(deckPath);
    expect(service).toBeInstanceOf(HostDeckService);
    const events = await connectEvents(ctx);
    try {
      expect((await events.next()).event).toBe('hello');

      const snapshot = await service.load(deckPath);
      const result = await service.save(deckPath, snapshot, (draft) => {
        setText(
          requireElement(draft, '[data-ppt-el="e1"]'),
          'Host-attached service edit'
        );
      });

      expect(result.revision).not.toBe(snapshot.revision);
      expect(await readFile(deckPath, 'utf8')).toContain(
        'Host-attached service edit'
      );
      const response = await fetch(`${ctx.base}/api/deck`, {
        headers: { authorization: `Bearer ${ctx.token}` }
      });
      const payload = (await response.json()) as { revision: string };
      expect(payload.revision).toBe(result.revision);
      expect(await events.next()).toEqual({
        event: 'revision',
        data: { revision: result.revision, source: 'mcp' }
      });
    } finally {
      await events.close();
    }
  });

  it('falls back to direct mode and removes the entry after the host stops', async () => {
    const ctx = await setupHost();
    await writeHostSession(ctx);
    host = undefined;
    await ctx.host.close();

    const service = await createDeckService(deckPath);

    expect(service).toBeInstanceOf(DirectDeckService);
    await expect(
      readFile(sessionFilePath(deckPath), 'utf8')
    ).rejects.toMatchObject({ code: 'ENOENT' });

    const snapshot = await service.load(deckPath);
    const result = await service.save(deckPath, snapshot, (draft) => {
      setText(requireElement(draft, '[data-ppt-el="e2"]'), 'Direct after stop');
    });
    expect(await readFile(deckPath, 'utf8')).toContain('Direct after stop');
    expect(result.revision).not.toBe(snapshot.revision);
  });

  it('forces direct mode with HTMLPPT_MCP_MODE=direct and keeps the session', async () => {
    const ctx = await setupHost();
    const entry = await writeHostSession(ctx);
    process.env.HTMLPPT_MCP_MODE = 'direct';

    const service = await createDeckService(deckPath);

    expect(service).toBeInstanceOf(DirectDeckService);
    expect(await readSession(sessionFilePath(deckPath))).toEqual(entry);
    const snapshot = await service.load(deckPath);
    const result = await service.save(deckPath, snapshot, (draft) => {
      setText(requireElement(draft, '[data-ppt-el="e1"]'), 'Forced direct edit');
    });
    const saved = await readFile(deckPath, 'utf8');
    expect(saved).toContain('Forced direct edit');
    expect(result.revision).toBe(hashHtml(saved));
  });

  it('allows host auto-selection for other mode values', async () => {
    const ctx = await setupHost();
    await writeHostSession(ctx);
    process.env.HTMLPPT_MCP_MODE = 'host';

    expect(await createDeckService(deckPath)).toBeInstanceOf(HostDeckService);
  });

  it('removes a stale entry and writes directly', async () => {
    deckPath = await copyFixture('basic.deck.html', dir);
    await writeSession(staleEntry({ port: await closedPort() }));

    const service = await createDeckService(deckPath);

    expect(service).toBeInstanceOf(DirectDeckService);
    await expect(
      readFile(sessionFilePath(deckPath), 'utf8')
    ).rejects.toMatchObject({ code: 'ENOENT' });
    const snapshot = await service.load(deckPath);
    const result = await service.save(deckPath, snapshot, (draft) => {
      setText(requireElement(draft, '[data-ppt-el="e1"]'), 'Stale fallback edit');
    });
    expect(result.revision).toBe(
      hashHtml(await readFile(deckPath, 'utf8'))
    );
  });

  it('falls back to direct access when no session exists', async () => {
    deckPath = await copyFixture('basic.deck.html', dir);

    const service = await createDeckService(deckPath);

    expect(service).toBeInstanceOf(DirectDeckService);
    const snapshot = await service.load(deckPath);
    expect(snapshot.revision).toBe(hashHtml(await readFile(deckPath, 'utf8')));
  });

  it('rejects partial host options', async () => {
    deckPath = await copyFixture('basic.deck.html', dir);

    await expect(
      createDeckService(deckPath, { hostUrl: 'http://127.0.0.1:1' })
    ).rejects.toThrow(/token/i);
  });
});
