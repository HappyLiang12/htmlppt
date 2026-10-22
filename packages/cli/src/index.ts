import { randomUUID } from 'node:crypto';
import { constants, type Dirent } from 'node:fs';
import { access, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { basename, dirname, join, parse, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  createDeckHtml,
  getOutline,
  serializeExport,
  validateDeck,
  type DeckOutline,
  type ValidationResult
} from '@htmlppt/core';
import { parseDeckHtml, readDeckFile } from '@htmlppt/core/node';
import {
  listSessions,
  removeSessionIfUnchanged,
  sessionKey,
  sessionsDirectory,
  startHost,
  writeSession,
  type SessionEntry
} from '@htmlppt/host';
import { Command, CommanderError } from 'commander';

export interface CliIO {
  cwd: string;
  stdout: (line: string) => void;
  stderr: (line: string) => void;
}

const DEFAULT_STREAMS = {
  stdout: (line: string) => console.log(line),
  stderr: (line: string) => console.error(line)
};

const STOP_TIMEOUT_MS = 5_000;
const STOP_POLL_INTERVAL_MS = 100;

/**
 * Resolves the editor build for both the workspace and the installed package.
 * `HTMLPPT_EDITOR_DIR` is an explicit override, so an invalid directory is
 * reported instead of silently falling back. Without an override, prefer the
 * package layout (`<package root>/dist/editor`, which is also the bundled
 * layout) and then the workspace (`packages/editor/dist`).
 */
async function editorDir(): Promise<string> {
  const override = process.env.HTMLPPT_EDITOR_DIR;
  if (override !== undefined && override.length > 0) {
    await requireEditorBuild(override);
    return override;
  }

  const candidates = [
    fileURLToPath(new URL('../dist/editor', import.meta.url)),
    fileURLToPath(new URL('../../editor/dist', import.meta.url))
  ];
  for (const candidate of candidates) {
    try {
      await access(join(candidate, 'index.html'), constants.R_OK);
      return candidate;
    } catch {
      // Try the next layout.
    }
  }
  throw new Error('Editor build not found. Run "npm run build" first.');
}

async function requireEditorBuild(directory: string): Promise<void> {
  try {
    await access(join(directory, 'index.html'), constants.R_OK);
  } catch {
    throw new Error('Editor build not found. Run "npm run build" first.');
  }
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, milliseconds));
}

function sessionUrl(session: Pick<SessionEntry, 'port' | 'token'>): string {
  return `http://127.0.0.1:${session.port}/?token=${encodeURIComponent(session.token)}`;
}

function sessionFilePath(filePath: string): string {
  return join(sessionsDirectory(), `${sessionKey(filePath)}.json`);
}

type SessionFileState = 'present' | 'missing' | 'unreadable';

/**
 * Lists the registry files currently on disk. `listSessions` silently drops
 * entries whose process is gone, so `stop --all` snapshots the directory first
 * to tell a real empty registry apart from a cleanup.
 */
