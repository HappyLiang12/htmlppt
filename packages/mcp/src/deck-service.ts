import path from 'node:path';
import { mutateDeck, normalizeDeck, serializeDeck } from '@htmlppt/core';
import {
  DeckFileConflictError,
  parseDeckHtml,
  readDeckFile,
  writeDeckFileAtomic
} from '@htmlppt/core/node';
import { isAbortError } from './abort.js';
import { findLiveSession } from './host-session.js';

/**
 * Upper bound for a single host HTTP request. Health checks use a shorter
 * bound because they only read and hash one local file; saves may wait on the
 * host's save lock.
 */
export const HOST_REQUEST_TIMEOUT_MS = 5_000;

export interface DeckSnapshot {
  document: Document;
  html: string;
  revision: string;
  filePath: string;
}

export class DeckConflictError extends Error {
  readonly code = 'conflict' as const;
  readonly currentRevision?: string;

  constructor(
    message = 'The deck changed since it was loaded.',
    currentRevision?: string
  ) {
    super(message);
    this.name = 'DeckConflictError';
    this.currentRevision = currentRevision;
  }
}

export type DeckMutation = (document: Document) => void;

export interface SaveResult {
  revision: string;
  document: Document;
}

export interface DeckService {
  load(filePath: string): Promise<DeckSnapshot>;
  save(
    filePath: string,
    snapshot: DeckSnapshot,
    mutation: DeckMutation
  ): Promise<SaveResult>;
  write(
    filePath: string,
    html: string,
    baseRevision: string
  ): Promise<{ revision: string }>;
}

export interface HostDeckServiceOptions {
  hostUrl: string;
  token: string;
}

export interface DeckServiceOptions {
  hostUrl?: string;
  token?: string;
}

export class DirectDeckService implements DeckService {
  async load(filePath: string): Promise<DeckSnapshot> {
    const file = await readDeckFile(filePath);
    const document = parseDeckHtml(file.html);
    // Missing slide and element ids are assigned in memory only; the file is
    // rewritten the next time a mutation is saved.
    normalizeDeck(document);
    return {
      document,
      html: file.html,
      revision: file.hash,
      filePath: path.resolve(filePath)
    };
  }

  async save(
    filePath: string,
    snapshot: DeckSnapshot,
    mutation: DeckMutation
  ): Promise<SaveResult> {
    const current = await this.readCurrent(filePath);
    if (current.hash !== snapshot.revision) {
      throw new DeckConflictError(
        'The deck changed on disk since it was loaded.',
        current.hash
      );
    }

    const { document } = mutateDeck(snapshot.document, mutation);
    const html = serializeDeck(document);

    let written;
    try {
      written = await writeDeckFileAtomic(filePath, html, snapshot.revision);
    } catch (error) {
      throw await this.toConflict(error, filePath);
    }
    return { revision: written.hash, document };
  }

  async write(
    filePath: string,
    html: string,
    baseRevision: string
  ): Promise<{ revision: string }> {
    try {
      const written = await writeDeckFileAtomic(filePath, html, baseRevision);
      return { revision: written.hash };
    } catch (error) {
      throw await this.toConflict(error, filePath);
    }
  }

  private async readCurrent(filePath: string) {
    try {
      return await readDeckFile(filePath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        throw new DeckConflictError('The deck file no longer exists.');
      }
      throw error;
    }
  }

  private async toConflict(
    error: unknown,
    filePath: string
  ): Promise<DeckConflictError> {
    if (!(error instanceof DeckFileConflictError)) {
      throw error;
    }
    const latest = await readDeckFile(filePath).catch(() => null);
    return new DeckConflictError(
      'The deck changed on disk since it was loaded.',
      latest?.hash
    );
  }
}

export class HostDeckService implements DeckService {
  private readonly hostUrl: string;
  private readonly token: string;

  constructor(options: HostDeckServiceOptions) {
    if (!options.hostUrl) {
      throw new Error('Host mode requires a host URL.');
    }
    if (!options.token) {
      throw new Error('Host mode requires a token.');
    }
    this.hostUrl = options.hostUrl.replace(/\/+$/, '');
    this.token = options.token;
  }

