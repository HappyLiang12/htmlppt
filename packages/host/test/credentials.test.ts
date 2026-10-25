import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  stat,
  writeFile
} from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  credentialFile,
  credentialsDirectory,
  readCredential,
  rotateCredential,
  writeCredential
} from '../src/credentials.js';
import { sessionKey } from '../src/sessions.js';

describe('credentials', () => {
  let home: string;
  let previousHome: string | undefined;

  beforeEach(async () => {
    previousHome = process.env.HTMLPPT_HOME;
    // Canonicalize the root so the exact-path assertions below compare against
    // the same spelling the store derives after resolving the deck path.
    home = await realpath(await mkdtemp(path.join(tmpdir(), 'htmlppt-cred-')));
    process.env.HTMLPPT_HOME = home;
  });

  afterEach(async () => {
    if (previousHome === undefined) delete process.env.HTMLPPT_HOME;
    else process.env.HTMLPPT_HOME = previousHome;
    await rm(home, { recursive: true, force: true });
  });

  it('stores and reads a credential under the session key', async () => {
    const deck = path.join(home, 'deck.html');
    const credential = {
      token: 'token-1',
      port: 41234,
      createdAt: '2026-10-25T00:00:00.000Z',
      updatedAt: '2026-10-25T00:00:00.000Z'
    };

    await writeCredential(deck, credential);

    expect(credentialsDirectory()).toBe(path.join(home, 'decks'));
    expect(credentialFile(deck)).toBe(
      path.join(home, 'decks', `${sessionKey(deck)}.json`)
    );
    expect(await readCredential(deck)).toEqual(credential);
    expect(await readFile(credentialFile(deck), 'utf8')).toContain('token-1');
    if (process.platform !== 'win32') {
      expect((await stat(credentialFile(deck))).mode & 0o777).toBe(0o600);
      expect((await stat(credentialsDirectory())).mode & 0o777).toBe(0o700);
    }
  });

  it('keys the credential by the canonical deck path', async () => {
    // A caller may spell the same deck with a redundant segment. The store
    // must resolve the key so a later open with the plain spelling finds the
    // token that `stop` is expected to rotate.
    const deck = path.join(home, 'deck.html');
    const spelled = path.join(home, 'sub', '..', 'deck.html');
    await mkdir(path.join(home, 'sub'), { recursive: true });
    const credential = {
      token: 'token-canonical',
      port: 41236,
      createdAt: '2026-10-25T00:00:00.000Z',
      updatedAt: '2026-10-25T00:00:00.000Z'
    };

    await writeCredential(spelled, credential);

    expect(await readCredential(deck)).toEqual(credential);
    expect(await readFile(credentialFile(deck), 'utf8')).toContain(
      'token-canonical'
    );
  });

  it.skipIf(process.platform === 'win32')(
    'tightens credential directories and files to 0700/0600',
    async () => {
      // Windows ACLs cannot express POSIX mode bits, so this assertion is
      // POSIX-only. The directory starts world-writable so the test fails if
      // writeCredential stops chmod-ing it back down.
      await mkdir(credentialsDirectory(), { recursive: true });
      await chmod(credentialsDirectory(), 0o777);
      const deck = path.join(home, 'tightened.html');

      await writeCredential(deck, {
        token: 'token-2',
        port: 41235,
        createdAt: '2026-10-25T00:00:00.000Z',
        updatedAt: '2026-10-25T00:00:00.000Z'
      });

      expect((await stat(credentialsDirectory())).mode & 0o777).toBe(0o700);
      expect((await stat(credentialFile(deck))).mode & 0o777).toBe(0o600);
    }
  );

  it('returns null for a missing or malformed file', async () => {
    const deck = path.join(home, 'missing.html');
    expect(await readCredential(deck)).toBeNull();

    const broken = path.join(home, 'broken.html');
    await writeCredential(broken, {
      token: 't',
      port: 1000,
      createdAt: '2026-10-25T00:00:00.000Z',
      updatedAt: '2026-10-25T00:00:00.000Z'
    });
    await writeFile(credentialFile(broken), '{"token":""}');

    expect(await readCredential(broken)).toBeNull();
  });

  it('rotates the token and keeps the port and createdAt', async () => {
    const deck = path.join(home, 'deck.html');
    await writeCredential(deck, {
      token: 'old',
      port: 43210,
      createdAt: '2026-10-01T00:00:00.000Z',
      updatedAt: '2026-10-01T00:00:00.000Z'
    });

    const rotated = await rotateCredential(deck, 43210, 'new-token');

    expect(rotated.token).toBe('new-token');
    expect(rotated.port).toBe(43210);
    expect(rotated.createdAt).toBe('2026-10-01T00:00:00.000Z');
    expect(rotated.updatedAt).not.toBe('2026-10-01T00:00:00.000Z');
    expect(await readCredential(deck)).toEqual(rotated);
  });

  it('mints a token when rotating a deck without a credential', async () => {
    const deck = path.join(home, 'fresh.html');

    const rotated = await rotateCredential(deck, 42000);

    expect(rotated.token).toMatch(/^[0-9a-f-]{36}$/);
    expect(rotated.port).toBe(42000);
  });

  it('falls back to ~/.htmlppt/decks when HTMLPPT_HOME is empty', () => {
    process.env.HTMLPPT_HOME = '';

    expect(credentialsDirectory()).toBe(
      path.join(homedir(), '.htmlppt', 'decks')
    );

    delete process.env.HTMLPPT_HOME;

    expect(credentialsDirectory()).toBe(
      path.join(homedir(), '.htmlppt', 'decks')
    );
  });
});
