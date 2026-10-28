import { spawn } from 'node:child_process';
import {
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync
} from 'node:fs';
import { cp, mkdtemp } from 'node:fs/promises';
import { createServer } from 'node:net';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

export async function makeTempDir(prefix = 'htmlppt-'): Promise<string> {
  return mkdtemp(join(tmpdir(), prefix));
}

export const fixturesDir = fileURLToPath(new URL('../fixtures', import.meta.url));

export async function copyFixture(name: string, destinationDir: string): Promise<string> {
  const destination = join(destinationDir, name);
  await cp(join(fixturesDir, name), destination, { recursive: true });
  return destination;
}

const repoRoot = fileURLToPath(new URL('../..', import.meta.url));

export type BuiltWorkspace = 'runtime' | 'core' | 'host' | 'mcp' | 'cli';

export interface BuildStep {
  workspace: BuiltWorkspace;
  args: string[];
  /** Files the suites exec, so "fresh" must be proved per output. */
  outputs: string[];
}

/**
 * The five tsup builds the CLI and MCP suites used to repeat in their own
 * `beforeAll`. `npm run build` produces the same outputs, so a suite only has
 * to build when it is run on its own against a stale or missing dist.
 */
export const INTEGRATION_BUILD_STEPS: BuildStep[] = [
  {
    workspace: 'runtime',
    args: ['src/index.ts', '--format', 'esm', '--dts', '--clean'],
    outputs: ['dist/index.js']
  },
  {
    workspace: 'core',
    args: ['src/index.ts', 'src/node.ts', '--format', 'esm', '--dts', '--clean'],
    outputs: ['dist/index.js', 'dist/node.js']
  },
  {
    workspace: 'host',
    args: ['src/index.ts', '--format', 'esm', '--dts', '--clean'],
    outputs: ['dist/index.js']
  },
  // The mcp package's tsup.config.ts supplies its entries and raw-resource plugin.
  { workspace: 'mcp', args: [], outputs: ['dist/index.js', 'dist/bin.js'] },
  { workspace: 'cli', args: [], outputs: ['dist/bin.js'] }
];

const tsupCli = createRequire(import.meta.url).resolve('tsup/dist/cli-default.js');

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function walkNewest(directory: string): number {
  let newest = 0;
  let names;
  try {
    names = readdirSync(directory, { withFileTypes: true });
  } catch {
    return 0;
  }
  for (const entry of names) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) newest = Math.max(newest, walkNewest(path));
    else {
      try {
        newest = Math.max(newest, statSync(path).mtimeMs);
      } catch {
        // A file that vanished mid-scan cannot be newer than the output.
      }
    }
  }
  return newest;
}

function newestSourceTime(workspaces: BuiltWorkspace[]): number {
  let newest = 0;
  for (const workspace of workspaces) {
    const dir = join(repoRoot, 'packages', workspace);
    // A dependency source change also invalidates its consumers, because tsup
    // bundles the aliased workspace sources rather than resolving them at run
    // time. Comparing against the union of all five is deliberately coarse.
    newest = Math.max(newest, walkNewest(join(dir, 'src')));
    for (const file of ['tsup.config.ts', 'package.json']) {
      try {
        newest = Math.max(newest, statSync(join(dir, file)).mtimeMs);
      } catch {
        // Optional file.
      }
    }
  }
  return newest;
}

function isOutputFresh(step: BuildStep, output: string, newestSource: number): boolean {
  try {
    return statSync(join(repoRoot, 'packages', step.workspace, output)).mtimeMs >= newestSource;
  } catch {
    return false;
  }
}

function isStepFresh(step: BuildStep, newestSource: number): boolean {
  return step.outputs.every((output) => isOutputFresh(step, output, newestSource));
}

function runTsup(step: BuildStep): Promise<void> {
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
      reject(new Error(`tsup ${step.workspace} build failed with exit code ${code}:\n${output}`));
    });
  });
}

