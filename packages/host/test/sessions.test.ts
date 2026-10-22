import {
  mkdir,
  mkdtemp,
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

  it('lists every readable session', async () => {
    const first = makeEntry(join(home, 'one.html'));
    const second = makeEntry(join(home, 'two.html'), { port: 43124 });
    await writeSession(first);
    await writeSession(second);

    const sessions = await listSessions();

    expect(sessions).toHaveLength(2);
    expect(sessions).toEqual(expect.arrayContaining([first, second]));
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

  it('removes sessions idempotently', async () => {
    const entry = makeEntry(join(home, 'remove.html'));
    await writeSession(entry);
    const filePath = sessionFilePath(entry.path);

    await removeSession(filePath);

    await expect(stat(filePath)).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(removeSession(filePath)).resolves.toBeUndefined();
  });
});
