#!/usr/bin/env node
/**
 * Runs the integration suites concurrently and reports every lane.
 *
 * `npm run test:integration` used to chain four `&&` segments, so the box spent
 * the whole run inside one vitest process at a time (measured 3.16 of 6 cores).
 * The segments are independent packages, and the suites that exec built
 * binaries now share a build lock instead of rebuilding blindly, so they can
 * run side by side.
 *
 * Coverage is unchanged: every lane runs, a failing lane still exits non-zero,
 * and no timeout or filter is touched here.
 */
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));

// Longest first (measured serial cost), so the critical path starts earliest
// and its output is at the top of the summary.
const lanes = [
  { name: 'cli', pkg: '@htmlppt/cli' },
  { name: 'renderer', pkg: '@htmlppt/renderer' },
  { name: 'mcp', pkg: '@htmlppt/mcp' },
  { name: 'host', pkg: '@htmlppt/host' }
];

function prefixPipe(stream, tag, sink) {
  let pending = '';
  stream.setEncoding('utf8');
  stream.on('data', (chunk) => {
    pending += chunk;
    const lines = pending.split(/\r?\n/);
    pending = lines.pop() ?? '';
    for (const line of lines) sink(`${tag} ${line}\n`);
  });
  stream.on('end', () => {
    if (pending) sink(`${tag} ${pending}\n`);
  });
}

function runLane(lane, index) {
  return new Promise((resolve) => {
    const startedAt = Date.now();
    const child = spawn(`npm run test -w ${lane.pkg}`, {
      cwd: root,
      shell: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, HTMLPPT_LANE: String(index) }
    });
    prefixPipe(child.stdout, `[${lane.name}]`, (line) => process.stdout.write(line));
    prefixPipe(child.stderr, `[${lane.name}]`, (line) => process.stderr.write(line));
    child.on('exit', (code) => {
      resolve({
        name: lane.name,
        code: code ?? 1,
        seconds: (Date.now() - startedAt) / 1000
      });
    });
  });
}

const wall = Date.now();
const results = await Promise.all(lanes.map((lane, index) => runLane(lane, index)));
const elapsed = (Date.now() - wall) / 1000;

results.sort((a, b) => b.seconds - a.seconds);
process.stdout.write('\nIntegration lanes\n');
for (const result of results) {
  const state = result.code === 0 ? 'passed' : `FAILED (exit ${result.code})`;
  process.stdout.write(`  ${result.name.padEnd(9)} ${result.seconds.toFixed(1)}s  ${state}\n`);
}
process.stdout.write(`  total     ${elapsed.toFixed(1)}s wall across ${results.length} lanes\n`);

const failed = results.filter((result) => result.code !== 0);
if (failed.length > 0) {
  process.stderr.write(
    `\n${failed.length} integration lane(s) failed: ${failed.map((f) => f.name).join(', ')}. ` +
      'Failing lanes are reported in full above; no lane was skipped.\n'
  );
  process.exitCode = 1;
}
