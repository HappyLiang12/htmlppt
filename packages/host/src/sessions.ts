import { createHash, randomUUID } from 'node:crypto';
import {
  chmod,
  mkdir,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  writeFile
} from 'node:fs/promises';
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

const IGNORABLE_LIST_CODES = new Set(['EACCES', 'ENOENT', 'ENOTDIR']);
const REVISION_PATTERN = /^[a-f0-9]{64}$/;
const fileQueues = new Map<string, Promise<unknown>>();

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

/**
 * Resolves a path to its canonical spelling. A missing deck still resolves
 * through its parent so a deleted file under an alias keeps a stable identity.
 */
export async function canonicalDeckPath(value: string): Promise<string> {
  const resolved = path.resolve(value);
  try {
    return await realpath(resolved);
  } catch {
    try {
      return path.join(
        await realpath(path.dirname(resolved)),
        path.basename(resolved)
      );
    } catch {
      return resolved;
    }
  }
}

/**
 * Compares two deck spellings by identity. Windows 8.3 short names and
 * symlinked/junction parents name the same deck under different registry
 * keys, so raw string equality is not enough.
 */
export async function sameDeckPath(
  left: string,
  right: string
): Promise<boolean> {
  const [leftPath, rightPath] = await Promise.all([
    canonicalDeckPath(left),
    canonicalDeckPath(right)
  ]);
  return leftPath === rightPath;
}

export async function writeSession(entry: SessionEntry): Promise<void> {
  const directory = sessionsDirectory();
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await chmod(directory, 0o700).catch(() => undefined);

  const resolvedPath = path.resolve(entry.path);
  const stored: SessionEntry = { ...entry, path: resolvedPath };
  const key = sessionKey(resolvedPath);
  const filePath = path.join(directory, `${key}.json`);
  const temporaryPath = path.join(directory, `${key}.${randomUUID()}.tmp`);

  await withFileLock(filePath, async () => {
    try {
      await writeFile(temporaryPath, `${JSON.stringify(stored, null, 2)}\n`, {
        encoding: 'utf8',
        mode: 0o600
      });
      await chmod(temporaryPath, 0o600).catch(() => undefined);
      await rename(temporaryPath, filePath);
    } finally {
      await rm(temporaryPath, { force: true }).catch(() => undefined);
    }
    await chmod(filePath, 0o600).catch(() => undefined);
  });
}

export async function readSession(
  filePath: string
): Promise<SessionEntry | null> {
  return withFileLock(filePath, async () => {
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
      await removeSessionIfUnchanged(filePath, raw);
      return null;
    }

    if (!isSessionEntry(value) || !isProcessAlive(value.pid)) {
      await removeSessionIfUnchanged(filePath, raw);
      return null;
    }

    return value;
  });
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
    if (
      IGNORABLE_LIST_CODES.has((error as NodeJS.ErrnoException).code ?? '')
    ) {
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
  sessions.sort((left, right) =>
    left.path < right.path ? -1 : left.path > right.path ? 1 : 0
  );
  return sessions;
}

export async function removeSession(filePath: string): Promise<void> {
  await rm(filePath, { force: true });
}

/**
 * Deletes a session file only while its content still matches the snapshot
 * that was judged malformed or stale. Exported for tests; the registry reaches
 * it through {@link readSession}.
 */
export async function removeSessionIfUnchanged(
  filePath: string,
  expectedRaw: string
): Promise<boolean> {
  let currentRaw: string;
  try {
    currentRaw = await readFile(filePath, 'utf8');
  } catch {
    return false;
  }
  if (currentRaw !== expectedRaw) {
    return false;
  }
  try {
    await rm(filePath, { force: true });
    return true;
  } catch {
    return false;
  }
}

/**
 * Serializes reads and writes per file so a rename never races an open read
 * and concurrent callers observe complete entries. Cross-process readers still
 * rely on the atomic rename itself.
 */
function withFileLock<T>(
  filePath: string,
  task: () => Promise<T>
): Promise<T> {
  const key = path.resolve(filePath);
  const previous = fileQueues.get(key) ?? Promise.resolve();
  const run = previous.then(task, task);
  const settled = run.then(
    () => undefined,
    () => undefined
  );
  fileQueues.set(key, settled);
  return run.finally(() => {
    if (fileQueues.get(key) === settled) {
      fileQueues.delete(key);
    }
  });
}

function isSessionEntry(value: unknown): value is SessionEntry {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return false;
  }
  const entry = value as Record<string, unknown>;
  return (
    typeof entry.path === 'string' &&
    isResolvedAbsolutePath(entry.path) &&
    typeof entry.port === 'number' &&
    isPort(entry.port) &&
    typeof entry.token === 'string' &&
    entry.token.length > 0 &&
    typeof entry.pid === 'number' &&
    isPid(entry.pid) &&
    typeof entry.startedAt === 'string' &&
    isIsoTimestamp(entry.startedAt) &&
    typeof entry.revision === 'string' &&
    REVISION_PATTERN.test(entry.revision)
  );
}

function isResolvedAbsolutePath(value: string): boolean {
  return path.isAbsolute(value) && path.resolve(value) === value;
}

function isPort(value: number): boolean {
  return Number.isInteger(value) && value >= 1 && value <= 65535;
}

function isPid(value: number): boolean {
  return Number.isInteger(value) && value > 0;
}

function isIsoTimestamp(value: string): boolean {
  const time = Date.parse(value);
  return !Number.isNaN(time) && new Date(time).toISOString() === value;
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
