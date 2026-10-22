import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { serializeDeck } from '@htmlppt/core';
import { readSession, sessionKey, sessionsDirectory } from '@htmlppt/host';
import {
  createDeckService,
  type DeckSnapshot,
  type SaveResult
} from './deck-service.js';
import { ToolError } from './errors.js';

const SESSION_POLL_INTERVAL_MS = 100;
const SESSION_TIMEOUT_MS = 5_000;

/**
 * Resolves paths against the server cwd and keeps the last read or written
 * snapshot per file. Mutations compare against that revision so an external
 * edit produces a structured conflict instead of silently overwriting it.
 */
export class DeckAccess {
  private readonly cwd: string;
  private readonly snapshots = new Map<string, DeckSnapshot>();

  constructor(cwd: string) {
    this.cwd = path.resolve(cwd);
  }

  get workingDirectory(): string {
    return this.cwd;
  }

  resolve(input: string): string {
    return path.resolve(this.cwd, input);
  }

  async read(filePath: string): Promise<DeckSnapshot> {
    const service = await createDeckService(filePath);
    const snapshot = await service.load(filePath);
    this.snapshots.set(filePath, snapshot);
    return snapshot;
  }

  async mutate(
    filePath: string,
    mutation: (draft: Document) => void
  ): Promise<SaveResult> {
    const service = await createDeckService(filePath);
    const snapshot =
      this.snapshots.get(filePath) ?? (await service.load(filePath));
    const result = await service.save(filePath, snapshot, mutation);
    this.snapshots.set(filePath, {
      document: result.document,
      html: serializeDeck(result.document),
      revision: result.revision,
      filePath
    });
    return result;
  }

  remember(filePath: string, snapshot: DeckSnapshot): void {
    this.snapshots.set(filePath, snapshot);
  }
}

export function cliBinPath(): string {
  const bundled = fileURLToPath(new URL('./cli.js', import.meta.url));
  if (existsSync(bundled)) return bundled;
  return fileURLToPath(new URL('../../cli/dist/bin.js', import.meta.url));
}

export function hostUrl(port: number, token: string): string {
  return `http://127.0.0.1:${port}/?token=${encodeURIComponent(token)}`;
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

export async function waitForSession(
  filePath: string
): Promise<{ port: number; token: string }> {
  const sessionFile = path.join(
    sessionsDirectory(),
    `${sessionKey(filePath)}.json`
  );
  const deadline = Date.now() + SESSION_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const session = await readSession(sessionFile);
    if (session && session.path === filePath) {
      return { port: session.port, token: session.token };
    }
    await delay(SESSION_POLL_INTERVAL_MS);
  }
  throw new ToolError(
    'editor-timeout',
    'The editor did not write a session within 5 seconds. Run "htmlppt open <path> --no-browser" manually and check that the editor build exists.'
  );
}
