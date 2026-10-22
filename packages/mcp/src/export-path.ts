import { realpath } from 'node:fs/promises';
import path from 'node:path';

export const INVALID_OUT_DIR_MESSAGE =
  'outDir must stay inside the deck directory. Choose a relative path such as "exports".';

function isInside(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return (
    relative === '' ||
    (!path.isAbsolute(relative) &&
      relative !== '..' &&
      !relative.startsWith(`..${path.sep}`))
  );
}

/**
 * Re-checks an already-created directory through realpath, so a symlink
 * swapped in between resolution and creation cannot redirect writes outside
 * the deck directory.
 */
export async function verifyExportDirectory(
  deckPath: string,
  directory: string
): Promise<string | null> {
  try {
    const root = await realpath(path.dirname(path.resolve(deckPath)));
    const canonical = await realpath(directory);
    return isInside(root, canonical) ? canonical : null;
  } catch {
    return null;
  }
}

/** Compares two paths after resolution, including symlink aliases. */
export async function sameFilePath(
  first: string,
  second: string
): Promise<boolean> {
  const fold = (value: string) =>
    process.platform === 'win32' || process.platform === 'darwin'
      ? value.toLowerCase()
      : value;
  const left = path.resolve(first);
  const right = path.resolve(second);
  if (fold(left) === fold(right)) return true;
  try {
    return fold(await realpath(left)) === fold(await realpath(right));
  } catch {
    return false;
  }
}

/**
 * Resolves `requested` against the deck directory and confirms the result is
 * inside it, including through symlinks that already exist. Returns null when
 * the directory escapes; the caller creates it only after this check.
 */
export async function resolveExportDirectory(
  deckPath: string,
  requested?: string
): Promise<string | null> {
  if (requested !== undefined && requested.trim() === '') {
    return null;
  }
  const root = path.resolve(path.dirname(path.resolve(deckPath)));
  const target = path.resolve(root, requested ?? '.');
  if (!isInside(root, target)) {
    return null;
  }
  // The deck directory itself is inherently contained; keep its authored
  // spelling instead of replacing it with a canonical realpath.
  if (target === root) {
    return root;
  }
  let existing = target;
  const missing: string[] = [];
  for (;;) {
    try {
      const canonicalRoot = await realpath(root);
      const canonicalCandidate = path.join(
        await realpath(existing),
        ...missing.reverse()
      );
      return isInside(canonicalRoot, canonicalCandidate)
        ? canonicalCandidate
        : null;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        throw error;
      }
      const parent = path.dirname(existing);
      if (parent === existing) {
        return null;
      }
      missing.push(path.basename(existing));
      existing = parent;
    }
  }
}
