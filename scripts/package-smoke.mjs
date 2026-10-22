#!/usr/bin/env node
// Packaging smoke test: packs the real `htmlppt` tarball, installs it into an
// empty temporary project, and exercises the installed bins and assets.
//
// No global install, no workspace links, no mocks: every command below runs
// against the files that `npm pack` produced.
import { execFile, spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const repoRoot = fileURLToPath(new URL('..', import.meta.url));
const packageDir = join(repoRoot, 'packages', 'htmlppt');

const COMMAND_TIMEOUT_MS = 120_000;
const HOST_START_TIMEOUT_MS = 30_000;
const EDITOR_FETCH_TIMEOUT_MS = 10_000;
const PROCESS_EXIT_TIMEOUT_MS = 10_000;
const MCP_TIMEOUT_MS = 20_000;

const liveChildren = new Set();

class SmokeError extends Error {}

function assert(condition, message) {
  if (!condition) throw new SmokeError(message);
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function assertExists(path, description) {
  try {
    await readFile(path);
  } catch {
    throw new SmokeError(`${description} is missing: ${path}`);
  }
}

async function runCommand(label, command, args, options = {}) {
  const started = Date.now();
  try {
    const result = await execFileAsync(command, args, {
      cwd: options.cwd,
      env: options.env,
      timeout: options.timeoutMs ?? COMMAND_TIMEOUT_MS,
      maxBuffer: 20 * 1024 * 1024,
      windowsHide: true,
      encoding: 'utf8'
    });
    const duration = Date.now() - started;
    console.log(`  ok ${label} (${duration} ms)`);
    return { stdout: result.stdout, stderr: result.stderr };
  } catch (error) {
    const stdout = typeof error.stdout === 'string' ? error.stdout.trim() : '';
    const stderr = typeof error.stderr === 'string' ? error.stderr.trim() : '';
    const reason = error.killed
      ? `timed out after ${options.timeoutMs ?? COMMAND_TIMEOUT_MS} ms`
      : `exited with ${error.code ?? error.signal ?? 'an error'}`;
    throw new SmokeError(
      `${label} ${reason}.\n--- stdout ---\n${stdout}\n--- stderr ---\n${stderr}`
    );
  }
}

/**
 * A long-lived installed bin. Output is collected line by line so the smoke
 * test can wait for a URL or a JSON-RPC response with an explicit deadline.
 */
class ProcessSession {
  constructor(label, command, args, options) {
    this.label = label;
    this.lines = [];
    this.stdout = '';
    this.stderr = '';
    this.closed = false;
    this.exitCode = null;
    this.signal = null;
    this.child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env,
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true
    });
    liveChildren.add(this.child);
    this.child.stdout.setEncoding('utf8');
    let buffered = '';
    this.child.stdout.on('data', (chunk) => {
      this.stdout += chunk;
      buffered += chunk;
      for (;;) {
        const newline = buffered.indexOf('\n');
        if (newline < 0) break;
        const line = buffered.slice(0, newline).replace(/\r$/, '');
        buffered = buffered.slice(newline + 1);
        if (line.length > 0) this.lines.push(line);
      }
    });
    this.child.stderr.setEncoding('utf8');
    this.child.stderr.on('data', (chunk) => {
      this.stderr += chunk;
    });
    this.closedPromise = new Promise((resolve) => {
      this.child.once('error', () => {
        this.closed = true;
        resolve();
      });
      this.child.once('close', (code, signal) => {
        this.exitCode = code;
        this.signal = signal;
        this.closed = true;
        resolve();
      });
    }).finally(() => liveChildren.delete(this.child));
  }

  describeOutput() {
    return `--- ${this.label} stdout ---\n${this.stdout.trim()}\n--- ${this.label} stderr ---\n${this.stderr.trim()}`;
  }

  async waitForLine(predicate, timeoutMs, description) {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const line = this.lines.find((candidate) => predicate(candidate));
      if (line !== undefined) return line;
      if (this.closed) {
        throw new SmokeError(
          `${this.label} exited before ${description}.\n${this.describeOutput()}`
        );
      }
      if (Date.now() >= deadline) {
        throw new SmokeError(
          `${this.label} timed out after ${timeoutMs} ms waiting for ${description}.\n${this.describeOutput()}`
        );
      }
      await delay(25);
    }
  }

  async waitForClose(timeoutMs, description) {
    if (this.closed) return;
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(
          new SmokeError(
            `${this.label} did not ${description} within ${timeoutMs} ms.\n${this.describeOutput()}`
          )
        );
      }, timeoutMs);
      this.closedPromise.then(() => {
        clearTimeout(timer);
        resolve();
      });
    });
  }

  async stop() {
    if (this.closed) return;
    this.child.kill('SIGKILL');
    try {
      await this.waitForClose(5_000, 'exit after SIGKILL');
    } catch {
      // The process is already being torn down; cleanup must not mask the
      // original assertion.
    }
  }
}