async function registrySessionNames(): Promise<string[]> {
  let dirents: Dirent[];
  try {
    dirents = await readdir(sessionsDirectory(), { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return [];
    }
    throw error;
  }
  return dirents
    .filter((dirent) => dirent.isFile() && dirent.name.endsWith('.json'))
    .map((dirent) => dirent.name)
    .sort();
}

/**
 * Only ENOENT proves that the registry entry is gone. Any other access failure
 * means the entry may still exist, so callers must not report it as cleaned.
 */
async function sessionFileState(filePath: string): Promise<SessionFileState> {
  try {
    await access(sessionFilePath(filePath), constants.R_OK);
    return 'present';
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ENOENT'
      ? 'missing'
      : 'unreadable';
  }
}

/**
 * A health timeout or 5xx keeps the registry entry even though no live session
 * can be confirmed. Starting another host would overwrite that entry and orphan
 * the process that may still own the socket, so a recorded live pid blocks the
 * new host until the user retries or stops it.
 */
async function hasUnresponsiveRegisteredHost(
  filePath: string
): Promise<boolean> {
  let raw: string;
  try {
    raw = await readFile(sessionFilePath(filePath), 'utf8');
  } catch {
    return false;
  }
  let entry: { path?: unknown; pid?: unknown };
  try {
    entry = JSON.parse(raw) as { path?: unknown; pid?: unknown };
  } catch {
    return false;
  }
  return (
    typeof entry.path === 'string' &&
    resolve(entry.path) === filePath &&
    typeof entry.pid === 'number' &&
    Number.isInteger(entry.pid) &&
    entry.pid > 0 &&
    processIsAlive(entry.pid)
  );
}

async function openBrowser(url: string, io: CliIO): Promise<void> {
  try {
    const { default: openUrl } = await import('open');
    await openUrl(url);
  } catch (cause) {
    io.stderr(
      `Could not open a browser: ${cause instanceof Error ? cause.message : String(cause)}. Open the URL manually.`
    );
  }
}

function printOutline(outline: DeckOutline, io: CliIO): void {
  const slideLabel = outline.slideCount === 1 ? 'slide' : 'slides';
  io.stdout(
    `${outline.title} (${outline.width}x${outline.height}, ${outline.slideCount} ${slideLabel})`
  );
  for (const slide of outline.slides) {
    const elementLabel = slide.elements.length === 1 ? 'element' : 'elements';
    io.stdout(`  ${slide.id}: ${slide.elements.length} ${elementLabel}`);
    for (const element of slide.elements) {
      const id = element.id ?? '(no id)';
      const text = element.text.length > 0 ? ` ${element.text}` : '';
      io.stdout(`    ${id} <${element.tag}>${text}`);
    }
  }
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM means the process exists but belongs to another user.
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

async function waitForProcessExit(
  pid: number,
  timeoutMs: number
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (!processIsAlive(pid)) {
      return true;
    }
    const remaining = deadline - Date.now();
    if (remaining <= 0) {
      return false;
    }
    await delay(Math.min(STOP_POLL_INTERVAL_MS, remaining));
  }
}

async function stopSession(session: SessionEntry, io: CliIO): Promise<boolean> {
  const sessionFile = join(
    sessionsDirectory(),
    `${sessionKey(session.path)}.json`
  );
  let snapshot: string;
  try {
    snapshot = await readFile(sessionFile, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      io.stderr(
        `The editor session for ${session.path} disappeared before it could be stopped.`
      );
    } else {
      io.stderr(
        `Could not read the editor session for ${session.path}: ${error instanceof Error ? error.message : String(error)}.`
      );
    }
    return false;
  }
  if (snapshot !== `${JSON.stringify(session, null, 2)}\n`) {
    // The registry changed after the health check; never signal a pid that no
    // longer matches the session that was verified.
    io.stderr(
      `The editor session for ${session.path} changed while stopping it. Retry "htmlppt stop ${session.path}".`
    );
    return false;
  }

  try {
    process.kill(session.pid, 'SIGTERM');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ESRCH') {
      io.stderr(
        `Could not stop the editor process ${session.pid} for ${session.path}: ${error instanceof Error ? error.message : String(error)}.`
      );
      return false;
    }
  }

  if (!(await waitForProcessExit(session.pid, STOP_TIMEOUT_MS))) {
    io.stderr(
      `The editor process ${session.pid} for ${session.path} did not stop within 5 seconds. Stop it manually, then run "htmlppt stop ${session.path}" again.`
    );
    return false;
  }

  await removeSessionIfUnchanged(sessionFile, snapshot);
  io.stdout(`Stopped editor for ${session.path} (port ${session.port}).`);
  return true;
}

function printDiagnostics(result: ValidationResult, io: CliIO): void {
  for (const diagnostic of result.errors) {
    io.stderr(`ERROR ${diagnostic.code}: ${diagnostic.message}`);
  }
  for (const diagnostic of result.warnings) {
    io.stderr(`WARN ${diagnostic.code}: ${diagnostic.message}`);
  }
  io.stdout(
    result.valid ? 'Deck is valid.' : `Deck has ${result.errors.length} error(s).`
  );
}

