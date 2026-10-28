#!/usr/bin/env node
/**
 * Focused inner-loop commands. Nothing here replaces a gate: `npm run verify`
 * and `npm run verify:fast` stay the authority. This only makes the iterate step
 * cheaper than re-running a whole package.
 *
 *   node scripts/loop.mjs types
 *   node scripts/loop.mjs test packages/editor/src/play-fit.test.ts
 *   node scripts/loop.mjs test core:mutation editor:play-fit
 *   node scripts/loop.mjs e2e e2e/rich-text.spec.ts
 */
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const cacheDir = join(root, 'node_modules', '.tmp', 'tsbuildinfo');

// Keep in step with the `typecheck` workspace script: these tsconfigs are
// exactly what `npm run typecheck` covers.
const projects = [
  'packages/runtime',
  'packages/core',
  'packages/renderer',
  'packages/host',
  'packages/mcp',
  'packages/cli',
  'packages/editor',
  'packages/htmlppt',
  'test-utils',
  '.'
];

// Workspace packages that own a vitest config.
const testPackages = new Map([
  ['packages/core', '@htmlppt/core'],
  ['packages/editor', '@htmlppt/editor'],
  ['packages/host', '@htmlppt/host'],
  ['packages/mcp', '@htmlppt/mcp'],
  ['packages/cli', '@htmlppt/cli'],
  ['packages/renderer', '@htmlppt/renderer']
]);

const packageAlias = new Map(
  [...testPackages].map(([directory, name]) => [name.replace('@htmlppt/', ''), directory])
);

function quote(argument) {
  return /[\s"^]/.test(argument) ? `"${argument.replace(/"/g, '\\"')}"` : argument;
}

function run(command, args, options = {}) {
  return new Promise((resolvePromise, rejectPromise) => {
    const started = Date.now();
    const child = spawn(quote(command) + ' ' + args.map(quote).join(' '), {
      cwd: options.cwd ?? root,
      shell: true,
      stdio: 'inherit'
    });
    child.on('exit', (code) => {
      const elapsed = (Date.now() - started) / 1000;
      if (code === 0) resolvePromise({ elapsed });
      else
        rejectPromise(
          Object.assign(new Error(`${command} ${args.join(' ')} exited ${code}`), { elapsed })
        );
    });
  });
}

const tscBin = join(root, 'node_modules', 'typescript', 'bin', 'tsc');

function cacheFile(project) {
  const hash = createHash('sha1').update(project).digest('hex').slice(0, 10);
  return join(cacheDir, `${project.replace(/[\\/]/g, '_')}-${hash}.tsbuildinfo`);
}

async function types() {
  mkdirSync(cacheDir, { recursive: true });
  // One tsconfig and one tsbuildinfo per project, so the fan-out shares no
  // outputs. That is what makes it different from `npm run build`, which the
  // agent guide keeps serialised on purpose.
  const results = await Promise.allSettled(
    projects.map((project) =>
      run(process.execPath, [
        tscBin,
        '-p',
        `${project}/tsconfig.json`,
        '--noEmit',
        '--incremental',
        '--tsBuildInfoFile',
        cacheFile(project)
      ])
    )
  );
  const failed = results.filter((result) => result.status === 'rejected');
  if (failed.length > 0) {
    for (const failure of failed) console.error(`- ${failure.reason.message}`);
    console.error(`Typecheck failed in ${failed.length}/${projects.length} project(s).`);
    process.exitCode = 1;
    return;
  }
  const slowest = Math.max(...results.map((result) => Number(result.value.elapsed)));
  console.log(
    `Typecheck OK (${projects.length} projects, ${slowest.toFixed(1)}s on the critical path).`
  );
}

function groupFilters(args) {
  const groups = new Map();
  const unqualified = [];
  const add = (directory, pattern) => {
    if (!groups.has(directory)) groups.set(directory, []);
    groups.get(directory).push(pattern);
  };
  for (const arg of args) {
    const named = /^([a-zA-Z]+):(.+)$/.exec(arg);
    if (named && packageAlias.has(named[1])) {
      add(packageAlias.get(named[1]), named[2]);
      continue;
    }
    const owned = [...testPackages.keys()].find(
      (directory) => arg.startsWith(`${directory}/`) || arg.startsWith(`${directory}\\`)
    );
    if (owned) add(owned, arg.slice(owned.length + 1));
    else unqualified.push(arg);
  }
  return { groups, unqualified };
}

async function test(args) {
  if (args.length === 0) {
    await run('npm', ['run', 'test:unit']);
    return;
  }
  const { groups, unqualified } = groupFilters(args);
  if (groups.size > 0 && unqualified.length > 0) {
    console.error(
      'Pass either workspace-relative paths (packages/editor/src/x.test.ts) or ' +
        'pkg:name filters (editor:x), not both.'
    );
    process.exitCode = 2;
    return;
  }
  if (unqualified.length > 0) {
    // Bare names are ambiguous across packages; run the unit layer instead of
    // silently picking one package.
    await run('npm', ['run', 'test:unit', '--', ...unqualified]);
    return;
  }
  for (const [directory, patterns] of groups) {
    console.log(`\n--- ${directory}`);
    await run('npm', ['run', 'test', '-w', testPackages.get(directory), '--', ...patterns]);
  }
}

function walkNewest(directory, stopAt) {
  let newest = 0;
  let probe;
  try {
    probe = statSync(directory);
  } catch {
    return 0;
  }
  if (!probe.isDirectory()) return probe.mtimeMs;
  const stack = [directory];
  while (stack.length > 0) {
    const current = stack.pop();
    let names = [];
    try {
      names = readdirSync(current, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of names) {
      const path = join(current, entry.name);
      if (entry.isDirectory()) {
        if (entry.name !== 'node_modules' && entry.name !== 'dist') stack.push(path);
      } else {
        try {
          newest = Math.max(newest, statSync(path).mtimeMs);
        } catch {
          // Ignore entries that vanish mid-scan.
        }
      }
    }
    if (stopAt && newest > stopAt) return newest;
  }
  return newest;
}

async function e2e(args) {
  const marker = join(root, 'packages', 'editor', 'dist', 'index.html');
  let markerTime = 0;
  try {
    markerTime = statSync(marker).mtimeMs;
  } catch {
    markerTime = 0;
  }
  const sources = ['packages', 'test-utils', 'e2e'].reduce(
    (latest, directory) => Math.max(latest, walkNewest(join(root, directory), markerTime)),
    0
  );
  if (sources > markerTime) {
    console.log('Sources are newer than the built editor; running the build first.');
    await run('npm', ['run', 'build']);
  } else {
    console.log('Built editor is current; skipping the rebuild.');
  }
  await run('npx', ['playwright', 'test', ...args]);
}

const [command, ...args] = process.argv.slice(2);
try {
  if (command === 'types') await types();
  else if (command === 'test') await test(args);
  else if (command === 'e2e') await e2e(args);
  else {
    console.error('Usage: node scripts/loop.mjs <types|test [filters]|e2e [spec]>');
    process.exitCode = 2;
  }
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