function npmCliPath() {
  const candidates = [];
  if (process.env.npm_execpath) candidates.push(process.env.npm_execpath);
  const nodeDir = dirname(process.execPath);
  candidates.push(
    // Windows and some Node installers.
    join(nodeDir, 'node_modules', 'npm', 'bin', 'npm-cli.js'),
    // nvm / distro Node layouts.
    join(nodeDir, 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js'),
    join(nodeDir, '..', 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js')
  );
  const found = candidates.find((candidate) => existsSync(candidate));
  assert(
    found !== undefined,
    'Could not locate npm-cli.js. Run this script through "npm run test:package".'
  );
  return found;
}

function parsePackOutput(stdout) {
  const start = stdout.indexOf('[');
  const end = stdout.lastIndexOf(']');
  assert(start >= 0 && end > start, `npm pack did not print JSON:\n${stdout}`);
  const entries = JSON.parse(stdout.slice(start, end + 1));
  assert(Array.isArray(entries) && entries.length === 1, 'npm pack returned no tarball.');
  return entries[0];
}

async function assertHostStopped(url, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(500) });
      await response.body?.cancel().catch(() => undefined);
    } catch {
      return;
    }
    if (Date.now() >= deadline) {
      throw new SmokeError(`The editor host still answers ${url} after it exited.`);
    }
    await delay(100);
  }
}

