import { access, cp, mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const packageDir = fileURLToPath(new URL('..', import.meta.url));
const repoRoot = join(packageDir, '..', '..');
const distDir = join(packageDir, 'dist');
const editorSource = join(repoRoot, 'packages', 'editor', 'dist');
const skillSource = join(repoRoot, 'skills', 'htmlppt');

async function requireDirectory(directory, hint) {
  try {
    await access(directory);
  } catch {
    throw new Error(`${hint}: ${directory}`);
  }
}

await requireDirectory(
  editorSource,
  'Editor build not found. Run "npm run build -w @htmlppt/editor" first'
);
await requireDirectory(
  skillSource,
  'Skill sources not found. Restore skills/htmlppt'
);

await mkdir(distDir, { recursive: true });
await rm(join(distDir, 'editor'), { recursive: true, force: true });
await rm(join(distDir, 'skill'), { recursive: true, force: true });
await cp(editorSource, join(distDir, 'editor'), { recursive: true });
await cp(skillSource, join(distDir, 'skill'), { recursive: true });

await access(join(distDir, 'editor', 'index.html'));
await access(join(distDir, 'skill', 'SKILL.md'));
console.log('Copied editor build and skill into dist/.');
