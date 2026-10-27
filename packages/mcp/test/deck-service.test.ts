import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { realpathSync } from 'node:fs';
import {
  mkdir,
  readFile,
  realpath,
  rename,
  rm,
  symlink,
  writeFile
} from 'node:fs/promises';
import {
  createServer as createHttpServer,
  type ServerResponse
} from 'node:http';
import { createServer, type Socket } from 'node:net';
import { basename, dirname, join } from 'node:path';
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
  DeckExportError,
  DirectDeckService,
  HOST_REQUEST_TIMEOUT_MS,
  HostDeckService,
  createDeckService
} from '../src/deck-service.js';
import { waitForSession } from '../src/deck-access.js';
import {
  HEALTH_TIMEOUT_MS,
  findLiveSession
} from '../src/host-session.js';

function canonicalPath(file: string): string {
  try {
    return realpathSync.native(file);
  } catch {
    return file;
  }
}

function canonicalList(files: string[]): string[] {
  return files.map((file) => {
    const canonical = canonicalPath(file);
    return process.platform === 'win32' || process.platform === 'darwin'
      ? canonical.toLowerCase()
      : canonical;
  });
}
import { openEventStream, type SseStream } from './sse.js';

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

interface HangingHost {
  port: number;
  close: () => Promise<void>;
}

interface StubHost {
  port: number;
  base: string;
  close: () => Promise<void>;
}

const TIMEOUT = Symbol('timeout');

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

