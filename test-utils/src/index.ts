import { cp, mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

export async function makeTempDir(prefix = 'htmlppt-'): Promise<string> {
  return mkdtemp(join(tmpdir(), prefix));
}

export const fixturesDir = fileURLToPath(new URL('../fixtures', import.meta.url));

export async function copyFixture(name: string, destinationDir: string): Promise<string> {
  const destination = join(destinationDir, name);
  await cp(join(fixturesDir, name), destination);
  return destination;
}
