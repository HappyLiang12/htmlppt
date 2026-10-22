import { createHash } from 'node:crypto';
import { chmod, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';

export interface SessionEntry {
  path: string;
  port: number;
  token: string;
  pid: number;
  startedAt: string;
  revision: string;
}

export function sessionsDirectory(): string {
  const override = process.env.HTMLPPT_HOME;
  const base =
    override && override.length > 0
      ? path.resolve(override)
      : path.join(homedir(), '.htmlppt');
  return path.join(base, 'sessions');
}

export function sessionKey(filePath: string): string {
  return createHash('sha256').update(path.resolve(filePath)).digest('hex');
}

export async function writeSession(entry: SessionEntry): Promise<void> {
  const directory = sessionsDirectory();
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await chmod(directory, 0o700).catch(() => undefined);

  const filePath = path.join(directory, `${sessionKey(entry.path)}.json`);
  await writeFile(filePath, `${JSON.stringify(entry, null, 2)}\n`, {
    encoding: 'utf8',
    mode: 0o600
  });
  await chmod(filePath, 0o600).catch(() => undefined);
}

export async function readSession(
  filePath: string
): Promise<SessionEntry | null> {
  let raw: string;
  try {
    raw = await readFile(filePath, 'utf8');
  } catch {
    return null;
  }

  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    await removeQuietly(filePath);
    return null;
  }

  if (!isSessionEntry(value)) {
    await removeQuietly(filePath);
    return null;
  }

  if (!isProcessAlive(value.pid)) {
    await removeQuietly(filePath);
    return null;
  }

  return value;
}

export async function listSessions(): Promise<SessionEntry[]> {
  const directory = sessionsDirectory();
  let names: string[];
  try {
    const dirents = await readdir(directory, { withFileTypes: true });
    names = dirents
      .filter((dirent) => dirent.isFile() && dirent.name.endsWith('.json'))
      .map((dirent) => dirent.name)
      .sort();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return [];
    }
    throw error;
  }

  const sessions: SessionEntry[] = [];
  for (const name of names) {
    const entry = await readSession(path.join(directory, name));
    if (entry) {
      sessions.push(entry);
    }
  }
  return sessions;
}

export async function removeSession(filePath: string): Promise<void> {
  await rm(filePath, { force: true });
}

async function removeQuietly(filePath: string): Promise<void> {
  await rm(filePath, { force: true }).catch(() => undefined);
}

function isSessionEntry(value: unknown): value is SessionEntry {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return false;
  }
  const entry = value as Record<string, unknown>;
  return (
    typeof entry.path === 'string' &&
    entry.path.length > 0 &&
    typeof entry.port === 'number' &&
    Number.isInteger(entry.port) &&
    entry.port > 0 &&
    entry.port <= 65535 &&
    typeof entry.token === 'string' &&
    entry.token.length > 0 &&
    typeof entry.pid === 'number' &&
    Number.isInteger(entry.pid) &&
    entry.pid > 0 &&
    typeof entry.startedAt === 'string' &&
    typeof entry.revision === 'string'
  );
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM means the process exists but belongs to another user. Any other
    // failure (ESRCH, invalid PID values) means the entry is stale.
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}
