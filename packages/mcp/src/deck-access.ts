import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { serializeDeck } from '@htmlppt/core';
import { readSession, sessionKey, sessionsDirectory } from '@htmlppt/host';
import {
  createDeckService,
  type DeckSnapshot,
  type ExportFormat,
  type SaveResult
} from './deck-service.js';
import { ToolError } from './errors.js';
import {
  INVALID_OUT_DIR_MESSAGE,
  resolveExportDirectory
} from './export-path.js';
import { probeSessionHealth } from './host-session.js';

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

  async exportDeck(
    filePath: string,
    format: ExportFormat,
    outDir?: string
  ): Promise<string[]> {
    const directory = await resolveExportDirectory(filePath, outDir);
    if (directory === null) {
      throw new ToolError('invalid-out-dir', INVALID_OUT_DIR_MESSAGE);
    }
    const service = await createDeckService(filePath);
    return service.exportFiles(filePath, format, directory);
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

/**
 * The exit state of a spawned editor CLI, observed without touching its stdio.
 * Successful opens keep the detached child alive as the host, so the parent
 * only reads the exit fields instead of holding pipes open for its lifetime.
 */
export interface SpawnedEditorStatus {
  readonly exitCode: number | null;
  readonly signalCode: NodeJS.Signals | null;
}

/**
 * Describes a spawned CLI that exited before publishing a session. Successful
 * opens keep the detached child alive as the host, so the parent only reads
 * these fields instead of holding pipes open for its lifetime.
 */
function spawnedEditorFailure(
  filePath: string,
  status: SpawnedEditorStatus
): ToolError | null {
  if (status.exitCode !== null && status.exitCode !== 0) {
    return new ToolError(
      'editor-failed',
      `The editor host process exited with code ${status.exitCode} before publishing a session for ${filePath}. Run "htmlppt open <path> --no-browser" in a terminal to see the error.`
    );
  }
  if (status.signalCode !== null) {
    return new ToolError(
      'editor-failed',
      `The editor host process was terminated by ${status.signalCode} before publishing a session for ${filePath}. Run "htmlppt open <path> --no-browser" in a terminal to see the error.`
    );
  }
  return null;
}

/**
 * Waits for the session the spawned CLI registers to become a usable editor.
 * A registry entry alone is not proof: a host can answer `/api/health` while
 * its editor shell is broken, so only a `healthy` probe makes the URL
 * eligible. Stale-build and unknown entries stay registered for `stop` and
 * are deliberately not reported as a successful open.
 *
 * When the caller passes the spawned CLI, an early exit fails the wait with
 * `editor-failed` instead of polling until the timeout. The CLI's refusal is
 * otherwise lost because its stdio is ignored.
 */
export async function waitForSession(
  filePath: string,
  spawned?: SpawnedEditorStatus
): Promise<{ port: number; token: string }> {
  const sessionFile = path.join(
    sessionsDirectory(),
    `${sessionKey(filePath)}.json`
  );
  const deadline = Date.now() + SESSION_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (spawned) {
      const failure = spawnedEditorFailure(filePath, spawned);
      if (failure) {
        throw failure;
      }
    }
    const session = await readSession(sessionFile);
    if (
      session &&
      session.path === filePath &&
      (await probeSessionHealth(session)) === 'healthy'
    ) {
      return { port: session.port, token: session.token };
    }
    await delay(SESSION_POLL_INTERVAL_MS);
  }
  throw new ToolError(
    'editor-timeout',
    'No healthy editor session appeared within 5 seconds. Run "htmlppt open <path> --no-browser" manually and check that the editor build exists.'
  );
}