const lockDir = join(tmpdir(), 'htmlppt-build-lock');
const lockStaleMs = 10 * 60 * 1000;

/**
 * tsup runs with `--clean`, which deletes a dist that another lane may be
 * exec'ing. Suites therefore take a cross-process lock before rebuilding, so
 * concurrent lanes never wipe each other's binaries.
 */
async function acquireLock(timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      mkdirSync(lockDir);
      try {
        writeFileSync(join(lockDir, 'owner'), `${process.pid}|${Date.now()}`);
      } catch {
        // The lock is still held even if the owner stamp cannot be written.
      }
      return;
    } catch {
      let ownerStamp = Number.NaN;
      try {
        ownerStamp = Number(readFileSync(join(lockDir, 'owner'), 'utf8').split('|')[1]);
      } catch {
        // A holder that has not stamped yet is treated as fresh.
      }
      if (Number.isFinite(ownerStamp) && Date.now() - ownerStamp > lockStaleMs) {
        rmSync(lockDir, { recursive: true, force: true });
        continue;
      }
      if (Date.now() > deadline) {
        throw new Error(
          `Timed out waiting for the shared build lock at ${lockDir}. ` +
            'Remove that directory if a crashed run left it behind.'
        );
      }
      await sleep(200);
    }
  }
}

function releaseLock(): void {
  rmSync(lockDir, { recursive: true, force: true });
}

/**
 * Builds only the workspaces whose dist is older than any workspace source.
 * Returns the workspaces that were rebuilt, so a suite can prove a skip was
 * real rather than a missing assertion.
 */
export async function ensureBuiltWorkspaces(
  steps: BuildStep[] = INTEGRATION_BUILD_STEPS
): Promise<BuiltWorkspace[]> {
  const newest = newestSourceTime(steps.map((step) => step.workspace));
  if (steps.every((step) => isStepFresh(step, newest))) return [];
  await acquireLock(150_000);
  try {
    const rechecked = newestSourceTime(steps.map((step) => step.workspace));
    const stale = steps.filter((step) => !isStepFresh(step, rechecked));
    for (const step of stale) await runTsup(step);
    return stale.map((step) => step.workspace);
  } finally {
    releaseLock();
  }
}

const laneBlockSize = 64;
const laneBlockFloor = 20000;
let laneCursor = 0;

function lanePortBase(): number {
  const declared = Number.parseInt(process.env.HTMLPPT_LANE ?? '', 10);
  const index = Number.isFinite(declared) ? declared : process.pid;
  return laneBlockFloor + (index % 64) * laneBlockSize;
}

/**
 * Binds a port from this lane's own block instead of asking the OS for an
 * ephemeral one. A lane then never hands a peer lane a port number that the
 * dynamic range can later reissue, which is what made the fixed-port CLI tests
 * race once suites ran side by side.
 */
export async function bindToLanePort(
  server: ReturnType<typeof createServer>,
  attempts = 8
): Promise<number> {
  const base = lanePortBase();
  let lastError: unknown;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const port = base + ((laneCursor + attempt) % laneBlockSize);
    try {
      await new Promise<void>((resolve, reject) => {
        const onError = (error: Error) => reject(error);
        server.once('error', onError);
        server.listen(port, '127.0.0.1', () => {
          server.removeListener('error', onError);
          resolve();
        });
      });
      laneCursor = (port - base + 1) % laneBlockSize;
      return port;
    } catch (error) {
      lastError = error;
      if ((error as NodeJS.ErrnoException).code !== 'EADDRINUSE') throw error;
    }
  }
  throw new Error(
    `No free port in lane block ${base}-${base + laneBlockSize - 1}: ${String(lastError)}`
  );
}

/** Reserves a lane port and releases it again, for tests that need it unbound. */
export async function allocateLanePort(): Promise<number> {
  const probe = createServer();
  const port = await bindToLanePort(probe);
  await new Promise<void>((resolve, reject) => {
    probe.close((error) => (error ? reject(error) : resolve()));
  });
  return port;
}
