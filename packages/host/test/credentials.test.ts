import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
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
    home = await mkdtemp(path.join(tmpdir(), 'htmlppt-cred-'));
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
  });

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
});
