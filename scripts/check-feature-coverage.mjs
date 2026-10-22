import { existsSync } from 'node:fs';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = new URL('..', import.meta.url);
const e2eDir = fileURLToPath(new URL('e2e/', root));
const packagesDir = fileURLToPath(new URL('packages/', root));
const manifestPath = fileURLToPath(new URL('docs/features.json', root));
const tagPattern = /@feature:([a-z0-9-]+)/g;

async function collectFiles(directory, suffix) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...(await collectFiles(path, suffix)));
    else if (entry.isFile() && entry.name.endsWith(suffix)) files.push(path);
  }
  return files;
}

/**
 * Feature tags may live in E2E specs (user-visible behavior) or package
 * integration tests (for example the MCP stdio server). Package sources,
 * fixtures, and node_modules are never scanned.
 */
async function collectTaggedSources() {
  const sources = [];
  if (existsSync(e2eDir)) {
    sources.push(...(await collectFiles(e2eDir, '.spec.ts')));
  }
  if (existsSync(packagesDir)) {
    for (const entry of await readdir(packagesDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const testDir = join(packagesDir, entry.name, 'test');
      if (existsSync(testDir)) {
        sources.push(...(await collectFiles(testDir, '.test.ts')));
      }
    }
  }
  return sources;
}

const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
const sources = await collectTaggedSources();
const tags = new Set();

for (const file of sources) {
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