async function connectEvents(ctx: HostContext): Promise<SseStream> {
  const response = await fetch(
    `${ctx.base}/api/events?token=${encodeURIComponent(ctx.token)}`
  );
  return openEventStream(response);
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

/**
 * Serves a scripted /api/health response and the editor shell from a real HTTP
 * server. Other routes stay unanswered, so a successful liveness probe can be
 * followed by a request that never completes.
 */
async function stubHost(
  health: (response: ServerResponse) => void,
  shell: (response: ServerResponse) => void = (response) => {
    response.writeHead(200, { 'content-type': 'text/html' });
    response.end('<div id="root">stub editor</div>');
  }
): Promise<StubHost> {
  const server = createHttpServer((request, response) => {
    if (request.url === '/api/health') {
      health(response);
      return;
    }
    const url = new URL(request.url ?? '/', 'http://127.0.0.1');
    if (url.pathname === '/' || url.pathname.startsWith('/d/')) {
      shell(response);
    }
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  if (address === null || typeof address === 'string') {
    throw new Error('The stub server did not expose a TCP port.');
  }
  return {
    port: address.port,
    base: `http://127.0.0.1:${address.port}`,
    close: async () => {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  };
}

/** Creates another spelling of a real deck path through a directory alias. */
async function aliasDeck(realDeck: string, name: string): Promise<string> {
  const aliasDirectory = join(dir, name);
  await symlink(
    dirname(realDeck),
    aliasDirectory,
    process.platform === 'win32' ? 'junction' : 'dir'
  );
  return join(aliasDirectory, basename(realDeck));
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

  it('keeps the entry when the health check times out', async () => {
    deckPath = await copyFixture('basic.deck.html', dir);
    const hanging = await hangingHost();
    try {
      const entry = staleEntry({ port: hanging.port });
      await writeSession(entry);

      const startedAt = Date.now();
      expect(await findLiveSession(deckPath)).toBeNull();

      expect(await readSession(sessionFilePath(deckPath))).toEqual(entry);
      expect(Date.now() - startedAt).toBeLessThan(HEALTH_TIMEOUT_MS + 2_000);
    } finally {
      await hanging.close();
    }
  });

  it('removes a session whose health endpoint returns 401', async () => {
    const ctx = await setupHost();
    await writeSession({
      path: deckPath,
      port: ctx.host.port,
      token: 'wrong-token',
      pid: process.pid,
      startedAt: new Date().toISOString(),
      revision: ctx.revision
    });

    expect(await findLiveSession(deckPath)).toBeNull();
    await expect(
      readFile(sessionFilePath(deckPath), 'utf8')
    ).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('keeps the entry when the health endpoint returns 5xx', async () => {
    deckPath = await copyFixture('basic.deck.html', dir);
    const failing = await stubHost((response) => {
      response.writeHead(503, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ error: 'deck-unreadable' }));
    });
    try {
      const entry = staleEntry({ port: failing.port });
      await writeSession(entry);

      expect(await findLiveSession(deckPath)).toBeNull();
      expect(await readSession(sessionFilePath(deckPath))).toEqual(entry);
    } finally {
      await failing.close();
    }
  });

  it('removes a session when the health endpoint returns 404', async () => {
    deckPath = await copyFixture('basic.deck.html', dir);
    const missing = await stubHost((response) => {
      response.writeHead(404, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ error: 'not-found' }));
    });
    try {
      await writeSession(staleEntry({ port: missing.port }));

      expect(await findLiveSession(deckPath)).toBeNull();
      await expect(
        readFile(sessionFilePath(deckPath), 'utf8')
      ).rejects.toMatchObject({ code: 'ENOENT' });
    } finally {
      await missing.close();
    }
  });

  it('removes a session whose health payload is malformed', async () => {
    deckPath = await copyFixture('basic.deck.html', dir);
    const malformed = await stubHost((response) => {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ ok: 'yes' }));
    });
    try {
      await writeSession(staleEntry({ port: malformed.port }));

      expect(await findLiveSession(deckPath)).toBeNull();
      await expect(
        readFile(sessionFilePath(deckPath), 'utf8')
      ).rejects.toMatchObject({ code: 'ENOENT' });
    } finally {
      await malformed.close();
    }
  });

  it('removes a registry entry that points at a different path', async () => {
    deckPath = await copyFixture('basic.deck.html', dir);
    const otherPath = join(dir, 'other.deck.html');
    await mkdir(join(dir, 'home', 'sessions'), { recursive: true });
    await writeFile(
      sessionFilePath(deckPath),
      JSON.stringify(staleEntry({ path: otherPath })),
      'utf8'
    );

    expect(await findLiveSession(deckPath)).toBeNull();
    await expect(
      readFile(sessionFilePath(deckPath), 'utf8')
    ).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('finds a live session through a directory alias', async () => {
    const realDirectory = join(dir, 'real-deck');
    await mkdir(realDirectory);
    // The registry keeps the writer's spelling (here, the real directory);
    // looking up an alias falls back to comparing entries by realpath.
    const canonicalDirectory = await realpath(realDirectory);
    const realDeck = join(canonicalDirectory, 'deck.html');
    await rename(await copyFixture('basic.deck.html', realDirectory), realDeck);
    const aliasDirectory = join(dir, 'alias-deck');
    await symlink(
      realDirectory,
      aliasDirectory,
      process.platform === 'win32' ? 'junction' : 'dir'
    );
    const aliasDeck = join(aliasDirectory, 'deck.html');
    const healthy = await stubHost((response) => {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ ok: true }));
    });
    try {
      const entry = staleEntry({ path: realDeck, port: healthy.port });
      await writeSession(entry);

      const found = await findLiveSession(aliasDeck);

      expect(found).toEqual(entry);
      expect(await readSession(sessionFilePath(realDeck))).toEqual(entry);
      await expect(
        readFile(sessionFilePath(aliasDeck), 'utf8')
      ).rejects.toMatchObject({ code: 'ENOENT' });
    } finally {
      await healthy.close();
    }
  });

  it('finds a live session written under the alias spelling by its real path', async () => {
    const realDirectory = join(dir, 'real-alias-write');
    await mkdir(realDirectory);
    const canonicalDirectory = await realpath(realDirectory);
    const realDeck = join(canonicalDirectory, 'deck.html');
    await rename(await copyFixture('basic.deck.html', realDirectory), realDeck);
    const aliasDirectory = join(dir, 'alias-alias-write');
    await symlink(
      realDirectory,
      aliasDirectory,
      process.platform === 'win32' ? 'junction' : 'dir'
    );
    const aliasDeck = join(aliasDirectory, 'deck.html');
    const healthy = await stubHost((response) => {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ ok: true }));
    });
    try {
      const entry = staleEntry({ path: aliasDeck, port: healthy.port });
      await writeSession(entry);

      const found = await findLiveSession(realDeck);

      expect(found).toEqual(entry);
      // The scan must not move or duplicate the entry: its key keeps the
      // spelling the writer used.
      expect(await readSession(sessionFilePath(aliasDeck))).toEqual(entry);
      await expect(
        readFile(sessionFilePath(realDeck), 'utf8')
      ).rejects.toMatchObject({ code: 'ENOENT' });
    } finally {
      await healthy.close();
    }
  });

  it('removes an unhealthy session found through an alias spelling', async () => {
    const realDirectory = join(dir, 'real-unhealthy-alias');
    await mkdir(realDirectory);
    const canonicalDirectory = await realpath(realDirectory);
    const realDeck = join(canonicalDirectory, 'deck.html');
    await rename(await copyFixture('basic.deck.html', realDirectory), realDeck);
    const aliasDirectory = join(dir, 'alias-unhealthy');
    await symlink(
      realDirectory,
      aliasDirectory,
      process.platform === 'win32' ? 'junction' : 'dir'
    );
    const aliasDeck = join(aliasDirectory, 'deck.html');
    const unrelatedDeck = join(dir, 'unrelated.html');
    const unrelated = staleEntry({ path: unrelatedDeck });
    const mismatched = await stubHost((response) => {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(
        JSON.stringify({
          ok: true,
          filePath: join(dir, 'other-health.html')
        })
      );
    });
    try {
      await writeSession(unrelated);
      await writeSession(staleEntry({ path: aliasDeck, port: mismatched.port }));

      expect(await findLiveSession(realDeck)).toBeNull();
      await expect(
        readFile(sessionFilePath(aliasDeck), 'utf8')
      ).rejects.toMatchObject({ code: 'ENOENT' });
      // Unrelated registry entries are never pruned by the scan.
      expect(await readSession(sessionFilePath(unrelatedDeck))).toEqual(
        unrelated
      );
    } finally {
      await mismatched.close();
    }
  });

  it('finds a live session for a missing deck under a directory alias', async () => {
    const realDirectory = join(dir, 'real-missing');
    await mkdir(realDirectory);
    const canonicalDirectory = await realpath(realDirectory);
    const missingDeck = join(canonicalDirectory, 'deleted.html');
    const aliasDirectory = join(dir, 'alias-missing');
    await symlink(
      realDirectory,
      aliasDirectory,
      process.platform === 'win32' ? 'junction' : 'dir'
    );
    const healthy = await stubHost((response) => {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ ok: true, filePath: missingDeck }));
    });
    try {
      const entry = staleEntry({ path: missingDeck, port: healthy.port });
      await writeSession(entry);

      const found = await findLiveSession(
        join(aliasDirectory, 'deleted.html')
      );

      expect(found).toEqual(entry);
      expect(await readSession(sessionFilePath(missingDeck))).toEqual(entry);
    } finally {
      await healthy.close();
    }
  });

  it('removes a session whose health payload reports a different deck', async () => {
    deckPath = await copyFixture('basic.deck.html', dir);
    const otherDeck = join(dir, 'other-health.html');
    const mismatched = await stubHost((response) => {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ ok: true, filePath: otherDeck }));
    });
    try {
      await writeSession(staleEntry({ port: mismatched.port }));

      expect(await findLiveSession(deckPath)).toBeNull();
      await expect(
        readFile(sessionFilePath(deckPath), 'utf8')
      ).rejects.toMatchObject({ code: 'ENOENT' });
    } finally {
      await mismatched.close();
    }
  });

  it('returns the healthy duplicate after scanning past an unhealthy one', async () => {
    const realDirectory = join(dir, 'scan-unhealthy-real');
    await mkdir(realDirectory);
    const realDeck = await realpath(
      await copyFixture('basic.deck.html', realDirectory)
    );
    const firstDeck = await aliasDeck(realDeck, 'scan-unhealthy-a');
    const secondDeck = await aliasDeck(realDeck, 'scan-unhealthy-b');
    const unhealthy = await stubHost((response) => {
      response.writeHead(401, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ error: 'unauthorized' }));
    });
    const healthy = await stubHost((response) => {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ ok: true }));
    });
    try {
      // Entries sort by path, so scan-unhealthy-a is checked first.
      const first = staleEntry({ path: firstDeck, port: unhealthy.port });
      const second = staleEntry({ path: secondDeck, port: healthy.port });
      await writeSession(first);
      await writeSession(second);

      const found = await findLiveSession(realDeck);

      expect(found).toEqual(second);
      await expect(
        readFile(sessionFilePath(firstDeck), 'utf8')
      ).rejects.toMatchObject({ code: 'ENOENT' });
      expect(await readSession(sessionFilePath(secondDeck))).toEqual(second);
    } finally {
      await unhealthy.close();
      await healthy.close();
    }
  });

  it('keeps a busy duplicate and returns a healthy one later in the scan', async () => {
    const realDirectory = join(dir, 'scan-busy-real');
    await mkdir(realDirectory);
    const realDeck = await realpath(
      await copyFixture('basic.deck.html', realDirectory)
    );
    const firstDeck = await aliasDeck(realDeck, 'scan-busy-a');
    const secondDeck = await aliasDeck(realDeck, 'scan-busy-b');
    const busy = await stubHost((response) => {
      response.writeHead(503, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ error: 'deck-unreadable' }));
    });
    const healthy = await stubHost((response) => {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ ok: true }));
    });
    try {
      const first = staleEntry({ path: firstDeck, port: busy.port });
      const second = staleEntry({ path: secondDeck, port: healthy.port });
      await writeSession(first);
      await writeSession(second);

      const found = await findLiveSession(realDeck);

      expect(found).toEqual(second);
      expect(await readSession(sessionFilePath(firstDeck))).toEqual(first);
      expect(await readSession(sessionFilePath(secondDeck))).toEqual(second);
    } finally {
      await busy.close();
      await healthy.close();
    }
  });

  it('continues to the registry scan when the direct entry is unhealthy', async () => {
    const realDirectory = join(dir, 'scan-direct-real');
    await mkdir(realDirectory);
    const directDeck = await realpath(
      await copyFixture('basic.deck.html', realDirectory)
    );
    const alias = await aliasDeck(directDeck, 'scan-direct-alias');
    const unhealthy = await stubHost((response) => {
      response.writeHead(401, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ error: 'unauthorized' }));
    });
    const healthy = await stubHost((response) => {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ ok: true }));
    });
    try {
      const direct = staleEntry({ path: directDeck, port: unhealthy.port });
      const aliasEntry = staleEntry({ path: alias, port: healthy.port });
      await writeSession(direct);
      await writeSession(aliasEntry);

      const found = await findLiveSession(directDeck);

      expect(found).toEqual(aliasEntry);
      await expect(
        readFile(sessionFilePath(directDeck), 'utf8')
      ).rejects.toMatchObject({ code: 'ENOENT' });
      expect(await readSession(sessionFilePath(alias))).toEqual(aliasEntry);
    } finally {
      await unhealthy.close();
      await healthy.close();
    }
  });

  it('does not remove a fresh entry when a listed candidate goes stale', async () => {
    const realDirectory = join(dir, 'scan-stale-real');
    await mkdir(realDirectory);
    const realDeck = await realpath(
      await copyFixture('basic.deck.html', realDirectory)
    );
    const alias = await aliasDeck(realDeck, 'scan-stale-alias');
    const healthy = await stubHost((response) => {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ ok: true }));
    });
    const fresh = staleEntry({
      path: alias,
      port: healthy.port,
      token: 'fresh-token'
    });
    const staleHost = await stubHost(async (response) => {
      // Replace the listed entry while its health check is in flight.
      await writeSession(fresh);
      response.writeHead(401, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ error: 'unauthorized' }));
    });
    try {
      const stale = staleEntry({
        path: alias,
        port: staleHost.port,
        token: 'stale-token'
      });
      await writeSession(stale);

      expect(await findLiveSession(realDeck)).toBeNull();

      // The stale snapshot must not delete the fresh valid entry.
      expect(await readSession(sessionFilePath(alias))).toEqual(fresh);
      expect(await findLiveSession(realDeck)).toEqual(fresh);
    } finally {
      await staleHost.close();
      await healthy.close();
    }
  });
});