  async load(filePath: string): Promise<DeckSnapshot> {
    const response = await this.request('GET', '/api/deck');
    if (!response.ok) {
      throw await this.errorFor(response, 'GET', '/api/deck');
    }
    const payload = await this.readJson(response, 'GET', '/api/deck');
    if (
      payload === null ||
      typeof payload.html !== 'string' ||
      typeof payload.revision !== 'string'
    ) {
      throw new Error('The host returned an invalid deck payload.');
    }
    const document = parseDeckHtml(payload.html);
    normalizeDeck(document);
    return {
      document,
      html: payload.html,
      revision: payload.revision,
      filePath:
        typeof payload.filePath === 'string'
          ? payload.filePath
          : path.resolve(filePath)
    };
  }

  async save(
    _filePath: string,
    snapshot: DeckSnapshot,
    mutation: DeckMutation
  ): Promise<SaveResult> {
    const { document } = mutateDeck(snapshot.document, mutation);
    const html = serializeDeck(document);
    const { revision } = await this.put(html, snapshot.revision);
    return { revision, document };
  }

  async write(
    _filePath: string,
    html: string,
    baseRevision: string
  ): Promise<{ revision: string }> {
    return this.put(html, baseRevision);
  }

  private async put(
    html: string,
    baseRevision: string
  ): Promise<{ revision: string }> {
    const response = await this.request('PUT', '/api/deck', {
      html,
      baseRevision
    });
    if (response.status === 409) {
      const payload = await this.readJson(response, 'PUT', '/api/deck');
      const currentRevision =
        typeof payload?.revision === 'string' ? payload.revision : undefined;
      throw new DeckConflictError(
        'The deck changed in the host since it was loaded.',
        currentRevision
      );
    }
    if (!response.ok) {
      throw await this.errorFor(response, 'PUT', '/api/deck');
    }
    const payload = await this.readJson(response, 'PUT', '/api/deck');
    if (typeof payload?.revision !== 'string') {
      throw new Error('The host returned no revision.');
    }
    return { revision: payload.revision };
  }

  private async request(
    method: 'GET' | 'PUT',
    route: string,
    body?: unknown
  ): Promise<Response> {
    const headers: Record<string, string> = {
      authorization: `Bearer ${this.token}`,
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      ...(method === 'PUT' ? { 'x-htmlppt-source': 'mcp' } : {})
    };
    try {
      return await fetch(`${this.hostUrl}${route}`, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(HOST_REQUEST_TIMEOUT_MS)
      });
    } catch (error) {
      this.throwIfTimedOut(error, method, route);
      throw error;
    }
  }

  private async readJson(
    response: Response,
    method: 'GET' | 'PUT',
    route: string
  ): Promise<Record<string, unknown> | null> {
    try {
      const value: unknown = await response.json();
      return typeof value === 'object' && value !== null
        ? (value as Record<string, unknown>)
        : null;
    } catch (error) {
      // The request signal also bounds reading the response body.
      this.throwIfTimedOut(error, method, route);
      return null;
    }
  }

  private async errorFor(
    response: Response,
    method: 'GET' | 'PUT',
    route: string
  ): Promise<Error> {
    let detail = '';
    try {
      detail = await response.text();
    } catch (error) {
      this.throwIfTimedOut(error, method, route);
    }
    return new Error(
      `Host request failed with status ${response.status}${detail ? `: ${detail}` : ''}`
    );
  }

  private throwIfTimedOut(
    error: unknown,
    method: 'GET' | 'PUT',
    route: string
  ): void {
    if (isAbortError(error)) {
      throw new Error(
        `Host request ${method} ${route} timed out after ${HOST_REQUEST_TIMEOUT_MS} ms.`
      );
    }
  }
}

/**
 * Uses the host that owns the deck when a registered session is alive and its
 * authenticated health endpoint responds. HTMLPPT_MCP_MODE=direct is a
 * universal override: it forces direct file access even when hostUrl/token are
 * provided. Any other value allows host auto-selection.
 */
export async function createDeckService(
  filePath: string,
  options: DeckServiceOptions = {}
): Promise<DeckService> {
  if (process.env.HTMLPPT_MCP_MODE === 'direct') {
    return new DirectDeckService();
  }

  const { hostUrl, token } = options;
  if (hostUrl !== undefined || token !== undefined) {
    if (!hostUrl || !token) {
      throw new Error('Host mode requires both a host URL and a token.');
    }
    return new HostDeckService({ hostUrl, token });
  }

  const session = await findLiveSession(filePath);
  if (session) {
    return new HostDeckService({
      hostUrl: `http://127.0.0.1:${session.port}`,
      token: session.token
    });
  }
  return new DirectDeckService();
}
