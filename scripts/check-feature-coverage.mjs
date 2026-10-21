import { existsSync } from 'node:fs';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = new URL('..', import.meta.url);
const e2eDir = fileURLToPath(new URL('e2e/', root));
const manifestPath = fileURLToPath(new URL('docs/features.json', root));
const tagPattern = /@feature:([a-z0-9-]+)/g;

async function collectFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...(await collectFiles(path)));
    else if (entry.isFile() && entry.name.endsWith('.spec.ts')) files.push(path);
  }
  return files;
}

const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
const files = existsSync(e2eDir) ? await collectFiles(e2eDir) : [];
const tags = new Set();

for (const file of files) {
  const source = await readFile(file, 'utf8');
  for (const match of source.matchAll(tagPattern)) tags.add(match[1]);
}

const errors = [];
const known = new Map(manifest.features.map((feature) => [feature.id, feature]));

for (const feature of manifest.features) {
  if (feature.status === 'active' && !tags.has(feature.id)) {
    errors.push(`Active feature "${feature.id}" has no @feature:${feature.id} test.`);
  }
}

for (const tag of tags) {
  if (!known.has(tag)) {
    errors.push(`Test tag @feature:${tag} has no entry in docs/features.json.`);
  }
}

if (errors.length > 0) {
  console.error('Feature matrix check failed:');
  for (const error of errors) console.error(`- ${error}`);
  process.exit(1);
}

console.log(
  `Feature matrix OK: ${manifest.features.filter((f) => f.status === 'active').length} active, ${tags.size} tagged test feature(s).`
);
