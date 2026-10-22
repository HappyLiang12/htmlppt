import {
  chmod,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  stat,
  writeFile
} from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  listSessions,
  readSession,
  removeSession,
  sessionKey,
  sessionsDirectory,
  writeSession,
  type SessionEntry
} from '../src/index.js';
import { removeSessionIfUnchanged } from '../src/sessions.js';

function makeEntry(
  deckPath: string,
  overrides: Partial<SessionEntry> = {}
): SessionEntry {
  return {
    path: deckPath,
    port: 43123,
    token: 'session-token',
    pid: process.pid,
    startedAt: '2026-10-22T00:00:00.000Z',
    revision: 'a'.repeat(64),
    ...overrides
  };
}

function sessionFilePath(deckPath: string): string {
  return join(sessionsDirectory(), `${sessionKey(deckPath)}.json`);
}

async function writeRawSession(
  deckPath: string,
  contents: string
): Promise<string> {
  const filePath = sessionFilePath(deckPath);
  await mkdir(sessionsDirectory(), { recursive: true });
  await writeFile(filePath, contents, 'utf8');
  return filePath;
}

function entryJson(entry: SessionEntry): string {
  return `${JSON.stringify(entry, null, 2)}\n`;
}

describe('session registry', () => {
  let home = '';
  let originalHome: string | undefined;

  beforeEach(async () => {
    originalHome = process.env.HTMLPPT_HOME;
    home = await mkdtemp(join(tmpdir(), 'htmlppt-home-'));
    process.env.HTMLPPT_HOME = home;
  });

  afterEach(async () => {
    if (originalHome === undefined) {
      delete process.env.HTMLPPT_HOME;
    } else {
      process.env.HTMLPPT_HOME = originalHome;
    }
    await rm(home, { recursive: true, force: true });
  });

  it('honors HTMLPPT_HOME and round-trips an entry with user-only modes', async () => {
    const deckPath = join(home, 'deck.html');
    const entry = makeEntry(deckPath);

    await writeSession(entry);

    expect(sessionsDirectory()).toBe(join(home, 'sessions'));
    expect(await readSession(sessionFilePath(deckPath))).toEqual(entry);
    if (process.platform !== 'win32') {
      expect((await stat(sessionFilePath(deckPath))).mode & 0o777).toBe(0o600);
      expect((await stat(sessionsDirectory())).mode & 0o777).toBe(0o700);
    }
  });

  it.skipIf(process.platform === 'win32')(
    'tightens CLI session files and directories to 0600/0700',
    async () => {
      // `htmlppt open` persists its session through writeSession. Windows ACLs
      // cannot express POSIX mode bits, so this assertion is POSIX-only.
      await mkdir(sessionsDirectory(), { recursive: true });
      await chmod(sessionsDirectory(), 0o777);
      const entry = makeEntry(join(home, 'cli-deck.html'));

      await writeSession(entry);

      expect((await stat(sessionsDirectory())).mode & 0o777).toBe(0o700);
      expect((await stat(sessionFilePath(entry.path))).mode & 0o777).toBe(
        0o600
      );
    }
  );

  it('falls back to ~/.htmlppt/sessions', () => {
    delete process.env.HTMLPPT_HOME;

    expect(sessionsDirectory()).toBe(join(homedir(), '.htmlppt', 'sessions'));
  });

  it('derives a stable SHA-256 key from the resolved path', () => {
    const deckPath = join(home, 'deck.html');

    const key = sessionKey(deckPath);

    expect(key).toMatch(/^[a-f0-9]{64}$/);
    expect(key).toBe(sessionKey(deckPath));
    expect(key).toBe(sessionKey(resolve(deckPath)));
    expect(sessionKey('deck.html')).toBe(sessionKey(resolve('deck.html')));
    expect(key).not.toBe(sessionKey(join(home, 'other.html')));
  });

  it('lists sessions in deterministic deck-path order', async () => {
    const alpha = makeEntry(join(home, 'alpha.html'));
    const omega = makeEntry(join(home, 'omega.html'), { port: 43124 });
    await writeSession(omega);
    await writeSession(alpha);

    await expect(listSessions()).resolves.toEqual([alpha, omega]);
  });

  it('stores the resolved deck path', async () => {
    const deckPath = `${resolve(home, 'nested')}/../normalized.html`;
    const entry = makeEntry(deckPath);
    expect(resolve(deckPath)).not.toBe(deckPath);

    await writeSession(entry);

    await expect(readSession(sessionFilePath(deckPath))).resolves.toEqual({
      ...entry,
      path: resolve(deckPath)
    });
  });

  it('keeps one complete entry and no temp files when two writers race', async () => {
    const deckPath = join(home, 'shared.html');
    const filePath = sessionFilePath(deckPath);
    const initial = makeEntry(deckPath);
    const first = makeEntry(deckPath, {
      port: 43124,
      token: 'a'.repeat(256 * 1024)
    });
    const second = makeEntry(deckPath, {
      port: 43125,
      token: 'b'.repeat(256 * 1024)
    });
    const allowedTokens = new Set([initial.token, first.token, second.token]);
    await writeSession(initial);

    let writing = true;
    let reads = 0;
    const invalidReads: string[] = [];
    const reader = (async () => {
      while (writing) {
        const entry = await readSession(filePath);
        reads += 1;
        if (entry === null) {
          invalidReads.push('null');
        } else if (!allowedTokens.has(entry.token)) {
          invalidReads.push('unknown entry');
        }
      }
    })();

    try {
      await Promise.all([writeSession(first), writeSession(second)]);
    } finally {
      writing = false;
    }
    await reader;

    expect(reads).toBeGreaterThan(0);
    expect(invalidReads).toEqual([]);
    const stored = JSON.parse(await readFile(filePath, 'utf8')) as SessionEntry;
    expect([first, second]).toContainEqual(stored);
    await expect(readdir(sessionsDirectory())).resolves.toEqual([
      `${sessionKey(deckPath)}.json`
    ]);
  });

  it('never exposes partial session JSON while a writer runs', async () => {
    const deckPath = join(home, 'stream.html');
    const filePath = sessionFilePath(deckPath);
    await writeSession(makeEntry(deckPath, { token: 'seed' }));

    let writing = true;
    const problems: string[] = [];
    let reads = 0;
    const reader = async (): Promise<void> => {
      while (writing && reads < 3000) {
        const entry = await readSession(filePath);
        reads += 1;
        if (entry === null) {
          problems.push('null');
        } else if (
          entry.path !== resolve(deckPath) ||
          entry.port !== 43123 ||
          typeof entry.token !== 'string'
        ) {
          problems.push('unexpected entry shape');
        }
      }
    };
    const readers = [reader(), reader()];

    try {
      for (let index = 0; index < 40; index += 1) {
        await writeSession(
          makeEntry(deckPath, {
            token: `${index}`.padEnd(256 * 1024, 'w')
          })
        );
      }
    } finally {
      writing = false;
    }
    await Promise.all(readers);

    expect(reads).toBeGreaterThan(0);
    expect(problems).toEqual([]);
  });

  it('deletes a malformed file only when its content is unchanged', async () => {
    const filePath = await writeRawSession(join(home, 'changed.html'), 'not json');

    await expect(removeSessionIfUnchanged(filePath, 'not json')).resolves.toBe(
      true
    );
    await expect(stat(filePath)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('preserves a session file replaced after it was read', async () => {
    const deckPath = join(home, 'replaced.html');
    const filePath = await writeRawSession(deckPath, 'not json');
    const fresh = makeEntry(deckPath);
    await writeSession(fresh);

    await expect(removeSessionIfUnchanged(filePath, 'not json')).resolves.toBe(
      false
    );
    await expect(readSession(filePath)).resolves.toEqual(fresh);
  });

  it('returns an empty list when the sessions location cannot be listed', async () => {
    const notADirectory = join(home, 'not-a-directory');
    await writeFile(notADirectory, 'x', 'utf8');
    process.env.HTMLPPT_HOME = notADirectory;

    await expect(listSessions()).resolves.toEqual([]);
  });

  it('returns an empty list when no sessions have been written', async () => {
    await expect(listSessions()).resolves.toEqual([]);
  });

  it('removes an entry whose process is dead when it is read', async () => {
    const entry = makeEntry(join(home, 'dead.html'), {
      pid: Number.MAX_SAFE_INTEGER
    });
    await writeSession(entry);
    const filePath = sessionFilePath(entry.path);

    expect(await readSession(filePath)).toBeNull();
    await expect(stat(filePath)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('ignores and removes malformed session files', async () => {
    const filePath = sessionFilePath(join(home, 'broken.html'));
    await mkdir(sessionsDirectory(), { recursive: true });
    await writeFile(filePath, 'not json', 'utf8');

    expect(await readSession(filePath)).toBeNull();
    await expect(stat(filePath)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('removes dead and malformed entries while listing', async () => {
    const live = makeEntry(join(home, 'live.html'));
    const dead = makeEntry(join(home, 'dead-list.html'), {
      pid: Number.MAX_SAFE_INTEGER
    });
    await writeSession(live);
    await writeSession(dead);
    const brokenPath = await writeRawSession(
      join(home, 'broken-list.html'),
      'not json'
    );

    await expect(listSessions()).resolves.toEqual([live]);
    await expect(stat(sessionFilePath(dead.path))).rejects.toMatchObject({
      code: 'ENOENT'
    });
    await expect(stat(brokenPath)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  const invalidEntries: Array<[string, Partial<SessionEntry>]> = [
    ['a non-ISO startedAt', { startedAt: '2026-10-22' }],
    ['an unparsable startedAt', { startedAt: 'not-a-date' }],
    ['a short revision', { revision: 'a'.repeat(63) }],
    ['an uppercase revision', { revision: 'A'.repeat(64) }],
    ['a non-hex revision', { revision: 'g'.repeat(64) }],
    ['a zero port', { port: 0 }],
    ['an out-of-range port', { port: 65536 }],
    ['a fractional port', { port: 1.5 }],
    ['a zero pid', { pid: 0 }],
    ['a negative pid', { pid: -1 }],
    ['a fractional pid', { pid: 1.5 }],
    ['a relative path', { path: join('relative', 'deck.html') }]
  ];

  it.each(invalidEntries)(
    'ignores and removes an entry with %s',
    async (_label, override) => {
      const deckPath = join(home, 'invalid.html');
      const entry = makeEntry(deckPath, override);
      const filePath = await writeRawSession(deckPath, entryJson(entry));

      await expect(readSession(filePath)).resolves.toBeNull();
      await expect(stat(filePath)).rejects.toMatchObject({ code: 'ENOENT' });
    }
  );

  it('ignores and removes an entry with an unresolved absolute path', async () => {
    const deckPath = `${resolve(home, 'nested')}/../invalid.html`;
    const entry = makeEntry(deckPath);
    expect(resolve(deckPath)).not.toBe(deckPath);
    const filePath = await writeRawSession(deckPath, entryJson(entry));

    await expect(readSession(filePath)).resolves.toBeNull();
    await expect(stat(filePath)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('removes sessions idempotently', async () => {
    const entry = makeEntry(join(home, 'remove.html'));
    await writeSession(entry);
    const filePath = sessionFilePath(entry.path);

    await removeSession(filePath);

    await expect(stat(filePath)).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(removeSession(filePath)).resolves.toBeUndefined();
  });
});
