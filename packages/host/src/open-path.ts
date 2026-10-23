import { realpath } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export type OpenPathErrorCode =
  | 'invalid-path'
  | 'not-found'
  | 'unsupported-extension';

export class OpenPathError extends Error {
  readonly code: OpenPathErrorCode;

  constructor(code: OpenPathErrorCode) {
    super(code);
    this.name = 'OpenPathError';
    this.code = code;
  }
}

function unquote(value: string): string {
  const trimmed = value.trim();
  if (trimmed.length < 2) return trimmed;
  const first = trimmed[0];
  const last = trimmed[trimmed.length - 1];
  if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
    return trimmed.slice(1, -1).trim();
  }
  return trimmed;
}

export async function resolveDeckPath(
  input: string,
  cwd = process.cwd(),
  home = homedir()
): Promise<string> {
  let value = unquote(input);
  if (!value) throw new OpenPathError('invalid-path');

  if (value.startsWith('file://')) {
    try {
      value = fileURLToPath(value);
    } catch {
      throw new OpenPathError('invalid-path');
    }
  } else if (value === '~') {
    value = home;
  } else if (value.startsWith('~/') || value.startsWith('~\\')) {
    value = path.join(home, value.slice(2));
  }

  const resolved = path.resolve(cwd, value);

  let canonical: string;
  try {
    canonical = await realpath(resolved);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    throw new OpenPathError(code === 'ENOENT' ? 'not-found' : 'invalid-path');
  }

  if (!/\.html?$/i.test(canonical)) {
    throw new OpenPathError('unsupported-extension');
  }
  return canonical;
}
