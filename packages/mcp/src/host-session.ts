import { readFile } from 'node:fs/promises';
import path from 'node:path';
import {
  TOKEN_COOKIE,
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

export type HealthStatus =
  | 'healthy'
  | 'stale-build'
  | 'unhealthy'
  | 'unknown';

interface CheckedSession {
  entry: SessionEntry;
  snapshot: string;
}

export interface RegisteredSessionCheck {
  entry: SessionEntry;
  snapshot: string;
  health: HealthStatus;
}

/**
 * Finds a host that can serve the editor for a deck, if any. Registry entries
 * keep the spelling the writer used: on Windows, short (8.3) and long paths
 * name the same file but produce different session keys. The caller's
 * spelling is tried first; otherwise the registry is scanned and entries are
 * compared by realpath.
 *
 * Only a `healthy` entry is returned. Definitive failures (dead process,
 * refused connection, a non-5xx health response such as 401 or 404, a
 * malformed payload, or a different deck path) remove the entry so later
 * calls do not retry a dead host.
 *
 * A `stale-build` entry answered health for this deck but cannot serve the
 * editor. It is kept instead of pruned: the process is reachable, so `stop`
 * must still be able to retire it, while this function returns null so callers
 * do not hand out a broken editor. `open` retries that entry once and replaces
 * the host when the verdict persists, so the entry does not keep blocking the
 * deck. A health 5xx or a timeout (`unknown`) also keeps the entry and the scan
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
  const sessionFile = sessionEntryFile(resolved);

  // The key belongs to this deck, so an entry naming another one can never
  // serve it. Discard it here because `lookupRegisteredSession` is read-only:
  // `open` needs an unhealthy entry and its snapshot before anything prunes
  // it. readSession also validates the entry shape and pid liveness, and
  // removes entries that fail either check.
  const recorded = await readCheckedSession(sessionFile);
  if (recorded && !(await sameDeckPath(recorded.entry.path, canonical))) {
    await removeSessionIfUnchanged(sessionFile, recorded.snapshot);
  }

  const direct = await lookupRegisteredSession(resolved);
  if (direct?.health === 'healthy') {
    return direct.entry;
  }
  if (direct?.health === 'unhealthy') {
    await removeSessionIfUnchanged(sessionFile, direct.snapshot);
  }
  // Stale-build and unknown verdicts keep the entry; keep scanning for a
  // healthy alias.

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
    const health = await probeSessionHealth(current.entry);
    if (health === 'unhealthy') {
      await removeSessionIfUnchanged(entryFile, current.snapshot);
      continue;
    }
    if (health === 'healthy') {
      return current.entry;
    }
    // Stale-build and unknown verdicts keep the entry and the scan continues.
  }
  return null;
}

/**
 * Finds a registered host that a caller can retire even when it cannot serve
 * the editor. It serves both `stop` and `open`: `stop` may signal either
 * verdict, and `open` uses the `stale-build` fallback to reach a host
 * registered under another spelling of the same deck and replaces it once a
 * retry confirms the verdict.
 *
 * `lookupRegisteredSession` only judges the caller's spelling, but a live host
 * may be registered under another spelling of the same deck, such as the long
 * form of a Windows short path or a symlinked/junction parent. The registry is
 * scanned by canonical path: a `healthy` entry wins, and the first
 * `stale-build` entry is kept as a fallback. Both are returned with the exact
 * bytes that were checked so the caller can signal only the probed process.
 *
 * `unknown` entries are skipped because the host may be busy, and `unhealthy`
 * entries are neither returned nor removed here; `findLiveSession` owns their
 * pruning.
 */
export async function findStoppableSession(
  filePath: string
): Promise<RegisteredSessionCheck | null> {
  const resolved = path.resolve(filePath);
  const canonical = await canonicalDeckPath(resolved);
  let staleBuild: RegisteredSessionCheck | null = null;
  for (const listed of await listSessions()) {
    if (!(await sameDeckPath(listed.path, canonical))) {
      continue;
    }
    const entryFile = path.join(
      sessionsDirectory(),
      `${sessionKey(listed.path)}.json`
    );
    const current = await readCheckedSession(entryFile);
    if (!current) {
      continue;
    }
    if (!(await sameDeckPath(current.entry.path, canonical))) {
      continue;
    }
    const health = await probeSessionHealth(current.entry);
    if (health === 'healthy') {
      return { ...current, health };
    }
    if (health === 'stale-build' && staleBuild === null) {
      staleBuild = { ...current, health };
    }
  }
  return staleBuild;
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

/**
 * Reads the registry entry for exactly this spelling of the deck and probes
 * its health. This must not remove a structurally valid entry because of a
 * health verdict: callers such as `open` need the entry and its checked
 * snapshot to retire a registered host that is alive but no longer serves the
 * editor, and `stop` needs them to reach a `stale-build` host. `readSession`
 * still removes an entry that is malformed or whose pid is gone. An entry
 * whose key names this deck but whose path names another one is reported as
 * absent; removing it stays with `findLiveSession`.
 */
export async function lookupRegisteredSession(
  filePath: string
): Promise<RegisteredSessionCheck | null> {
  const resolved = path.resolve(filePath);
  const canonical = await canonicalDeckPath(resolved);
  const direct = await readCheckedSession(sessionEntryFile(resolved));
  if (!direct || !(await sameDeckPath(direct.entry.path, canonical))) {
    return null;
  }
  return {
    entry: direct.entry,
    snapshot: direct.snapshot,
    health: await probeSessionHealth(direct.entry)
  };
}

function sessionEntryFile(resolvedPath: string): string {
  return path.join(sessionsDirectory(), `${sessionKey(resolvedPath)}.json`);
}

/**
 * Probes a registered host. Health proves the process is the host recorded in
 * the registry and still owns this deck; the editor shell proves that host
 * can still serve what `open` hands to the user.
 *
 * - `healthy`: health accepted this deck and the shell is the built editor.
 * - `stale-build`: health accepted this deck, but the shell is not the editor
 *   (any non-200 status, a wrong content type, a missing root marker, or a
 *   transport failure while reading it). The process is reachable and owns the
 *   deck, so callers must keep the entry for `stop` rather than treat it like a
 *   dead host.
 * - `unhealthy`: health definitively rejected this deck (a non-5xx status such
 *   as 401/403/404/405/400, a malformed payload, a different filePath) or the
 *   connection is refused. Ownership is not proven, so never signal a pid
 *   from this verdict.
 * - `unknown`: a health 5xx, an abort, a timeout, or another health transport
 *   failure. The host may be busy, so the entry is kept.
 *
 * Health keeps 5xx as `unknown` because that probe can sit behind the save
 * lock. The shell route only reads the built editor, so any answer other than
 * the editor itself is a stale build; once health proved ownership, a shell
 * transport failure cannot turn the entry into a stranger.
 */
export async function probeSessionHealth(
  entry: SessionEntry
): Promise<HealthStatus> {
  let response: Response;
  try {
    response = await fetch(`http://127.0.0.1:${entry.port}/api/health`, {
      headers: { authorization: `Bearer ${entry.token}` },
      signal: AbortSignal.timeout(HEALTH_TIMEOUT_MS)
    });
  } catch (error) {
    // A refused connection proves no host owns the recorded port. A timeout or
    // another transport failure may be a busy host, so keep the entry.
    return isConnectionRefused(error) ? 'unhealthy' : 'unknown';
  }
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
    // The signal also bounds reading the body. A malformed payload proves the
    // response is not this host's health document; a transport failure while
    // reading it says nothing definitive.
    if (isAbortError(error)) {
      return 'unknown';
    }
    return error instanceof SyntaxError ? 'unhealthy' : 'unknown';
  }
  if (payload?.ok !== true) {
    return 'unhealthy';
  }
  // A host that switched decks under the recorded port is not serving this
  // entry. Older payloads omit filePath, which stays compatible.
  if (payload.filePath !== undefined && payload.filePath !== entry.path) {
    return 'unhealthy';
  }

  // Past this point health proved this process owns the deck, so shell-phase
  // failures must stay `stale-build` or `unknown`; only `unhealthy` forbids
  // signalling the pid.
  try {
    // The tokenized root redirects to the deck document without the query
    // token, so the probe also presents the host's session cookie to stay
    // authorized on the redirected request.
    const shell = await fetch(
      `http://127.0.0.1:${entry.port}/?token=${encodeURIComponent(entry.token)}`,
      {
        headers: {
          cookie: `${TOKEN_COOKIE}=${encodeURIComponent(entry.token)}`
        },
        signal: AbortSignal.timeout(HEALTH_TIMEOUT_MS)
      }
    );
    if (shell.status !== 200) {
      await shell.body?.cancel().catch(() => undefined);
      // Health already proved the process owns this deck and this route only
      // reads the built editor, so any shell status means the build is broken
      // (the zombie host's missing index answers 500), not that the host is a
      // stranger. Keep the entry so `stop` can still retire the process.
      return 'stale-build';
    }
    if (!(shell.headers.get('content-type') ?? '').includes('text/html')) {
      await shell.body?.cancel().catch(() => undefined);
      return 'stale-build';
    }
    const body = await shell.text();
    return body.includes('id="root"') ? 'healthy' : 'stale-build';
  } catch (error) {
    // The host answered health for this deck but could not deliver the shell.
    // A timeout says nothing definitive about the build, so keep the entry as
    // unknown; any other transport failure is a broken shell, never a
    // stranger, because ownership is already proven.
    return isAbortError(error) ? 'unknown' : 'stale-build';
  }
}

function isConnectionRefused(error: unknown): boolean {
  const cause = (error as { cause?: unknown }).cause;
  return (
    (cause as NodeJS.ErrnoException | undefined)?.code === 'ECONNREFUSED'
  );
}