async function main() {
  const startedAt = Date.now();
  const manifestPath = join(packageDir, 'package.json');
  if (!existsSync(manifestPath)) {
    throw new SmokeError(
      `packages/htmlppt/package.json does not exist. The installable package has not been created yet.`
    );
  }

  const npmCli = npmCliPath();
  let tempRoot;
  let hostSession;
  let mcpSession;

  try {
    // Setup runs inside the try so a failed mkdir still reaches cleanup.
    tempRoot = await mkdtemp(join(tmpdir(), 'htmlppt-package-smoke-'));
    const packDir = join(tempRoot, 'pack');
    const projectDir = join(tempRoot, 'project');
    const homeDir = join(tempRoot, 'home');
    await mkdir(packDir);
    await mkdir(projectDir);
    await mkdir(homeDir);

    const childEnv = {
      ...process.env,
      HTMLPPT_HOME: homeDir,
      // Force the packaged editor lookup; the temp project has no workspace.
      HTMLPPT_EDITOR_DIR: undefined,
      HTMLPPT_MCP_MODE: undefined
    };
    delete childEnv.HTMLPPT_EDITOR_DIR;
    delete childEnv.HTMLPPT_MCP_MODE;

    console.log('1. packing packages/htmlppt');
    const packed = parsePackOutput(
      (
        await runCommand('npm pack', process.execPath, [
          npmCli,
          'pack',
          '--json',
          '--pack-destination',
          packDir
        ], { cwd: packageDir })
      ).stdout
    );
    const tarball = join(packDir, packed.filename);
    assert(existsSync(tarball), `npm pack did not create ${tarball}`);
    assert(packed.name === 'htmlppt', `tarball name is ${packed.name}, expected htmlppt`);
    console.log(`  tarball ${packed.filename} (${packed.size} bytes, ${packed.entryCount} files)`);

    console.log('2. installing the tarball in an empty project');
    await writeFile(
      join(projectDir, 'package.json'),
      `${JSON.stringify({ name: 'htmlppt-smoke-project', private: true, version: '1.0.0' }, null, 2)}\n`,
      'utf8'
    );
    await runCommand(
      'npm install tarball',
      process.execPath,
      [
        npmCli,
        'install',
        '--no-save',
        '--no-audit',
        '--no-fund',
        '--ignore-scripts',
        '--no-package-lock',
        tarball
      ],
      { cwd: projectDir, env: childEnv }
    );

    console.log('3. checking installed package contents');
    const installedDir = join(projectDir, 'node_modules', 'htmlppt');
    const installedManifestPath = join(installedDir, 'package.json');
    await assertExists(installedManifestPath, 'installed package.json');
    const installedManifest = JSON.parse(await readFile(installedManifestPath, 'utf8'));
    assert(installedManifest.name === 'htmlppt', 'installed package is not named htmlppt');
    assert(installedManifest.bin?.htmlppt, 'installed package has no htmlppt bin');
    assert(installedManifest.bin?.['htmlppt-mcp'], 'installed package has no htmlppt-mcp bin');
    assert(
      installedManifest.bin.htmlppt === './dist/cli.js',
      `htmlppt bin points at ${installedManifest.bin.htmlppt}`
    );
    assert(
      installedManifest.bin['htmlppt-mcp'] === './dist/mcp.js',
      `htmlppt-mcp bin points at ${installedManifest.bin['htmlppt-mcp']}`
    );

    const cliBin = join(installedDir, installedManifest.bin.htmlppt);
    const mcpBin = join(installedDir, installedManifest.bin['htmlppt-mcp']);
    await assertExists(cliBin, 'installed CLI bin');
    await assertExists(mcpBin, 'installed MCP bin');
    await assertExists(join(installedDir, 'dist', 'editor', 'index.html'), 'packaged editor index.html');
    await assertExists(join(installedDir, 'dist', 'skill', 'SKILL.md'), 'packaged skill SKILL.md');
    await assertExists(join(installedDir, 'README.md'), 'packaged README.md');
    await assertExists(join(installedDir, 'LICENSE'), 'packaged LICENSE');
    await assertExists(join(installedDir, 'SECURITY.md'), 'packaged SECURITY.md');

    const editorHtml = await readFile(
      join(installedDir, 'dist', 'editor', 'index.html'),
      'utf8'
    );
    const assetRefs = [...editorHtml.matchAll(/(?:src|href)="\/(assets\/[^"]+)"/g)].map(
      (match) => match[1]
    );
    assert(assetRefs.length >= 2, 'packaged editor index.html does not reference its assets');
    for (const assetRef of assetRefs) {
      await assertExists(
        join(installedDir, 'dist', 'editor', assetRef),
        `packaged editor asset ${assetRef}`
      );
    }
    assert(
      (await readdir(join(installedDir, 'dist', 'skill'))).length > 0,
      'packaged skill directory is empty'
    );
    const cliSource = await readFile(cliBin, 'utf8');
    assert(cliSource.startsWith('#!/usr/bin/env node'), 'CLI bin has no node shebang');
    const mcpSource = await readFile(mcpBin, 'utf8');
    assert(mcpSource.startsWith('#!/usr/bin/env node'), 'MCP bin has no node shebang');
    console.log('  bins, editor assets, skill, and package docs are present');

    const cli = async (label, args, options = {}) =>
      runCommand(label, process.execPath, [cliBin, ...args], {
        cwd: projectDir,
        env: childEnv,
        ...options
      });

    console.log('4. running htmlppt --help');
    const help = await cli('htmlppt --help', ['--help']);
    assert(help.stdout.includes('Usage: htmlppt'), 'htmlppt --help did not print usage');
    assert(help.stdout.includes('open [options] <file>'), 'help is missing the open command');

    console.log('5. running htmlppt new and validate');
    const newDeck = await cli('htmlppt new', ['new', 'deck.html', '--slides', '2']);
    assert(newDeck.stdout.includes('Created deck.html'), 'new did not report the deck');
    const deckPath = join(projectDir, 'deck.html');
    await assertExists(deckPath, 'created deck');
    const deckHtml = await readFile(deckPath, 'utf8');
    assert(deckHtml.includes('data-ppt-deck'), 'created deck has no deck wrapper');
    assert(deckHtml.includes('data-ppt-runtime="1"'), 'created deck has no runtime');
    const validation = await cli('htmlppt validate', ['validate', 'deck.html']);
    assert(
      validation.stdout.includes('Deck is valid.'),
      `validate did not accept the deck:\n${validation.stdout}\n${validation.stderr}`
    );

    console.log('6. running htmlppt open --no-browser and htmlppt stop');
    hostSession = new ProcessSession(
      'htmlppt open',
      process.execPath,
      [cliBin, 'open', 'deck.html', '--no-browser'],
      { cwd: projectDir, env: childEnv }
    );
    const urlLine = await hostSession.waitForLine(
      (line) => line.startsWith('HTMLPPT_URL='),
      HOST_START_TIMEOUT_MS,
      'the editor URL'
    );
    const editorUrl = urlLine.slice('HTMLPPT_URL='.length);
    assert(/^http:\/\/127\.0\.0\.1:\d+\/\?token=/.test(editorUrl), `unexpected URL ${editorUrl}`);
    const editorOrigin = new URL(editorUrl).origin;
    const unauthenticated = await fetch(`${editorOrigin}/`, {
      signal: AbortSignal.timeout(EDITOR_FETCH_TIMEOUT_MS)
    });
    assert(
      unauthenticated.status === 401,
      `unauthenticated editor page returned ${unauthenticated.status}, expected 401`
    );
    await unauthenticated.body?.cancel().catch(() => undefined);
    const response = await fetch(editorUrl, {
      signal: AbortSignal.timeout(EDITOR_FETCH_TIMEOUT_MS)
    });
    assert(response.ok, `editor URL returned ${response.status}`);
    const servedHtml = await response.text();
    assert(servedHtml.includes('<div id="root">'), 'host did not serve the packaged editor');
    const stop = await cli('htmlppt stop', ['stop', 'deck.html']);
    assert(stop.stdout.includes('Stopped editor'), 'stop did not report stopping the editor');
    await hostSession.waitForClose(PROCESS_EXIT_TIMEOUT_MS, 'exit after htmlppt stop');
    // Windows terminates SIGTERM with exit code 1, so assert that the process
    // and its socket are gone rather than a platform-specific exit code.
    await assertHostStopped(editorUrl, 5_000);
    const sessions = await readdir(join(homeDir, 'sessions')).catch((error) => {
      if (error.code === 'ENOENT') return [];
      throw error;
    });
    assert(
      sessions.filter((name) => name.endsWith('.json')).length === 0,
      'stop left a session registry entry behind'
    );
    console.log('  editor host started, served the packaged editor, and stopped');

    console.log('7. running the htmlppt-mcp initialize handshake');
    mcpSession = new ProcessSession(
      'htmlppt-mcp',
      process.execPath,
      [mcpBin],
      { cwd: projectDir, env: childEnv }
    );
    mcpSession.child.stdin.write(
      `${JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: '2024-11-05',
          capabilities: {},
          clientInfo: { name: 'htmlppt-package-smoke', version: '0.0.0' }
        }
      })}\n`
    );
    const initializeLine = await mcpSession.waitForLine(
      (line) => {
        try {
          return JSON.parse(line).id === 1;
        } catch {
          return false;
        }
      },
      MCP_TIMEOUT_MS,
      'the initialize response'
    );
    const initialize = JSON.parse(initializeLine);
    assert(!initialize.error, `initialize failed: ${JSON.stringify(initialize.error)}`);
    assert(
      initialize.result?.serverInfo?.name === 'htmlppt',
      `unexpected MCP server ${JSON.stringify(initialize.result?.serverInfo)}`
    );
    assert(
      typeof initialize.result?.protocolVersion === 'string',
      'initialize response has no protocolVersion'
    );
    mcpSession.child.stdin.write(
      `${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`
    );
    mcpSession.child.stdin.write(
      `${JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} })}\n`
    );
    const toolsLine = await mcpSession.waitForLine(
      (line) => {
        try {
          return JSON.parse(line).id === 2;
        } catch {
          return false;
        }
      },
      MCP_TIMEOUT_MS,
      'the tools/list response'
    );
    const tools = JSON.parse(toolsLine);
    assert(!tools.error, `tools/list failed: ${JSON.stringify(tools.error)}`);
    const toolNames = (tools.result?.tools ?? []).map((tool) => tool.name);
    for (const required of ['create_deck', 'validate_deck', 'set_text', 'open_editor']) {
      assert(toolNames.includes(required), `MCP tools/list is missing ${required}`);
    }
    assert(toolNames.length >= 20, `MCP exposed only ${toolNames.length} tools`);
    for (const line of mcpSession.lines) {
      try {
        JSON.parse(line);
      } catch {
        throw new SmokeError(
          `MCP stdout is not pure JSON-RPC; unexpected line: ${line}\n${mcpSession.describeOutput()}`
        );
      }
    }
    mcpSession.child.stdin.end();
    console.log(`  initialize ok (protocol ${initialize.result.protocolVersion}, ${toolNames.length} tools)`);

    console.log(
      `PACKAGE SMOKE PASS: htmlppt ${installedManifest.version} tarball installed and exercised in ${Date.now() - startedAt} ms.`
    );
  } finally {
    if (mcpSession) await mcpSession.stop();
    if (hostSession) await hostSession.stop();
    for (const child of [...liveChildren]) child.kill('SIGKILL');
    if (tempRoot) {
      await rm(tempRoot, { recursive: true, force: true });
    }
  }
}

main().catch((error) => {
  if (error instanceof SmokeError) {
    console.error(`PACKAGE SMOKE FAIL: ${error.message}`);
  } else {
    console.error('PACKAGE SMOKE FAIL: unexpected error');
    console.error(error);
  }
  process.exitCode = 1;
});
