import { readFile } from 'node:fs/promises';
import path from 'node:path';
import {
  readSession,
  removeSessionIfUnchanged,
  sessionKey,
  sessionsDirectory,
  type SessionEntry
} from '@htmlppt/host';
import { isAbortError } from './abort.js';

export const HEALTH_TIMEOUT_MS = 1_000;

type HealthStatus = 'healthy' | 'unhealthy' | 'unknown';

/**
 * Finds the host serving a deck, if any. A registry entry is only trusted while
 * the recorded process is alive and its authenticated health endpoint answers
 * within a bounded time. Definitive failures (dead process, refused connection,
 * rejected token, malformed payload, or a different deck path) remove the entry
 * so later calls do not retry a dead host. A health timeout means the host may
 * be busy rather than stale: the entry is kept, and the caller falls back to
 * direct mode for this call only.
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
    await removeSessionIfUnchanged(sessionFile, raw);
    return null;
  }

  const health = await checkHost(entry);
  if (health === 'unhealthy') {
    await removeSessionIfUnchanged(sessionFile, raw);
    return null;
  }
  return health === 'healthy' ? entry : null;
}

async function checkHost(entry: SessionEntry): Promise<HealthStatus> {
  try {
    const response = await fetch(`http://127.0.0.1:${entry.port}/api/health`, {
      headers: { authorization: `Bearer ${entry.token}` },
      signal: AbortSignal.timeout(HEALTH_TIMEOUT_MS)
    });
    if (!response.ok) {
      return 'unhealthy';
    }
    let payload: { ok?: unknown } | null;
    try {
      payload = (await response.json()) as { ok?: unknown } | null;
    } catch (error) {
      // The signal also bounds reading the body.
      return isAbortError(error) ? 'unknown' : 'unhealthy';
    }
    return payload?.ok === true ? 'healthy' : 'unhealthy';
  } catch (error) {
    // Timeouts say nothing about whether the host is alive: it may simply be
    // busy behind its save lock, so keep the entry for later calls.
    return isAbortError(error) ? 'unknown' : 'unhealthy';
  }
}
