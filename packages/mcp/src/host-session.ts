import { readFile, realpath } from 'node:fs/promises';
import path from 'node:path';
import {
  listSessions,
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
 * Finds the host serving a deck, if any. Registry entries keep the spelling
 * the writer used: on Windows, short (8.3) and long paths name the same file
 * but produce different session keys. The caller's spelling is tried first;
 * otherwise the registry is scanned and entries are compared by realpath.
 *
 * A registry entry is only trusted while the recorded process is alive and its
 * authenticated health endpoint answers within a bounded time. Definitive
 * failures (dead process, refused connection, a non-5xx health response such
 * as 401 or 404, malformed payload, or a different deck path) remove the entry
 * so later calls do not retry a dead host. A health timeout or 5xx response
 * means the host may be busy rather than stale: the entry is kept, and the
 * caller falls back to direct mode for this call only.
 */
export async function findLiveSession(
  filePath: string
): Promise<SessionEntry | null> {
  const resolved = path.resolve(filePath);
  const canonical = await canonicalPath(resolved);
  const sessionFile = path.join(
    sessionsDirectory(),
    `${sessionKey(resolved)}.json`
  );

  let raw: string | undefined;
  try {
    raw = await readFile(sessionFile, 'utf8');
  } catch {
    raw = undefined;
  }

  if (raw !== undefined) {
    // readSession validates the entry shape and pid liveness, and removes
    // entries that fail either check.
    const entry = await readSession(sessionFile);
    if (!entry) {
      return null;
    }
    if (!(await sameDeckPath(entry.path, canonical))) {
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

  // The direct key is absent when the entry was written with another spelling
  // of the same deck, such as the long form of a Windows short path or a
  // symlinked/junction parent.
  for (const entry of await listSessions()) {
    if (!(await sameDeckPath(entry.path, canonical))) {
      continue;
    }
    const entryFile = path.join(
      sessionsDirectory(),
      `${sessionKey(entry.path)}.json`
    );
    let entryRaw: string;
    try {
      entryRaw = await readFile(entryFile, 'utf8');
    } catch {
      // Another process removed the entry between listing and reading.
      continue;
    }
    const health = await checkHost(entry);
    if (health === 'unhealthy') {
      await removeSessionIfUnchanged(entryFile, entryRaw);
      continue;
    }
    return health === 'healthy' ? entry : null;
  }
  return null;
}

/**
 * Resolves a path to its canonical spelling. A missing deck still resolves
 * through its parent so a deleted file under an alias keeps a stable identity.
 */
async function canonicalPath(filePath: string): Promise<string> {
  const resolved = path.resolve(filePath);
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

async function sameDeckPath(left: string, right: string): Promise<boolean> {
  const [leftPath, rightPath] = await Promise.all([
    canonicalPath(left),
    canonicalPath(right)
  ]);
  return leftPath === rightPath;
}

async function checkHost(entry: SessionEntry): Promise<HealthStatus> {
  try {
    const response = await fetch(`http://127.0.0.1:${entry.port}/api/health`, {
      headers: { authorization: `Bearer ${entry.token}` },
      signal: AbortSignal.timeout(HEALTH_TIMEOUT_MS)
    });
    if (!response.ok) {
      await response.body?.cancel().catch(() => undefined);
      // A 5xx can mean a busy host, so keep its entry. Every other status,
      // including 401/403 and 404/400/405, is a definitive rejection or a
      // different service on the recorded port.
      return response.status >= 500 ? 'unknown' : 'unhealthy';
    }
    let payload: { ok?: unknown; filePath?: unknown } | null;
    try {
      payload = (await response.json()) as {
        ok?: unknown;
        filePath?: unknown;
      } | null;
    } catch (error) {
      // The signal also bounds reading the body.
      return isAbortError(error) ? 'unknown' : 'unhealthy';
    }
    if (payload?.ok !== true) {
      return 'unhealthy';
    }
    // A host that switched decks under the recorded port is not serving this
    // entry. Older payloads omit filePath, which stays compatible.
    if (
      payload.filePath !== undefined &&
      payload.filePath !== entry.path
    ) {
      return 'unhealthy';
    }
    return 'healthy';
  } catch (error) {
    // Timeouts say nothing about whether the host is alive: it may simply be
    // busy behind its save lock, so keep the entry for later calls.
    return isAbortError(error) ? 'unknown' : 'unhealthy';
  }
}
