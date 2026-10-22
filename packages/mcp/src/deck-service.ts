import path from 'node:path';
import { mutateDeck, normalizeDeck, serializeDeck } from '@htmlppt/core';
import {
  DeckFileConflictError,
  parseDeckHtml,
  readDeckFile,
  writeDeckFileAtomic
} from '@htmlppt/core/node';
import { listSessions } from '@htmlppt/host';

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
      throw await this.errorFor(response);
    }
    const payload = (await response.json()) as {
      html?: unknown;
      revision?: unknown;
      filePath?: unknown;
    };
    if (typeof payload.html !== 'string' || typeof payload.revision !== 'string') {
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
      const payload = await readJson(response);
      const currentRevision =
        typeof payload?.revision === 'string' ? payload.revision : undefined;
      throw new DeckConflictError(
        'The deck changed in the host since it was loaded.',
        currentRevision
      );
    }
    if (!response.ok) {
      throw await this.errorFor(response);
    }
    const payload = await readJson(response);
    if (typeof payload?.revision !== 'string') {
      throw new Error('The host returned no revision.');
    }
    return { revision: payload.revision };
  }

  private request(
    method: 'GET' | 'PUT',
    route: string,
    body?: unknown
  ): Promise<Response> {
    const headers: Record<string, string> = {
      authorization: `Bearer ${this.token}`,
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      ...(method === 'PUT' ? { 'x-htmlppt-source': 'mcp' } : {})
    };
    return fetch(`${this.hostUrl}${route}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body)
    });
  }

  private async errorFor(response: Response): Promise<Error> {
    const detail = await response.text().catch(() => '');
    return new Error(
      `Host request failed with status ${response.status}${detail ? `: ${detail}` : ''}`
    );
  }
}

/**
 * Uses the host that owns the deck when one is available, otherwise writes the
 * file directly. Task 5 adds health verification and the direct-mode override.
 */
export async function createDeckService(
  filePath: string,
  options: DeckServiceOptions = {}
): Promise<DeckService> {
  const { hostUrl, token } = options;
  if (hostUrl !== undefined || token !== undefined) {
    if (!hostUrl || !token) {
      throw new Error('Host mode requires both a host URL and a token.');
    }
    return new HostDeckService({ hostUrl, token });
  }

  const resolved = path.resolve(filePath);
  const sessions = await listSessions();
  const session = sessions.find((entry) => entry.path === resolved);
  if (session) {
    return new HostDeckService({
      hostUrl: `http://127.0.0.1:${session.port}`,
      token: session.token
    });
  }
  return new DirectDeckService();
}

async function readJson(
  response: Response
): Promise<Record<string, unknown> | null> {
  try {
    const value: unknown = await response.json();
    return typeof value === 'object' && value !== null
      ? (value as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}
