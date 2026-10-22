import { createHash, randomUUID } from 'node:crypto';
import { open, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { parseHTML } from 'linkedom';

const fileQueues = new Map<string, Promise<unknown>>();

export function parseDeckHtml(html: string): Document {
  const { document } = parseHTML(html);
  return document as unknown as Document;
}

export function hashHtml(html: string): string {
  return createHash('sha256').update(html).digest('hex');
}

export interface DeckFileSnapshot {
  html: string;
  hash: string;
  mtimeMs: number;
}

export interface DeckWriteResult {
  hash: string;
  mtimeMs: number;
}

export class DeckFileConflictError extends Error {
  readonly code = 'conflict' as const;

  constructor(message = 'Deck file changed on disk.') {
    super(message);
    this.name = 'DeckFileConflictError';
  }
}

export async function readDeckFile(filePath: string): Promise<DeckFileSnapshot> {
  return withFileLock(filePath, async () => {
    const handle = await open(filePath, 'r');
    try {
      const html = await handle.readFile({ encoding: 'utf8' });
      const stats = await handle.stat();
      return { html, hash: hashHtml(html), mtimeMs: stats.mtimeMs };
    } finally {
      await handle.close();
    }
  });
}

/**
 * Compares the on-disk content with `expectedHash` and, when it still matches,
 * replaces the file via a unique temporary file and a rename.
 */
export async function writeDeckFileAtomic(
  filePath: string,
  html: string,
  expectedHash?: string
): Promise<DeckWriteResult> {
  return withFileLock(filePath, () =>
    writeDeckFileAtomicLocked(filePath, html, expectedHash)
  );
}

async function writeDeckFileAtomicLocked(
  filePath: string,
  html: string,
  expectedHash?: string
): Promise<DeckWriteResult> {
  if (expectedHash !== undefined) {
    await assertCurrentHash(filePath, expectedHash);
  }

  const temporaryPath = path.join(
    path.dirname(filePath),
    `.${path.basename(filePath)}.${randomUUID()}.htmlppt.tmp`
  );
  try {
    await writeFile(temporaryPath, html, 'utf8');

    // Re-check after the temp write: the file may have been replaced since the
    // hash accepted for this save. The compare-to-rename window remains open;
    // that is inherent to local filesystems.
    if (expectedHash !== undefined) {
      await assertCurrentHash(filePath, expectedHash);
    }

    await rename(temporaryPath, filePath);
  } finally {
    await rm(temporaryPath, { force: true });
  }

  const stats = await stat(filePath);
  return { hash: hashHtml(html), mtimeMs: stats.mtimeMs };
}

async function assertCurrentHash(
  filePath: string,
  expectedHash: string
): Promise<void> {
  let currentHtml: string;
  try {
    currentHtml = await readFile(filePath, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new DeckFileConflictError();
    }
    throw error;
  }

  if (hashHtml(currentHtml) !== expectedHash) {
    throw new DeckFileConflictError();
  }
}

/**
 * Serializes reads and writes per file so this process never opens a path
 * while it is being replaced and concurrent compare-and-swap writers queue
 * instead of racing.
 */
function withFileLock<T>(
  filePath: string,
  task: () => Promise<T>
): Promise<T> {
  const key = path.resolve(filePath);
  const previous = fileQueues.get(key) ?? Promise.resolve();
  const run = previous.then(task, task);
  const settled = run.then(
    () => undefined,
    () => undefined
  );
  fileQueues.set(key, settled);
  return run.finally(() => {
    if (fileQueues.get(key) === settled) {
      fileQueues.delete(key);
    }
  });
}
