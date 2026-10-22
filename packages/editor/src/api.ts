import type {
  DeckRevisionEvent,
  RevisionSource
} from './live-sync';

export interface DeckResponse {
  html: string;
  revision: string;
  filePath: string;
}

export interface SaveDeckOptions {
  force?: boolean;
}

/**
 * The deck storage used by the controller. Host tabs use the HTTP endpoints;
 * standalone tabs switch to File System Access or IndexedDB.
 */
export interface DeckPersistence {
  load(): Promise<DeckResponse>;
  save(
    html: string,
    baseRevision: string,
    options?: SaveDeckOptions
  ): Promise<{ revision: string }>;
  flush(html: string, baseRevision: string): void;
}

export type ExportFormat = 'html' | 'pdf' | 'png';

export class DeckAuthError extends Error {
  readonly status: number;

  constructor(status: number) {
    super(`Failed to load deck (${status})`);
    this.name = 'DeckAuthError';
    this.status = status;
  }
}

export function tokenFromLocation(): string {
  return new URLSearchParams(location.search).get('token') ?? '';
}

export async function fetchDeck(token: string): Promise<DeckResponse> {
  const response = await fetch('/api/deck', {
    headers: { authorization: `Bearer ${token}` }
  });
  if (!response.ok) {
    throw new DeckAuthError(response.status);
  }
  return (await response.json()) as DeckResponse;
}

/**
 * The host rejected a save because the deck moved on. The current host
 * revision travels with the error so the banner can reload the exact state.
 */
export class DeckConflictError extends Error {
  readonly revision: string;

  constructor(revision: string) {
    super('Deck was modified outside the editor');
    this.name = 'DeckConflictError';
    this.revision = revision;
  }
}

function conflictFromPayload(
  status: number,
  payload: unknown
): DeckConflictError | null {
  if (payload !== null && typeof payload === 'object') {
    const body = payload as { error?: unknown; revision?: unknown };
    if (body.error === 'conflict') {
      return new DeckConflictError(
        typeof body.revision === 'string' ? body.revision : ''
      );
    }
  }
  return status === 409 ? new DeckConflictError('') : null;
}

async function readErrorPayload(
  response: Response
): Promise<{ detail: string; payload: unknown }> {
  const detail = await response.text();
  try {
    return { detail, payload: JSON.parse(detail) as unknown };
  } catch {
    return { detail, payload: null };
  }
}

export async function saveDeck(
  token: string,
  html: string,
  baseRevision: string,
  options: SaveDeckOptions = {}
): Promise<{ revision: string }> {
  const response = await fetch('/api/deck', {
    method: 'PUT',
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json'
    },
    body: JSON.stringify({
      html,
      baseRevision,
      ...(options.force ? { force: true } : {})
    })
  });
  if (!response.ok) {
    const { detail, payload } = await readErrorPayload(response);
    const conflict = conflictFromPayload(response.status, payload);
    if (conflict) throw conflict;
    throw new Error(`Save failed (${response.status}): ${detail}`);
  }
  return (await response.json()) as { revision: string };
}

/**
 * Last-chance flush when the page unloads with unsaved edits. EventSource and
 * sendBeacon cannot attach the bearer header, so this is a keepalive fetch.
 * It is best effort: the browser may terminate it, and a conflict is not
 * observable from an unloading page.
 */
export function flushDeck(
  token: string,
  html: string,
  baseRevision: string
): void {
  void fetch('/api/deck', {
    method: 'PUT',
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json'
    },
    body: JSON.stringify({ html, baseRevision }),
    keepalive: true
  }).catch(() => undefined);
}

export function hostPersistence(token: string): DeckPersistence {
  return {
    load: () => fetchDeck(token),
    save: (html, baseRevision, options) =>
      saveDeck(token, html, baseRevision, options),
    flush: (html, baseRevision) => flushDeck(token, html, baseRevision)
  };
}

export async function exportDeck(
  token: string,
  format: ExportFormat,
  outDir?: string
): Promise<string[]> {
  const response = await fetch('/api/export', {
    method: 'POST',
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json'
    },
    body: JSON.stringify({
      format,
      ...(outDir ? { outDir } : {})
    })
  });
  if (!response.ok) {
    const { detail, payload } = await readErrorPayload(response);
    const message =
      payload !== null &&
      typeof payload === 'object' &&
      typeof (payload as { message?: unknown }).message === 'string'
        ? (payload as { message: string }).message
        : detail || `Export failed (${response.status})`;
    throw new Error(message);
  }
  const body = (await response.json()) as { files?: unknown };
  if (!Array.isArray(body.files)) {
    throw new Error('Export response did not list files.');
  }
  return body.files.filter((file): file is string => typeof file === 'string');
}

export function deckEventsUrl(token: string): string {
  return `/api/events?token=${encodeURIComponent(token)}`;
}

function revisionSource(value: unknown): RevisionSource | undefined {
  return value === 'editor' || value === 'external' || value === 'mcp'
    ? value
    : undefined;
}

function parseRevisionEvent(
  type: 'hello' | 'revision',
  raw: string
): DeckRevisionEvent | null {
  let payload: unknown;
  try {
    payload = JSON.parse(raw) as unknown;
  } catch {
    return null;
  }
  if (payload === null || typeof payload !== 'object') return null;
  const body = payload as { revision?: unknown; source?: unknown };
  if (typeof body.revision !== 'string' || !body.revision) return null;
  return {
    type,
    revision: body.revision,
    ...(type === 'revision'
      ? { source: revisionSource(body.source) }
      : {})
  };
}

/**
 * Opens the authenticated SSE stream. EventSource cannot set headers, so the
 * session token travels in the query string; the host accepts it and the
 * token must never be logged.
 */
export function openDeckEvents(
  token: string,
  onEvent: (event: DeckRevisionEvent) => void
): EventSource {
  const source = new EventSource(deckEventsUrl(token));
  const listen = (type: 'hello' | 'revision') => (event: Event) => {
    const message = event as MessageEvent<string>;
    const parsed = parseRevisionEvent(type, String(message.data));
    if (parsed) onEvent(parsed);
  };
  source.addEventListener('hello', listen('hello'));
  source.addEventListener('revision', listen('revision'));
  return source;
}
