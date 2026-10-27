import { mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { createServer, type IncomingMessage } from 'node:http';
import { join } from 'node:path';
import {
  readSession,
  sessionKey,
  sessionsDirectory,
  writeSession,
  type SessionEntry
} from '@htmlppt/host';
import { makeTempDir } from '@htmlppt/test-utils';
import { describe, expect, it } from 'vitest';
import {
  findLiveSession,
  findStoppableSession,
  lookupRegisteredSession,
  probeSessionHealth
} from '../src/host-session.js';

interface FakeReply {
  status: number;
  type: string;
  body: string;
  headers?: Record<string, string>;
}

function demoEntry(port: number): SessionEntry {
  return {
    path: '/decks/demo.html',
    port,
    token: 'secret',
    pid: process.pid,
    startedAt: '2026-10-25T00:00:00.000Z',
    revision: 'a'.repeat(64)
  };
}

function entryFor(port: number, deckPath: string): SessionEntry {
  return { ...demoEntry(port), path: deckPath };
}

function healthPayload(filePath = '/decks/demo.html'): string {
  return JSON.stringify({
    ok: true,
    revision: 'r',
    version: '0.0.0',
    filePath
  });
}

async function listen(
  handler: (request: IncomingMessage) => FakeReply
): Promise<{ entry: SessionEntry; close: () => Promise<void> }> {
  const server = createServer((request, response) => {
    const result = handler(request);
    response.writeHead(result.status, {
      'content-type': result.type,
      ...result.headers
    });
    response.end(result.body);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('no port');
  return {
    entry: demoEntry(address.port),
    close: () =>
      new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve()))
      )
  };
}

async function fakeHost(
  handler: (path: string) => FakeReply
): Promise<{ entry: SessionEntry; close: () => Promise<void> }> {
  return listen((request) => handler(request.url ?? '/'));
}

/**
 * Answers health but never answers the shell request, so the probe has to time
 * out rather than observe a response.
 */
async function silentShellHost(filePath = '/decks/demo.html'): Promise<{
  entry: SessionEntry;
  close: () => Promise<void>;
}> {
  const server = createServer((request, response) => {
    if ((request.url ?? '/').startsWith('/api/health')) {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(healthPayload(filePath));
    }
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('no port');
  return {
    entry: demoEntry(address.port),
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      })
  };
}

interface SessionFixture {
  dir: string;
  deckPath: string;
  sessionFile: string;
  cleanup: () => Promise<void>;
}

/**
 * Gives a test its own registry home and a deck file, so session entries are
 * written where `findLiveSession` will look for them.
 */
async function sessionFixture(): Promise<SessionFixture> {
  const dir = await makeTempDir('htmlppt-mcp-session-');
  const previousHome = process.env.HTMLPPT_HOME;
  process.env.HTMLPPT_HOME = join(dir, 'home');
  const deckDirectory = join(dir, 'decks');
  await mkdir(deckDirectory);
  const deckPath = join(deckDirectory, 'demo.deck.html');
  await writeFile(deckPath, '<!doctype html><title>Deck</title>', 'utf8');
  const sessionFile = join(sessionsDirectory(), `${sessionKey(deckPath)}.json`);
  return {
    dir,
    deckPath,
    sessionFile,
    cleanup: async () => {
      if (previousHome === undefined) {
        delete process.env.HTMLPPT_HOME;
      } else {
        process.env.HTMLPPT_HOME = previousHome;
      }
      await rm(dir, { recursive: true, force: true });
    }
  };
}

async function aliasFor(fixture: SessionFixture): Promise<string> {
  const aliasDirectory = join(fixture.dir, 'alias-decks');
  await symlink(
    join(fixture.dir, 'decks'),
    aliasDirectory,
    process.platform === 'win32' ? 'junction' : 'dir'
  );
  return join(aliasDirectory, 'demo.deck.html');
}

