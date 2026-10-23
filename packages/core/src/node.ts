import { createHash, randomUUID } from 'node:crypto';
import {
  access,
  link,
  open,
  readFile,
  rename,
  rm,
  stat,
  writeFile
} from 'node:fs/promises';
import path from 'node:path';
import { parseHTML } from 'linkedom';

const fileQueues = new Map<string, Promise<unknown>>();

// Hard links are rejected on some Windows volumes and network shares even
// though the source and destination share a filesystem.
const LINK_UNSUPPORTED_CODES = new Set([
  'EACCES',
  'ENOSYS',
  'EOPNOTSUPP',
  'EPERM',
  'EXDEV'
]);

const RENAME_RETRY_CODES = new Set(['EACCES', 'EBUSY', 'EPERM']);

// Windows antivirus and indexers can briefly hold a freshly written file.
async function renameReplacing(from: string, to: string): Promise<void> {
  for (let attempt = 0; ; attempt++) {
    try {
      await rename(from, to);
      return;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (attempt >= 4 || !code || !RENAME_RETRY_CODES.has(code)) throw error;
      await new Promise((resolve) => setTimeout(resolve, 25 * (attempt + 1)));
    }
  }
}

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

export class DeckFileExistsError extends Error {
  readonly code = 'file-exists' as const;

  constructor(filePath: string) {
    super(
      `Deck already exists: ${filePath}. Choose another path instead of overwriting it.`
    );
    this.name = 'DeckFileExistsError';
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

    await renameReplacing(temporaryPath, filePath);
  } finally {
    await rm(temporaryPath, { force: true });
  }

  const stats = await stat(filePath);
  return { hash: hashHtml(html), mtimeMs: stats.mtimeMs };
}

/**
 * Creates a new deck without replacing an existing file. The content is
 * written to a unique temporary file in the destination directory, flushed,
 * and then hard-linked into place. A link never replaces an existing path, so
 * readers only ever observe the complete deck or no file at all.
 */
export async function createDeckFileAtomic(
  filePath: string,
  html: string
): Promise<DeckWriteResult> {
  return withFileLock(filePath, () =>
    createDeckFileAtomicLocked(filePath, html)
  );
}

async function createDeckFileAtomicLocked(
  filePath: string,
  html: string
): Promise<DeckWriteResult> {
  const temporaryPath = path.join(
    path.dirname(filePath),
    `.${path.basename(filePath)}.${randomUUID()}.htmlppt.tmp`
  );
  try {
    const handle = await open(temporaryPath, 'wx');
    try {
      await handle.writeFile(html, 'utf8');
      await handle.sync();
    } finally {
      await handle.close();
    }

    try {
      await link(temporaryPath, filePath);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === 'EEXIST' || code === 'EISDIR') {
        throw new DeckFileExistsError(filePath);
      }
      if (!code || !LINK_UNSUPPORTED_CODES.has(code)) {
        throw error;
      }
      // Some Windows volumes and network shares reject hard links. Verify the
      // destination is still absent and rename the finished temporary file
      // instead. This leaves a small check-to-rename window that `link` does
      // not have, so it is only used when the platform cannot link.
      if (await destinationExists(filePath)) {
        throw new DeckFileExistsError(filePath);
      }
      await renameReplacing(temporaryPath, filePath);
    }
  } finally {
    await rm(temporaryPath, { force: true });
  }

  const stats = await stat(filePath);
  return { hash: hashHtml(html), mtimeMs: stats.mtimeMs };
}

async function destinationExists(filePath: string): Promise<boolean> {
  try {
    await access(filePath);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
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
