import { readFile } from 'node:fs/promises';
import path from 'node:path';
import {
  canonicalDeckPath,
  listSessions,
  readSession,
  removeSessionIfUnchanged,
  sameDeckPath,
  sessionKey,
  sessionsDirectory,
  type SessionEntry
} from '@htmlppt/host';
import { isAbortError } from './abort.js';

export const HEALTH_TIMEOUT_MS = 1_000;

type HealthStatus = 'healthy' | 'unhealthy' | 'unknown';

interface CheckedSession {
  entry: SessionEntry;
  snapshot: string;
}

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
 * means the host may be busy rather than stale: the entry is kept and the scan
 * continues, because another spelling of the same deck may name a healthy
 * host. Only after the scan finds no healthy entry does the caller fall back
 * to direct mode for this call.
 *
 * Every removal is fenced by the exact bytes that were checked. A listed
 * entry can be stale by the time the health check finishes, so each candidate
 * is re-read through `readSession` and removed only while its file still
 * matches that checked snapshot.
 */
export async function findLiveSession(
  filePath: string
): Promise<SessionEntry | null> {
  const resolved = path.resolve(filePath);
  const canonical = await canonicalDeckPath(resolved);
  const sessionFile = path.join(
    sessionsDirectory(),
    `${sessionKey(resolved)}.json`
  );

  // readSession validates the entry shape and pid liveness, and removes
  // entries that fail either check.
  const direct = await readCheckedSession(sessionFile);
  if (direct) {
    if (!(await sameDeckPath(direct.entry.path, canonical))) {
      // The key belongs to this deck but the entry names another one.
      await removeSessionIfUnchanged(sessionFile, direct.snapshot);
    } else {
      const health = await checkHost(direct.entry);
      if (health === 'healthy') {
        return direct.entry;
      }
      if (health === 'unhealthy') {
        await removeSessionIfUnchanged(sessionFile, direct.snapshot);
      }
      // Unknown health keeps the entry; keep scanning for a healthy alias.
    }
  }

  // The direct key is absent when the entry was written with another spelling
  // of the same deck, such as the long form of a Windows short path or a
  // symlinked/junction parent.
  for (const listed of await listSessions()) {
    if (!(await sameDeckPath(listed.path, canonical))) {
      continue;
    }
    const entryFile = path.join(
      sessionsDirectory(),
      `${sessionKey(listed.path)}.json`
    );
    if (path.resolve(entryFile) === sessionFile) {
      // The direct key was already judged above; do not pay for a second
      // health check when that host is merely busy.
      continue;
    }
    // The listing can race a writer, so judge the entry that is on disk now.
    const current = await readCheckedSession(entryFile);
    if (!current) {
      // Another process removed or replaced the entry after it was listed.
      continue;
    }
    if (!(await sameDeckPath(current.entry.path, canonical))) {
      // A fresh entry under this key names a different deck; leave it alone.
      continue;
    }
    const health = await checkHost(current.entry);
    if (health === 'unhealthy') {
      await removeSessionIfUnchanged(entryFile, current.snapshot);
      continue;
    }
    if (health === 'healthy') {
      return current.entry;
    }
    // Unknown health keeps the entry and keeps scanning for a healthy alias.
  }
  return null;
}

/**
 * Reads and validates a session, then returns the exact content that was
 * checked. `readSession` re-validates pid liveness and shape; the follow-up
 * read proves the file still held that same entry. Hand-formatted but
 * equivalent JSON is supported by keeping its raw bytes as the snapshot, so a
 * later removal can never delete content that differs from what was checked.
 */
async function readCheckedSession(
  filePath: string
): Promise<CheckedSession | null> {
  const entry = await readSession(filePath);
  if (!entry) {
    return null;
  }
  const canonicalSnapshot = `${JSON.stringify(entry, null, 2)}\n`;
  let raw: string;
  try {
    raw = await readFile(filePath, 'utf8');
  } catch {
    return null;
  }
  if (raw === canonicalSnapshot) {
    return { entry, snapshot: canonicalSnapshot };
  }
  try {
    if (JSON.stringify(JSON.parse(raw)) === JSON.stringify(entry)) {
      return { entry, snapshot: raw };
    }
  } catch {
    // Content changed or became malformed after validation.
  }
  return null;
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