const healthOk = healthPayload();

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

  it('reports a stale build when the editor shell is missing', async () => {
    const host = await fakeHost((path) =>
      path.startsWith('/api/health')
        ? { status: 200, type: 'application/json', body: healthOk }
        : { status: 404, type: 'text/plain', body: 'Not Found' }
    );
    try {
      expect(await probeSessionHealth(host.entry)).toBe('stale-build');
    } finally {
      await host.close();
    }
  });

  it('reports a stale build when the shell answers with a server error', async () => {
    // Health already proved the process is alive, and the document route only
    // reads the editor build. A 5xx there is a broken build, such as the
    // missing-index zombie host: the process is reachable, but not as an
    // editor. `stop` still has to be able to reach it.
    const host = await fakeHost((path) =>
      path.startsWith('/api/health')
        ? { status: 200, type: 'application/json', body: healthOk }
        : { status: 503, type: 'text/plain', body: 'busy' }
    );
    try {
      expect(await probeSessionHealth(host.entry)).toBe('stale-build');
    } finally {
      await host.close();
    }
  });

  it('reports a stale build when the shell is not HTML', async () => {
    const host = await fakeHost((path) =>
      path.startsWith('/api/health')
        ? { status: 200, type: 'application/json', body: healthOk }
        : { status: 200, type: 'text/plain', body: 'not the editor' }
    );
    try {
      expect(await probeSessionHealth(host.entry)).toBe('stale-build');
    } finally {
      await host.close();
    }
  });

  it('reports a stale build when the shell has no editor root', async () => {
    const host = await fakeHost((path) =>
      path.startsWith('/api/health')
        ? { status: 200, type: 'application/json', body: healthOk }
        : { status: 200, type: 'text/html', body: '<div id="app"></div>' }
    );
    try {
      expect(await probeSessionHealth(host.entry)).toBe('stale-build');
    } finally {
      await host.close();
    }
  });

  it('stays unknown when the shell request times out', async () => {
    const host = await silentShellHost();
    try {
      expect(await probeSessionHealth(host.entry)).toBe('unknown');
    } finally {
      await host.close();
    }
  });

  it('reports a stale build when the shell connection drops after health', async () => {
    // Health answered for this deck, so the process is not a stranger. A
    // transport failure while fetching the shell cannot make the entry
    // `unhealthy`; the reachable host stays stoppable instead.
    const server = createServer((request, response) => {
      if ((request.url ?? '/').startsWith('/api/health')) {
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(healthPayload());
        return;
      }
      request.socket.destroy();
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('no port');
    try {
      expect(await probeSessionHealth(demoEntry(address.port))).toBe(
        'stale-build'
      );
    } finally {
      await new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      });
    }
  });

  it('is unhealthy when health rejects the token', async () => {
    const host = await fakeHost(() => ({
      status: 401,
      type: 'application/json',
      body: JSON.stringify({ error: 'unauthorized' })
    }));
    try {
      expect(await probeSessionHealth(host.entry)).toBe('unhealthy');
    } finally {
      await host.close();
    }
  });

  it('follows the tokenized redirect and authorizes the document request', async () => {
    const host = await listen((request) => {
      const url = request.url ?? '/';
      if (url.startsWith('/api/health')) {
        return { status: 200, type: 'application/json', body: healthOk };
      }
      if (url.startsWith('/?token=')) {
        return {
          status: 302,
          type: 'text/html',
          body: '',
          headers: {
            location: '/d/demo.html',
            'set-cookie':
              'htmlppt_token=secret; HttpOnly; SameSite=Strict; Path=/'
          }
        };
      }
      if (request.headers.cookie === 'htmlppt_token=secret') {
        return {
          status: 200,
          type: 'text/html',
          body: '<div id="root"></div>'
        };
      }
      return { status: 401, type: 'text/plain', body: 'Unauthorized' };
    });
    try {
      expect(await probeSessionHealth(host.entry)).toBe('healthy');
    } finally {
      await host.close();
    }
  });
});

