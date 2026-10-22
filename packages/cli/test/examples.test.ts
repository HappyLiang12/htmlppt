import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseDeckHtml } from '@htmlppt/core/node';
import { RUNTIME_SOURCE } from '@htmlppt/runtime';
import { beforeAll, describe, expect, it } from 'vitest';

const repoRoot = fileURLToPath(new URL('../../..', import.meta.url));
const examplesDir = join(repoRoot, 'skills', 'htmlppt', 'examples');
const cliBin = join(repoRoot, 'packages', 'cli', 'dist', 'bin.js');
const tsupCli = createRequire(import.meta.url).resolve(
  'tsup/dist/cli-default.js'
);

const EXAMPLES = ['basic.html', 'table-chart.html', 'notes-transitions.html'];

interface BuildStep {
  workspace: string;
  args: string[];
}

const BUILD_STEPS: BuildStep[] = [
  {
    workspace: 'runtime',
    args: ['src/index.ts', '--format', 'esm', '--dts', '--clean']
  },
  {
    workspace: 'core',
    args: ['src/index.ts', 'src/node.ts', '--format', 'esm', '--dts', '--clean']
  },
  {
    workspace: 'host',
    args: ['src/index.ts', '--format', 'esm', '--dts', '--clean']
  },
  // The mcp package's tsup.config.ts supplies its entries and raw-resource plugin.
  { workspace: 'mcp', args: [] },
  { workspace: 'cli', args: [] }
];

function runBuild(step: BuildStep): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [tsupCli, ...step.args], {
      cwd: join(repoRoot, 'packages', step.workspace),
      stdio: ['ignore', 'pipe', 'pipe']
    });
    let output = '';
    child.stdout?.on('data', (chunk: Buffer) => {
      output += chunk.toString();
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      output += chunk.toString();
    });
    child.once('error', reject);
    child.once('close', (code) => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(
        new Error(
          `tsup ${step.workspace} build failed with exit code ${code}:\n${output}`
        )
      );
    });
  });
}

async function buildWorkspace(): Promise<void> {
  for (const step of BUILD_STEPS) {
    await runBuild(step);
  }
}

function runValidate(examplePath: string): Promise<{
  code: number | null;
  stdout: string;
  stderr: string;
}> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cliBin, 'validate', examplePath], {
      cwd: repoRoot,
      stdio: ['ignore', 'pipe', 'pipe']
    });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill();
      reject(
        new Error(
          `validate did not exit in time.\nstdout:\n${stdout}\nstderr:\n${stderr}`
        )
      );
    }, 20_000);
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk: string) => {
      stderr += chunk;
    });
    child.once('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once('close', (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
  });
}

describe('skill example decks', () => {
  beforeAll(async () => {
    await buildWorkspace();
  }, 180_000);

  it.each(EXAMPLES)(
    'validates %s with the built CLI',
    async (name) => {
      const examplePath = join(examplesDir, name);
      const result = await runValidate(examplePath);

      expect(result.code).toBe(0);
      expect(result.stdout).toContain('Deck is valid.');

      const html = await readFile(examplePath, 'utf8');
      expect(html).toContain('data-ppt-runtime="1"');
      expect(html).toContain(RUNTIME_SOURCE.trim());

      const document = parseDeckHtml(html);
      const ids = Array.from(
        document.querySelectorAll('[data-slide-id]')
      ).map((slide) => slide.getAttribute('data-slide-id') ?? '');
      expect(ids.length).toBeGreaterThan(1);
      expect(ids.every((id) => id.length > 0)).toBe(true);
      expect(new Set(ids).size).toBe(ids.length);
    }
  );
});
