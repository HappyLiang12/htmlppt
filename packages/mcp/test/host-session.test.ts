import { readFile, rm, writeFile } from 'node:fs/promises';
import { createServer, type IncomingMessage } from 'node:http';
import { join } from 'node:path';
import {
  sessionKey,
  sessionsDirectory,
  writeSession,
  type SessionEntry
} from '@htmlppt/host';
import { makeTempDir } from '@htmlppt/test-utils';
import { describe, expect, it } from 'vitest';
import {
  findLiveSession,
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
async function silentShellHost(): Promise<{
  entry: SessionEntry;
  close: () => Promise<void>;
}> {
  const server = createServer((request, response) => {
    if ((request.url ?? '/').startsWith('/api/health')) {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(healthOk);
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

  it('is unhealthy when the shell responds with a server error', async () => {
    // Health already proved the process is alive, and the document route only
    // reads the editor build. A 5xx there is a broken build, such as the
    // missing-index zombie host, so the entry must be evicted.
    const host = await fakeHost((path) =>
      path.startsWith('/api/health')
        ? { status: 200, type: 'application/json', body: healthOk }
        : { status: 503, type: 'text/plain', body: 'busy' }
    );
    try {
      expect(await probeSessionHealth(host.entry)).toBe('unhealthy');
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
    const dir = await makeTempDir('htmlppt-mcp-session-');
    const previousHome = process.env.HTMLPPT_HOME;
    process.env.HTMLPPT_HOME = join(dir, 'home');
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
      const deckPath = join(dir, 'demo.deck.html');
      await writeFile(deckPath, '<!doctype html><title>Deck</title>', 'utf8');
      const entry: SessionEntry = {
        ...demoEntry(host.entry.port),
        path: deckPath
      };
      await writeSession(entry);
      const sessionFile = join(
        sessionsDirectory(),
        `${sessionKey(deckPath)}.json`
      );
      const snapshot = await readFile(sessionFile, 'utf8');

      const registered = await lookupRegisteredSession(deckPath);

      expect(registered).toEqual({ entry, snapshot, health: 'unhealthy' });
      // `open` needs the entry and its snapshot, so a health verdict must not
      // delete it here.
      expect(await readFile(sessionFile, 'utf8')).toBe(snapshot);

      expect(await findLiveSession(deckPath)).toBeNull();
      await expect(readFile(sessionFile, 'utf8')).rejects.toMatchObject({
        code: 'ENOENT'
      });
    } finally {
      await host.close();
      if (previousHome === undefined) {
        delete process.env.HTMLPPT_HOME;
      } else {
        process.env.HTMLPPT_HOME = previousHome;
      }
      await rm(dir, { recursive: true, force: true });
    }
  });
});