describe('lookupRegisteredSession', () => {
  it('reports an unhealthy entry with its snapshot and leaves pruning to findLiveSession', async () => {
    const fixture = await sessionFixture();
    const host = await fakeHost((path) =>
      path.startsWith('/api/health')
        ? {
            status: 401,
            type: 'application/json',
            body: JSON.stringify({ error: 'unauthorized' })
          }
        : { status: 404, type: 'text/plain', body: 'Not Found' }
    );
    try {
      const entry = entryFor(host.entry.port, fixture.deckPath);
      await writeSession(entry);
      const snapshot = await readFile(fixture.sessionFile, 'utf8');

      const registered = await lookupRegisteredSession(fixture.deckPath);

      expect(registered).toEqual({ entry, snapshot, health: 'unhealthy' });
      // `open` needs the entry and its snapshot, so a health verdict must not
      // delete it here.
      expect(await readFile(fixture.sessionFile, 'utf8')).toBe(snapshot);

      expect(await findLiveSession(fixture.deckPath)).toBeNull();
      await expect(
        readFile(fixture.sessionFile, 'utf8')
      ).rejects.toMatchObject({ code: 'ENOENT' });
    } finally {
      await host.close();
      await fixture.cleanup();
    }
  });

  it('reports a stale build and keeps the entry for a live host that cannot serve the editor', async () => {
    const fixture = await sessionFixture();
    const host = await fakeHost((path) =>
      path.startsWith('/api/health')
        ? {
            status: 200,
            type: 'application/json',
            body: healthPayload(fixture.deckPath)
          }
        : { status: 500, type: 'text/plain', body: 'broken editor build' }
    );
    try {
      const entry = entryFor(host.entry.port, fixture.deckPath);
      await writeSession(entry);
      const snapshot = await readFile(fixture.sessionFile, 'utf8');

      const registered = await lookupRegisteredSession(fixture.deckPath);

      expect(registered).toEqual({ entry, snapshot, health: 'stale-build' });
      // The host answered health for this deck, so the entry must survive the
      // verdict: `stop` needs it to reach the process and rotate the token.
      expect(await readFile(fixture.sessionFile, 'utf8')).toBe(snapshot);
    } finally {
      await host.close();
      await fixture.cleanup();
    }
  });
});

describe('findLiveSession', () => {
  it('keeps a stale-build entry so stop can still reach the host', async () => {
    const fixture = await sessionFixture();
    const host = await fakeHost((path) =>
      path.startsWith('/api/health')
        ? {
            status: 200,
            type: 'application/json',
            body: healthPayload(fixture.deckPath)
          }
        : { status: 404, type: 'text/plain', body: 'Not Found' }
    );
    try {
      const entry = entryFor(host.entry.port, fixture.deckPath);
      await writeSession(entry);

      expect(await findLiveSession(fixture.deckPath)).toBeNull();
      expect(await readSession(fixture.sessionFile)).toEqual(entry);
    } finally {
      await host.close();
      await fixture.cleanup();
    }
  });

  it('keeps an entry when the editor shell times out', async () => {
    const fixture = await sessionFixture();
    const host = await silentShellHost(fixture.deckPath);
    try {
      const entry = entryFor(host.entry.port, fixture.deckPath);
      await writeSession(entry);

      expect(await findLiveSession(fixture.deckPath)).toBeNull();
      expect(await readSession(fixture.sessionFile)).toEqual(entry);
    } finally {
      await host.close();
      await fixture.cleanup();
    }
  });

  it('removes an entry whose health rejects the token', async () => {
    const fixture = await sessionFixture();
    const host = await fakeHost(() => ({
      status: 401,
      type: 'application/json',
      body: JSON.stringify({ error: 'unauthorized' })
    }));
    try {
      await writeSession(entryFor(host.entry.port, fixture.deckPath));

      expect(await findLiveSession(fixture.deckPath)).toBeNull();
      await expect(
        readFile(fixture.sessionFile, 'utf8')
      ).rejects.toMatchObject({ code: 'ENOENT' });
    } finally {
      await host.close();
      await fixture.cleanup();
    }
  });

  it('keeps a stale-build entry registered under an alias spelling', async () => {
    const fixture = await sessionFixture();
    const aliasPath = await aliasFor(fixture);
    const host = await fakeHost((path) =>
      path.startsWith('/api/health')
        ? { status: 200, type: 'application/json', body: healthPayload(aliasPath) }
        : { status: 500, type: 'text/plain', body: 'broken editor build' }
    );
    const aliasSessionFile = join(
      sessionsDirectory(),
      `${sessionKey(aliasPath)}.json`
    );
    try {
      const entry = entryFor(host.entry.port, aliasPath);
      await writeSession(entry);

      expect(await findLiveSession(fixture.deckPath)).toBeNull();
      expect(await readSession(aliasSessionFile)).toEqual(entry);
    } finally {
      await host.close();
      await fixture.cleanup();
    }
  });
});

