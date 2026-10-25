import { randomUUID } from 'node:crypto';
import { chmod, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { canonicalDeckPath, sessionKey } from './sessions.js';

export interface DeckCredential {
  token: string;
  port: number;
  createdAt: string;
  updatedAt: string;
}

export function credentialsDirectory(): string {
  const override = process.env.HTMLPPT_HOME;
  const base =
    override && override.length > 0
      ? path.resolve(override)
      : path.join(homedir(), '.htmlppt');
  return path.join(base, 'decks');
}

export function credentialFile(filePath: string): string {
  return path.join(credentialsDirectory(), `${sessionKey(filePath)}.json`);
}

/**
 * `open` keys by the caller's spelling while a session entry can move to the
 * realpath after a deck switch. Resolve before hashing so every spelling of
 * the same deck reaches one credential file.
 */
async function canonicalCredentialFile(filePath: string): Promise<string> {
  return credentialFile(await canonicalDeckPath(filePath));
}

export async function readCredential(
  filePath: string
): Promise<DeckCredential | null> {
  let raw: string;
  try {
    raw = await readFile(await canonicalCredentialFile(filePath), 'utf8');
  } catch {
    return null;
  }
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }
  return isDeckCredential(value) ? value : null;
}

export async function writeCredential(
  filePath: string,
  credential: DeckCredential
): Promise<void> {
  const directory = credentialsDirectory();
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await chmod(directory, 0o700).catch(() => undefined);
  const target = await canonicalCredentialFile(filePath);
  const temporary = `${target}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, `${JSON.stringify(credential, null, 2)}\n`, {
      encoding: 'utf8',
      mode: 0o600
    });
    await chmod(temporary, 0o600).catch(() => undefined);
    await rename(temporary, target);
  } finally {
    await rm(temporary, { force: true }).catch(() => undefined);
  }
  await chmod(target, 0o600).catch(() => undefined);
}

export async function rotateCredential(
  filePath: string,
  port: number,
  token: string = randomUUID()
): Promise<DeckCredential> {
  const existing = await readCredential(filePath);
  const now = new Date().toISOString();
  const next: DeckCredential = {
    token,
    port,
    createdAt: existing?.createdAt ?? now,
    updatedAt: now
  };
  await writeCredential(filePath, next);
  return next;
}

/**
 * Deletes the stored credential for a deck, resolving the same canonical file
 * that read/write use. A missing file is not an error. A read-only credential
 * (the usual Windows write failure) refuses to be unlinked until its write bit
 * is restored, so try once more after chmod instead of leaving the secret on
 * disk.
 */
export async function removeCredential(filePath: string): Promise<void> {
  const target = await canonicalCredentialFile(filePath);
  try {
    await rm(target, { force: true });
  } catch {
    await chmod(target, 0o600).catch(() => undefined);
    await rm(target, { force: true });
  }
}

function isDeckCredential(value: unknown): value is DeckCredential {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return false;
  }
  const entry = value as Record<string, unknown>;
  return (
    typeof entry.token === 'string' &&
    entry.token.length > 0 &&
    typeof entry.port === 'number' &&
    Number.isInteger(entry.port) &&
    entry.port >= 1 &&
    entry.port <= 65535 &&
    typeof entry.createdAt === 'string' &&
    typeof entry.updatedAt === 'string'
  );
}