export function formatHostStartError(
  error: unknown,
  filePath: string,
  port: number,
  displayPath: string = filePath
): string | null {
  if (typeof error !== 'object' || error === null) return null;
  const { code, path: errorPath, syscall } = error as NodeJS.ErrnoException;
  if (code === 'ENOENT' && errorPath === filePath) {
    return `Deck file not found: ${displayPath}. Create one with "htmlppt new ${displayPath}".`;
  }
  const unreadableDeck =
    code === 'EISDIR' ||
    (code === 'EACCES' &&
      (errorPath === filePath || syscall === 'open' || syscall === 'read'));
  if (unreadableDeck) {
    return `Deck file could not be read: ${displayPath}.`;
  }
  if (code === 'EADDRINUSE') {
    return `Port ${port} is already in use. Omit --port or choose another.`;
  }
  return null;
}

export async function runCli(
  argv: string[],
  overrides: Partial<CliIO> = {}
): Promise<number> {
  const io: CliIO = { cwd: process.cwd(), ...DEFAULT_STREAMS, ...overrides };
  let exitCode = 0;

  const program = new Command();
  program
    .name('htmlppt')
    .description('Visual editor and tooling for static HTML presentations')
    .version('0.0.0')
    .exitOverride();
  program.configureOutput({
    writeOut: (text) => io.stdout(text.replace(/\n$/, '')),
    writeErr: (text) => io.stderr(text.replace(/\n$/, ''))
  });

  program
    .command('new <file>')
    .description('Create a contract-compliant deck')
    .option('--title <title>', 'deck title', 'Untitled deck')
    .option('--slides <count>', 'number of slides', '2')
    .option('--size <size>', 'canvas size, for example 1600x900', '1600x900')
    .option('--force', 'overwrite an existing file')
    .action(async (file: string, options: { title: string; slides: string; size: string; force?: boolean }) => {
      const match = /^(\d+)x(\d+)$/.exec(options.size);
      if (!match) {
        throw new Error(
          'Invalid --size. Use positive WIDTHxHEIGHT, for example 1600x900.'
        );
      }
      const width = Number(match[1]);
      const height = Number(match[2]);
      if (width < 1 || height < 1) {
        throw new Error(
          'Invalid --size. Use positive WIDTHxHEIGHT, for example 1600x900.'
        );
      }
      const slideMatch = /^(\d+)$/.exec(options.slides);
      const slides = slideMatch ? Number(slideMatch[1]) : Number.NaN;
      if (!Number.isSafeInteger(slides) || slides < 1 || slides > 1000) {
        throw new Error('Invalid --slides. Use a positive integer up to 1000.');
      }
      const html = createDeckHtml({ title: options.title, slides, width, height });
      const destination = resolve(io.cwd, file);

      if (!options.force) {
        try {
          await writeFile(destination, html, { encoding: 'utf8', flag: 'wx' });
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
            throw new Error(
              `Refusing to overwrite ${file}. Pass --force to replace it.`
            );
          }
          throw error;
        }
      } else {
        const temporary = join(
          dirname(destination),
          `.${basename(destination)}.${randomUUID()}.tmp`
        );
        try {
          await writeFile(temporary, html, 'utf8');
          await rename(temporary, destination);
        } finally {
          await rm(temporary, { force: true });
        }
      }

      io.stdout(`Created ${file}`);
    });

  program
    .command('validate <file>')
    .description('Validate a deck against the contract')
    .option('--json', 'print the result as JSON')
    .action(async (file: string, options: { json?: boolean }) => {
      const html = await readFile(resolve(io.cwd, file), 'utf8');
      const result = validateDeck(parseDeckHtml(html));
      if (options.json) {
        io.stdout(JSON.stringify(result, null, 2));
      } else {
        printDiagnostics(result, io);
      }
      if (!result.valid) exitCode = 1;
    });

  program
    .command('export <file>')
    .description('Export a deck')
    .option('--format <format>', 'output format', 'html')
    .option('--out <path>', 'output path')
    .action(async (file: string, options: { format: string; out?: string }) => {
      if (options.format !== 'html') {
        throw new Error(
          'Only html export is available in this milestone. Use --format html.'
        );
      }
      const sourcePath = resolve(io.cwd, file);
      const html = await readFile(sourcePath, 'utf8');
      const doc = parseDeckHtml(html);
      const result = validateDeck(doc);
      if (!result.valid) {
        printDiagnostics(result, io);
        exitCode = 1;
        return;
      }
      const parsedPath = parse(sourcePath);
      const destination = options.out
        ? resolve(io.cwd, options.out)
        : join(parsedPath.dir, `${parsedPath.name}.export.html`);
      await writeFile(destination, serializeExport(doc), 'utf8');
      io.stdout(`Exported ${destination}`);
    });

  program
    .command('outline <file>')
    .description('Print the title, slides, and elements of a deck')
    .option('--json', 'print the outline as JSON')
    .action(async (file: string, options: { json?: boolean }) => {
      const filePath = resolve(io.cwd, file);
      let html: string;
      try {
        html = (await readDeckFile(filePath)).html;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
          io.stderr(`Deck file not found: ${file}.`);
          exitCode = 1;
          return;
        }
        throw error;
      }
      const outline = getOutline(parseDeckHtml(html));
      if (options.json) {
        io.stdout(JSON.stringify(outline));
        return;
      }
      printOutline(outline, io);
    });

  program
    .command('open <file>')
    .description('Open the visual editor for a deck')
    .option('--port <port>', 'port to listen on', '0')
    .option('--no-browser', 'do not open a browser')
    .action(async (file: string, options: { port: string; browser: boolean }) => {
      if (!/^\d+$/.test(options.port) || Number(options.port) > 65_535) {
        throw new Error(
          'Invalid --port. Use an integer between 0 and 65535.'
        );
      }
      const filePath = resolve(io.cwd, file);

      const { findLiveSession } = await import('@htmlppt/mcp');
      const existing = await findLiveSession(filePath);
      if (existing) {
        const url = sessionUrl(existing);
        io.stdout(`HTMLPPT_URL=${url}`);
        if (options.browser) {
          await openBrowser(url, io);
        }
        return;
      }

      if (await hasUnresponsiveRegisteredHost(filePath)) {
        io.stderr(
          `An editor for this deck appears to be running but is not responding. Retry in a moment or run "htmlppt stop ${file}" to stop it.`
        );
        exitCode = 1;
        return;
      }

      const directory = await editorDir();
      const token = randomUUID();
      let host: Awaited<ReturnType<typeof startHost>>;
      try {
        host = await startHost({
          filePath,
          token,
          editorDir: directory,
          port: Number(options.port)
        });
      } catch (error) {
        const message = formatHostStartError(
          error,
          filePath,
          Number(options.port),
          file
        );
        if (message === null) {
          throw error;
        }
        io.stderr(message);
        exitCode = 1;
        return;
      }

      const entry: SessionEntry = {
        path: filePath,
        port: host.port,
        token,
        pid: process.pid,
        startedAt: new Date().toISOString(),
        revision: ''
      };
      const sessionFile = join(
        sessionsDirectory(),
        `${sessionKey(filePath)}.json`
      );
      try {
        entry.revision = (await readDeckFile(filePath)).hash;
        await writeSession(entry);
      } catch (error) {
        await host.close();
        throw error;
      }
      const sessionSnapshot = `${JSON.stringify(entry, null, 2)}\n`;

      io.stdout(`HTMLPPT_URL=${host.url}`);

      await new Promise<void>((resolvePromise) => {
        const stop = () => {
          void (async () => {
            try {
              await host.close();
            } finally {
              await removeSessionIfUnchanged(sessionFile, sessionSnapshot);
            }
          })()
            .catch(() => undefined)
            .finally(() => resolvePromise());
        };
        process.once('SIGINT', stop);
        process.once('SIGTERM', stop);

        if (options.browser) {
          void openBrowser(host.url, io);
        }
      });
    });

  program
    .command('stop [file]')
    .description('Stop a running editor session')
    .option('--all', 'stop every live editor session')
    .action(async (file: string | undefined, options: { all?: boolean }) => {
      const { findLiveSession } = await import('@htmlppt/mcp');
      if (options.all) {
        if (file !== undefined) {
          io.stderr('Pass either a deck file or --all, not both.');
          exitCode = 1;
          return;
        }
        let registrySnapshot: string[];
        try {
          // Snapshot before listing: listSessions prunes entries whose process
          // has exited, so an empty list alone cannot tell cleanup from an
          // empty registry.
          registrySnapshot = await registrySessionNames();
        } catch (error) {
          io.stderr(
            `Could not read the editor session registry at ${sessionsDirectory()}: ${error instanceof Error ? error.message : String(error)}. Check permissions and retry "htmlppt stop --all".`
          );
          exitCode = 1;
          return;
        }
        const sessions = await listSessions();
        if (sessions.length === 0) {
          if (registrySnapshot.length === 0) {
            io.stderr('No live editor sessions.');
            exitCode = 1;
            return;
          }
          let remaining: string[];
          try {
            const after = new Set(await registrySessionNames());
            remaining = registrySnapshot.filter((name) => after.has(name));
          } catch (error) {
            io.stderr(
              `Could not read the editor session registry at ${sessionsDirectory()}: ${error instanceof Error ? error.message : String(error)}. Check permissions and retry "htmlppt stop --all".`
            );
            exitCode = 1;
            return;
          }
          if (remaining.length > 0) {
            // Some registry entries survived the prune: they exist but could
            // not be read or removed. Never report those as cleaned.
            io.stderr(
              `Could not verify ${remaining.length} editor session ${remaining.length === 1 ? 'entry that is' : 'entries that are'} still in the registry at ${sessionsDirectory()}. Check permissions, then retry "htmlppt stop --all".`
            );
            exitCode = 1;
            return;
          }
          io.stdout(
            `Removed ${registrySnapshot.length} stale editor session(s).`
          );
          return;
        }
        let stopped = 0;
        let cleaned = 0;
        let failed = 0;
        for (const session of sessions) {
          const live = await findLiveSession(session.path);
          if (!live) {
            const entryState = await sessionFileState(session.path);
            if (entryState === 'missing') {
              // The health check definitively proved the entry stale and
              // already removed it; there is no live host left to fail.
              cleaned += 1;
              io.stdout(`Removed stale editor session for ${session.path}.`);
              continue;
            }
            if (entryState === 'unreadable') {
              io.stderr(
                `Could not read the editor session entry for ${session.path}. Check permissions on ${sessionsDirectory()}, then retry "htmlppt stop --all".`
              );
              failed += 1;
              continue;
            }
            io.stderr(
              `Could not verify a live editor for ${session.path}; leaving it running. Retry "htmlppt stop ${session.path}" when it responds.`
            );
            failed += 1;
            continue;
          }
          if (await stopSession(live, io)) {
            stopped += 1;
          } else {
            failed += 1;
          }
        }
        if (stopped === 0 && cleaned === 0) {
          io.stderr('No live editor sessions were stopped.');
          exitCode = 1;
        } else if (failed > 0) {
          exitCode = 1;
        }
        return;
      }

      if (file === undefined) {
        io.stderr('Specify a deck file to stop or pass --all.');
        exitCode = 1;
        return;
      }
      const filePath = resolve(io.cwd, file);
      const live = await findLiveSession(filePath);
      if (!live) {
        io.stderr(
          `No live editor session for ${file}. Start one with "htmlppt open ${file}".`
        );
        exitCode = 1;
        return;
      }
      if (!(await stopSession(live, io))) {
        exitCode = 1;
      }
    });

  program
    .command('mcp')
    .description('Run the MCP stdio server for AI agents')
    .action(async () => {
      // Loaded lazily so validate/export/outline never import the MCP SDK.
      const { startStdio } = await import('@htmlppt/mcp');
      await startStdio();
    });

  try {
    await program.parseAsync(argv, { from: 'user' });
  } catch (error) {
    if (error instanceof CommanderError) {
      return error.exitCode;
    }
    io.stderr(error instanceof Error ? error.message : String(error));
    return 1;
  }

  return exitCode;
}