describe('findStoppableSession', () => {
  it('prefers a healthy entry over a stale-build one for the same deck', async () => {
    const fixture = await sessionFixture();
    const aliasPath = await aliasFor(fixture);
    // The alias spelling sorts first, so the scan meets the stale-build
    // fallback before the healthy entry and has to keep looking.
    const stale = await fakeHost((path) =>
      path.startsWith('/api/health')
        ? { status: 200, type: 'application/json', body: healthPayload(aliasPath) }
        : { status: 500, type: 'text/plain', body: 'broken editor build' }
    );
    const healthy = await fakeHost((path) =>
      path.startsWith('/api/health')
        ? {
            status: 200,
            type: 'application/json',
            body: healthPayload(fixture.deckPath)
          }
        : { status: 200, type: 'text/html', body: '<div id="root"></div>' }
    );
    const staleEntry = entryFor(stale.entry.port, aliasPath);
    const healthyEntry = entryFor(healthy.entry.port, fixture.deckPath);
    const aliasSessionFile = join(
      sessionsDirectory(),
      `${sessionKey(aliasPath)}.json`
    );
    try {
      await writeSession(staleEntry);
      await writeSession(healthyEntry);
      const snapshot = await readFile(fixture.sessionFile, 'utf8');

      const result = await findStoppableSession(fixture.deckPath);

      expect(result).toEqual({
        entry: healthyEntry,
        snapshot,
        health: 'healthy'
      });
      // The fallback is not removed: `stop` may still need it later.
      expect(await readSession(aliasSessionFile)).toEqual(staleEntry);
    } finally {
      await stale.close();
      await healthy.close();
      await fixture.cleanup();
    }
  });

  it('returns a stale-build entry with the exact snapshot bytes', async () => {
    const fixture = await sessionFixture();
    const host = await fakeHost((path) =>
      path.startsWith('/api/health')
        ? {
            status: 200,
            type: 'application/json',
            body: healthPayload(fixture.deckPath)
          }
        : { status: 500, type: 'text/plain', body: 'broken editor build' }
    );
    const entry = entryFor(host.entry.port, fixture.deckPath);
    // A hand-formatted but equivalent entry: `stop` must fence on these bytes,
    // not on a re-serialized copy, so the returned snapshot must be raw.
    const raw = JSON.stringify(entry);
    try {
      await mkdir(sessionsDirectory(), { recursive: true });
      await writeFile(fixture.sessionFile, raw, 'utf8');

      const result = await findStoppableSession(fixture.deckPath);

      expect(result).toEqual({ entry, snapshot: raw, health: 'stale-build' });
      expect(await readFile(fixture.sessionFile, 'utf8')).toBe(raw);
    } finally {
      await host.close();
      await fixture.cleanup();
    }
  });

  it('skips an unknown entry but keeps scanning for a stoppable alias', async () => {
    const fixture = await sessionFixture();
    const aliasPath = await aliasFor(fixture);
    const unknownHost = await silentShellHost(fixture.deckPath);
    const staleHost = await fakeHost((path) =>
      path.startsWith('/api/health')
        ? { status: 200, type: 'application/json', body: healthPayload(aliasPath) }
        : { status: 500, type: 'text/plain', body: 'broken editor build' }
    );
    const unknownEntry = entryFor(unknownHost.entry.port, fixture.deckPath);
    const staleEntry = entryFor(staleHost.entry.port, aliasPath);
    try {
      await writeSession(unknownEntry);
      await writeSession(staleEntry);

      const result = await findStoppableSession(fixture.deckPath);

      expect(result?.health).toBe('stale-build');
      expect(result?.entry.path).toBe(aliasPath);
      // A busy host may recover, so its entry survives the scan for a retry.
      expect(await readSession(fixture.sessionFile)).toEqual(unknownEntry);
    } finally {
      await unknownHost.close();
      await staleHost.close();
      await fixture.cleanup();
    }
  });

  it('finds a stale-build entry through a directory alias by canonical path', async () => {
    const fixture = await sessionFixture();
    const aliasPath = await aliasFor(fixture);
    const host = await fakeHost((path) =>
      path.startsWith('/api/health')
        ? {
            status: 200,
            type: 'application/json',
            body: healthPayload(fixture.deckPath)
          }
        : { status: 500, type: 'text/plain', body: 'broken editor build' }
    );
    const entry = entryFor(host.entry.port, fixture.deckPath);
    try {
      await writeSession(entry);
      const snapshot = await readFile(fixture.sessionFile, 'utf8');

      // The caller's spelling has no registry key of its own, so only the
      // canonical-path comparison can reach the entry.
      const result = await findStoppableSession(aliasPath);

      expect(result).toEqual({ entry, snapshot, health: 'stale-build' });
      expect(await readSession(fixture.sessionFile)).toEqual(entry);
    } finally {
      await host.close();
      await fixture.cleanup();
    }
  });
});