describe('waitForSession', () => {
  it('rejects a live host whose editor shell is broken and keeps its entry', async () => {
    deckPath = await copyFixture('basic.deck.html', dir);
    const broken = await stubHost(
      (response) => {
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ ok: true }));
      },
      (response) => {
        response.writeHead(500, { 'content-type': 'text/plain' });
        response.end('editor build missing');
      }
    );
    try {
      const entry = staleEntry({ port: broken.port });
      await writeSession(entry);

      // Health alone answers for this deck; only the shell proves the URL
      // would open an editor. The host must not be reported as a success.
      await expect(waitForSession(deckPath)).rejects.toMatchObject({
        code: 'editor-timeout'
      });

      // The process is alive and owns the deck, so `stop` must still reach it.
      expect(await readSession(sessionFilePath(deckPath))).toEqual(entry);
    } finally {
      await broken.close();
    }
  });

  it('reports the spawned CLI exit code and a placeholder suggestion', async () => {
    deckPath = await copyFixture('basic.deck.html', dir);

    let failure: { code?: string; message?: string } = {};
    try {
      await waitForSession(deckPath, { exitCode: 1, signalCode: null });
      throw new Error('Expected the spawned CLI exit to reject the wait.');
    } catch (error) {
      failure = error as { code?: string; message?: string };
    }

    expect(failure).toMatchObject({ code: 'editor-failed' });
    const message = failure.message ?? '';
    expect(message).toContain(
      `exited with code 1 before publishing a session for ${deckPath}`
    );
    expect(message).toContain(
      'Run "htmlppt open <path> --no-browser" in a terminal to see the error.'
    );
    // The suggestion is a template, not a command built from an unquoted path.
    expect(message).not.toContain(`htmlppt open ${deckPath} --no-browser`);
  });

  it('reports a spawned CLI signal and a placeholder suggestion', async () => {
    deckPath = await copyFixture('basic.deck.html', dir);

    let failure: { code?: string; message?: string } = {};
    try {
      await waitForSession(deckPath, { exitCode: null, signalCode: 'SIGTERM' });
      throw new Error('Expected the spawned CLI signal to reject the wait.');
    } catch (error) {
      failure = error as { code?: string; message?: string };
    }

    expect(failure).toMatchObject({ code: 'editor-failed' });
    const message = failure.message ?? '';
    expect(message).toContain(
      `terminated by SIGTERM before publishing a session for ${deckPath}`
    );
    expect(message).toContain(
      'Run "htmlppt open <path> --no-browser" in a terminal to see the error.'
    );
    expect(message).not.toContain(`htmlppt open ${deckPath} --no-browser`);
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
        data: {
          revision: result.revision,
          source: 'mcp',
          filePath: deckPath
        }
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

  it('falls back to direct mode without removing a busy session', async () => {
    deckPath = await copyFixture('basic.deck.html', dir);
    const hanging = await hangingHost();
    try {
      const entry = staleEntry({ port: hanging.port });
      await writeSession(entry);

      const service = await createDeckService(deckPath);

      expect(service).toBeInstanceOf(DirectDeckService);
      expect(await readSession(sessionFilePath(deckPath))).toEqual(entry);
      const snapshot = await service.load(deckPath);
      const result = await service.save(deckPath, snapshot, (draft) => {
        setText(requireElement(draft, '[data-ppt-el="e1"]'), 'Direct while busy');
      });
      expect(await readFile(deckPath, 'utf8')).toContain('Direct while busy');
      expect(result.revision).toBe(
        hashHtml(await readFile(deckPath, 'utf8'))
      );
    } finally {
      await hanging.close();
    }
  });

  it('times out a host that stops answering after the health check', async () => {
    deckPath = await copyFixture('basic.deck.html', dir);
    const stalled = await stubHost((response) => {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ ok: true }));
    });
    try {
      await writeSession(staleEntry({ port: stalled.port }));

      const service = await createDeckService(deckPath);
      expect(service).toBeInstanceOf(HostDeckService);

      const startedAt = Date.now();
      const outcome = await withTimeout(
        service.load(deckPath).then(
          () => null,
          (error: unknown) => error as Error
        ),
        HOST_REQUEST_TIMEOUT_MS + 2_000
      );
      const elapsed = Date.now() - startedAt;
      if (outcome === TIMEOUT) {
        throw new Error('The host request did not time out.');
      }
      expect(outcome).toBeInstanceOf(Error);
      expect((outcome as Error).message).toMatch(/timed out/i);
      expect(elapsed).toBeLessThan(HOST_REQUEST_TIMEOUT_MS + 2_000);
    } finally {
      await stalled.close();
    }
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

  it('forces direct mode even with explicit host options', async () => {
    const ctx = await setupHost();
    process.env.HTMLPPT_MCP_MODE = 'direct';

    const service = await createDeckService(deckPath, {
      hostUrl: ctx.base,
      token: ctx.token
    });

    expect(service).toBeInstanceOf(DirectDeckService);
    expect(
      await createDeckService(deckPath, { hostUrl: ctx.base })
    ).toBeInstanceOf(DirectDeckService);
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

describe('DeckService export', () => {
  it(
    'renders PDF and PNG files to an explicit directory',
    async () => {
      deckPath = await copyFixture('basic.deck.html', dir);
      const original = await readFile(deckPath, 'utf8');
      const outDir = join(dir, 'renders');
      const service = new DirectDeckService();

      const pdfFiles = await service.exportFiles(deckPath, 'pdf', outDir);
      expect(canonicalList(pdfFiles)).toEqual(
        canonicalList([join(outDir, 'basic.deck.pdf')])
      );
      expect(
        (await readFile(pdfFiles[0]!)).subarray(0, 5).toString('latin1')
      ).toBe('%PDF-');

      const pngFiles = await service.exportFiles(deckPath, 'png', outDir);
      expect(canonicalList(pngFiles)).toEqual(
        canonicalList([
          join(outDir, 'basic.deck-s1.png'),
          join(outDir, 'basic.deck-s2.png')
        ])
      );
      for (const file of pngFiles) {
        expect((await readFile(file)).subarray(0, 8)).toEqual(
          Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
        );
      }
      expect(await readFile(deckPath, 'utf8')).toBe(original);
    },
    120_000
  );

  it(
    'reports an unavailable renderer as a structured export error',
    async () => {
      deckPath = await copyFixture('basic.deck.html', dir);
      const previous = process.env.HTMLPPT_CHROMIUM;
      process.env.HTMLPPT_CHROMIUM = join(dir, 'missing-browser.exe');
      try {
        const error = await rejection(
          new DirectDeckService().exportFiles(deckPath, 'pdf', join(dir, 'out'))
        );
        expect(error).toBeInstanceOf(DeckExportError);
        expect((error as DeckExportError).code).toBe('renderer-unavailable');
        expect(error.message).toContain('HTMLPPT_CHROMIUM');
      } finally {
        if (previous === undefined) delete process.env.HTMLPPT_CHROMIUM;
        else process.env.HTMLPPT_CHROMIUM = previous;
      }
    },
    30_000
  );

  it(
    'exports through the host and keeps its outDir confinement',
    async () => {
      const ctx = await setupHost();
      const service = new HostDeckService({
        hostUrl: ctx.base,
        token: ctx.token
      });

      const files = await service.exportFiles(
        deckPath,
        'pdf',
        join(dir, 'host-renders')
      );
      expect(canonicalList(files)).toEqual(
        canonicalList([join(dir, 'host-renders', 'basic.deck.pdf')])
      );
      expect((await readFile(files[0]!)).subarray(0, 5).toString('latin1')).toBe(
        '%PDF-'
      );

      const outside = join(dir, '..', `outside-${randomUUID()}`);
      const error = await rejection(
        service.exportFiles(deckPath, 'pdf', outside)
      );
      expect(error).toBeInstanceOf(DeckExportError);
      expect((error as DeckExportError).code).toBe('export-failed');
      expect(error.message).toContain('inside the deck directory');
    },
    30_000
  );
});
