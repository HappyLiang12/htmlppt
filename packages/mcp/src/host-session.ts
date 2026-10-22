import { readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import {
  readSession,
  sessionKey,
  sessionsDirectory,
  type SessionEntry
} from '@htmlppt/host';

const HEALTH_TIMEOUT_MS = 1_000;

/**
 * Finds the host serving a deck, if any. A registry entry is only trusted while
 * the recorded process is alive and its authenticated health endpoint answers
 * within a bounded time. Dead, replaced, or unresponsive entries are removed so
 * later calls go straight to direct mode instead of retrying a dead host.
 */
export async function findLiveSession(
  filePath: string
): Promise<SessionEntry | null> {
  const resolved = path.resolve(filePath);
  const sessionFile = path.join(
    sessionsDirectory(),
    `${sessionKey(resolved)}.json`
  );

  let raw: string;
  try {
    raw = await readFile(sessionFile, 'utf8');
  } catch {
    return null;
  }

  // readSession validates the entry shape and pid liveness, and removes
  // entries that fail either check.
  const entry = await readSession(sessionFile);
  if (!entry) {
    return null;
  }
  if (entry.path !== resolved) {
    await removeStaleSession(sessionFile, raw);
    return null;
  }

  if (!(await isHostHealthy(entry))) {
    await removeStaleSession(sessionFile, raw);
    return null;
  }
  return entry;
}

async function isHostHealthy(entry: SessionEntry): Promise<boolean> {
  try {
    const response = await fetch(`http://127.0.0.1:${entry.port}/api/health`, {
      headers: { authorization: `Bearer ${entry.token}` },
      signal: AbortSignal.timeout(HEALTH_TIMEOUT_MS)
    });
    if (!response.ok) {
      return false;
    }
    const payload = (await response.json()) as { ok?: unknown };
    return payload?.ok === true;
  } catch {
    return false;
  }
}

/**
 * Removes a registry file only while it still holds the snapshot that was
 * judged stale, mirroring the host package's race-safe removal: a concurrent
 * writer that replaced the entry keeps its file.
 */
async function removeStaleSession(
  sessionFile: string,
  expectedRaw: string
): Promise<void> {
  let currentRaw: string;
  try {
    currentRaw = await readFile(sessionFile, 'utf8');
  } catch {
    return;
  }
  if (currentRaw !== expectedRaw) {
    return;
  }
  await rm(sessionFile, { force: true }).catch(() => undefined);
}
