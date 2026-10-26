import { randomUUID } from 'node:crypto';
import { constants, type Dirent } from 'node:fs';
import {
  access,
  mkdir,
  readFile,
  readdir,
  realpath
} from 'node:fs/promises';
import { isAbsolute, join, parse, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  createDeckHtml,
  detectSlides,
  getOutline,
  serializeExport,
  validateDeck,
  type DeckOutline,
  type ValidationResult
} from '@htmlppt/core';
import {
  createDeckFileAtomic,
  DeckFileExistsError,
  parseDeckHtml,
  readDeckFile,
  writeDeckFileAtomic
} from '@htmlppt/core/node';
import {
  canonicalCredentialFile,
  canonicalDeckPath,
  listSessions,
  readCredential,
  removeCredential,
  removeSessionIfUnchanged,
  rotateCredential,
  sameDeckPath,
  sessionKey,
  sessionsDirectory,
  startHost,
  writeCredential,
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
 * A health timeout, a 5xx, or a broken editor shell (`stale-build`) keeps the
 * registry entry even though no healthy session can be confirmed. Starting
 * another host would overwrite that entry and orphan the process that may
 * still own the socket, so a recorded live pid blocks the new host until the
 * user retries or stops it.
 *
 * Registry keys keep the spelling their writer used, so the caller-spelling key
 * can be absent after an open moved the entry to the host's canonical path.
 * Scan the registry and compare canonical paths instead; `listSessions` already
 * drops entries whose process is gone.
 */
async function hasUnresponsiveRegisteredHost(
  filePath: string
): Promise<boolean> {
  const target = await canonicalDeckPath(filePath);
  for (const entry of await listSessions()) {
    if (await sameDeckPath(entry.path, target)) {
      return true;
    }
  }
  return false;
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

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Rotates the credential of a deck whose host is gone. A capability token must
 * not outlive the host it belongs to, so a failed rotation discards the stored
 * credential instead of leaving a token nobody can use. The recorded port is
 * kept only when the write succeeds; after a discard the next `open` starts on
 * a new port with a new token.
 */
async function rotateStoppedCredential(
  filePath: string,
  port: number,
  io: CliIO
): Promise<void> {
  try {
    await rotateCredential(filePath, port);
    return;
  } catch (rotateError) {
    try {
      await removeCredential(filePath);
    } catch (removeError) {
      const target = await canonicalCredentialFile(filePath);
      io.stderr(
        `Could not rotate the credential for ${filePath}: ${errorMessage(rotateError)}. The stored credential could not be removed: ${errorMessage(removeError)}. Delete ${target} to discard the old token.`
      );
      return;
    }
    io.stderr(
      `Could not rotate the credential for ${filePath}: ${errorMessage(rotateError)}. The stored token was discarded, so the next open will use a new port and token.`
    );
  }
}

interface ListedEntry {
  path: string;
  port: number;
}

/**
 * Reads the registry files named by `registrySessionNames` before
 * `listSessions` prunes stale entries, so `stop --all` can still rotate the
 * credential of a dead session it cleans. Malformed entries are skipped: they
 * carry no deck identity to rotate.
 */
async function readListedEntries(names: string[]): Promise<ListedEntry[]> {
  const entries: ListedEntry[] = [];
  for (const name of names) {
    let value: unknown;
    try {
      value = JSON.parse(
        await readFile(join(sessionsDirectory(), name), 'utf8')
      );
    } catch {
      continue;
    }
    if (typeof value !== 'object' || value === null) {
      continue;
    }
    const { path: deckPath, port } = value as Record<string, unknown>;
    if (
      typeof deckPath !== 'string' ||
      !isAbsolute(deckPath) ||
      typeof port !== 'number' ||
      !Number.isInteger(port) ||
      port < 1 ||
      port > 65_535
    ) {
      continue;
    }
    entries.push({ path: deckPath, port });
  }
  return entries;
}

/**
 * Stops the process recorded by one registry entry. A caller that already
 * checked the entry passes the exact snapshot it verified; the file must still
 * hold those bytes, so a registry that changed after the probe can never make
 * this signal a pid the probe did not vouch for.
 */
async function stopSession(
  session: SessionEntry,
  io: CliIO,
  snapshotOverride?: string
): Promise<boolean> {
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
  const expected = snapshotOverride ?? `${JSON.stringify(session, null, 2)}\n`;
  if (snapshot !== expected) {
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
  // The capability token must not outlive the host it belongs to, while the
  // recorded port stays stable so the deck keeps its address. The host is
  // already gone, so a failed write warns instead of failing the stop.
  await rotateStoppedCredential(session.path, session.port, io);
  io.stdout(`Stopped editor for ${session.path} (port ${session.port}).`);
  return true;
}

const SOURCE_OVERWRITE_MESSAGE =
  'Refusing to overwrite the source deck. Choose a different --out path.';

function comparablePath(value: string): string {
  const resolved = resolve(value);
  // Windows paths are case-insensitive, so a case variant names the same file.
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

/**
 * The source deck must survive every export. Compare the resolved paths and,
 * when both exist, their real paths so a symlink alias is also refused.
 */
async function rejectSourceOverwrite(
  source: string,
  destination: string
): Promise<void> {
  let same = comparablePath(source) === comparablePath(destination);
  if (!same) {
    try {
      const [sourceReal, destinationReal] = await Promise.all([
        realpath(source),
        realpath(destination)
      ]);
      same = comparablePath(sourceReal) === comparablePath(destinationReal);
    } catch {
      // A missing destination cannot alias the source through realpath.
    }
  }
  if (same) {
    throw new Error(SOURCE_OVERWRITE_MESSAGE);
  }
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
          await createDeckFileAtomic(destination, html);
        } catch (error) {
          if (error instanceof DeckFileExistsError) {
            throw new Error(
              `Refusing to overwrite ${file}. Pass --force to replace it.`
            );
          }
          throw error;
        }
      } else {
        await writeDeckFileAtomic(destination, html);
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
    .description('Export a deck as HTML, PDF, or one PNG per slide')
    .option('--format <format>', 'output format: html, pdf, or png', 'html')
    .option(
      '--out <path>',
      'output file for html/PDF, output directory for PNG'
    )
    .action(async (file: string, options: { format: string; out?: string }) => {
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
      if (options.format === 'html') {
        const destination = options.out
          ? resolve(io.cwd, options.out)
          : join(parsedPath.dir, `${parsedPath.name}.export.html`);
        await rejectSourceOverwrite(sourcePath, destination);
        await writeDeckFileAtomic(destination, serializeExport(doc));
        io.stdout(`Exported ${destination}`);
        return;
      }
      if (options.format !== 'pdf' && options.format !== 'png') {
        throw new Error(
          `Unsupported export format "${options.format}". Use --format html, pdf, or png.`
        );
      }
      const slides = detectSlides(doc);
      const first = slides[0];
      if (options.format === 'pdf') {
        const destination = options.out
          ? resolve(io.cwd, options.out)
          : join(parsedPath.dir, `${parsedPath.name}.pdf`);
        await rejectSourceOverwrite(sourcePath, destination);
        const renderer = await import('@htmlppt/renderer');
        await renderer.renderPdf({
          html,
          width: first.width,
          height: first.height,
          outPath: destination
        });
        io.stdout(`Exported ${destination}`);
        return;
      }
      const outDir = options.out ? resolve(io.cwd, options.out) : parsedPath.dir;
      for (let index = 0; index < slides.length; index += 1) {
        await rejectSourceOverwrite(
          sourcePath,
          join(outDir, `${parsedPath.name}-s${index + 1}.png`)
        );
      }
      await mkdir(outDir, { recursive: true });
      const renderer = await import('@htmlppt/renderer');
      const files = await renderer.renderPngs({
        html,
        width: first.width,
        height: first.height,
        outDir,
        basename: parsedPath.name
      });
      for (const exported of files) {
        io.stdout(`Exported ${exported}`);
      }
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
    .option('--port <port>', 'port to listen on')
    .option('--no-browser', 'do not open a browser')
    .action(async (file: string, options: { port?: string; browser: boolean }) => {
      if (
        options.port !== undefined &&
        (!/^\d+$/.test(options.port) || Number(options.port) > 65_535)
      ) {
        throw new Error(
          'Invalid --port. Use an integer between 0 and 65535.'
        );
      }
      // Keep the registry in the spelling the caller used. Windows short
      // (8.3) paths and long paths name the same file but hash differently,
      // so canonicalizing here would hide entries written by another process.
      const filePath = resolve(io.cwd, file);

      const { findLiveSession } = await import('@htmlppt/mcp');
      const existing = await findLiveSession(filePath);
      if (existing) {
        const url = sessionUrl(existing);
        // Decks opened before the credential store existed still deserve a
        // stable bookmark. A stale credential is worse than none: after a
        // crash the stored identity would start a host the live one never
        // served, so rewrite it to the host that is actually answering.
        const stored = await readCredential(filePath);
        if (
          stored === null ||
          stored.token !== existing.token ||
          stored.port !== existing.port
        ) {
          const now = new Date().toISOString();
          await writeCredential(filePath, {
            token: existing.token,
            port: existing.port,
            createdAt: stored?.createdAt ?? now,
            updatedAt: now
          }).catch((error: unknown) => {
            io.stderr(
              `Could not record the deck credential: ${errorMessage(error)}. The editor still works; a later restart may reuse a stale URL.`
            );
          });
        }
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
      const credential = await readCredential(filePath);
      const token = credential?.token ?? randomUUID();
      // Only an explicit --port overrides the recorded address; `--port 0`
      // still asks the OS for a fresh ephemeral port.
      const requestedPort =
        options.port === undefined ? undefined : Number(options.port);
      const stickyPort = requestedPort ?? credential?.port ?? 0;
      let deckSwitched = false;
      const moveSession = async (event: {
        previousPath: string;
        path: string;
        revision: string;
      }): Promise<void> => {
        deckSwitched = true;
        const previousPath = entry.path;
        const sameDeck = await sameDeckPath(previousPath, event.path);
        const nextEntry: SessionEntry = {
          ...entry,
          path: event.path,
          revision: event.revision
        };
        await writeSession(nextEntry);
        const nextFile = join(
          sessionsDirectory(),
          `${sessionKey(event.path)}.json`
        );
        // Mirror what writeSession stores so shutdown and later moves compare
        // against the exact bytes on disk.
        const nextSnapshot = `${JSON.stringify(
          { ...nextEntry, path: resolve(event.path) },
          null,
          2
        )}\n`;
        await removeSessionIfUnchanged(sessionFile, sessionSnapshot);
        entry = nextEntry;
        sessionFile = nextFile;
        sessionSnapshot = nextSnapshot;
        // The host keeps its token and port across a switch, so its credential
        // follows the deck it now serves. The previous deck must not keep a
        // token this host still accepts.
        const now = new Date().toISOString();
        const nextCredential = await readCredential(event.path);
        await writeCredential(event.path, {
          token: nextEntry.token,
          port: nextEntry.port,
          createdAt: nextCredential?.createdAt ?? now,
          updatedAt: now
        }).catch((error: unknown) => {
          io.stderr(
            `Could not record the deck credential: ${errorMessage(error)}. The editor still works; a later restart may print a new URL.`
          );
        });
        if (!sameDeck) {
          await removeCredential(previousPath).catch((error: unknown) => {
            io.stderr(
              `Could not discard the stored credential for ${previousPath}: ${errorMessage(error)}. That deck may reuse this host's token on its next open.`
            );
          });
        }
        io.stdout(`HTMLPPT_URL=${sessionUrl(entry)}`);
      };
      const start = (port: number) =>
        startHost({
          filePath,
          token,
          editorDir: directory,
          port,
          onDeckOpened: moveSession
        });
      let attemptedPort = stickyPort;
      let host: Awaited<ReturnType<typeof startHost>>;
      try {
        try {
          host = await start(stickyPort);
        } catch (error) {
          if (
            requestedPort === undefined &&
            credential !== null &&
            (error as NodeJS.ErrnoException).code === 'EADDRINUSE'
          ) {
            io.stderr(
              `Port ${stickyPort} is in use; starting ${file} on a new port. Existing bookmarks for this deck will stop working.`
            );
            attemptedPort = 0;
            host = await start(0);
          } else {
            throw error;
          }
        }
      } catch (error) {
        const message = formatHostStartError(
          error,
          filePath,
          attemptedPort,
          file
        );
        if (message === null) {
          throw error;
        }
        io.stderr(message);
        exitCode = 1;
        return;
      }

      let entry: SessionEntry = {
        path: filePath,
        port: host.port,
        token,
        pid: process.pid,
        startedAt: new Date().toISOString(),
        revision: ''
      };
      let sessionFile = join(
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
      let sessionSnapshot = `${JSON.stringify(entry, null, 2)}\n`;

      // Record the binding before announcing it so the printed URL is always
      // the one the next open will reuse. A switch during startup already
      // moved the registry and wrote the new deck's credential, so an entry
      // that no longer names `filePath` must not resurrect the old one.
      if (!deckSwitched && entry.path === filePath) {
        await writeCredential(filePath, {
          token,
          port: host.port,
          createdAt: credential?.createdAt ?? new Date().toISOString(),
          updatedAt: new Date().toISOString()
        }).catch((error: unknown) => {
          io.stderr(
            `Could not record the deck credential: ${errorMessage(error)}. The editor still works; the next open will print a new URL.`
          );
        });
        // The switch may have removed the old credential while this write was
        // in flight; repeat the discard so the old deck cannot keep the token.
        // A switch back to this same deck (under any spelling) already wrote
        // the fresh credential, so only keep it when the entry still names it.
        if (deckSwitched && !(await sameDeckPath(entry.path, filePath))) {
          await removeCredential(filePath).catch(() => undefined);
        }
      }

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
      const { findLiveSession, lookupRegisteredSession } = await import(
        '@htmlppt/mcp'
      );
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
        const listedEntries = await readListedEntries(registrySnapshot);
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
          // The prune only removed dead sessions. Their hosts are gone, so
          // every listed credential gets the same rotation a normal stop does.
          for (const entry of listedEntries) {
            await rotateStoppedCredential(entry.path, entry.port, io);
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
          // Judge this exact registry entry instead of asking findLiveSession
          // for a live host: a stale-build entry is alive and must be stopped,
          // but findLiveSession deliberately reports no live session for it.
          const registered = await lookupRegisteredSession(session.path);
          if (
            registered?.health === 'healthy' ||
            registered?.health === 'stale-build'
          ) {
            if (await stopSession(registered.entry, io, registered.snapshot)) {
              stopped += 1;
            } else {
              failed += 1;
            }
            continue;
          }
          if (registered?.health === 'unhealthy') {
            // The process answered, but not as the host that owns this deck.
            // Never signal that pid; prune the entry exactly as
            // findLiveSession fences it and let the missing-entry branch below
            // rotate a credential no host can use.
            await removeSessionIfUnchanged(
              join(
                sessionsDirectory(),
                `${sessionKey(registered.entry.path)}.json`
              ),
              registered.snapshot
            );
          } else if (registered?.health === 'unknown') {
            io.stderr(
              `Could not verify a live editor for ${session.path}; leaving it running. Retry "htmlppt stop ${session.path}" when it responds.`
            );
            failed += 1;
            continue;
          }
          const entryState = await sessionFileState(session.path);
          if (entryState === 'missing') {
            // The entry is gone (a dead pid was pruned by listSessions, or the
            // verdict above removed it); there is no live host left to fail.
            // Its credential must not outlive that host either.
            await rotateStoppedCredential(session.path, session.port, io);
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
        }
        // listSessions pruned dead-pid entries before the loop, so their
        // credentials never reached stopSession. Rotate every snapshotted
        // entry the loop did not already handle; entries that alias a live
        // session were handled (or deliberately left) with that session.
        for (const listed of listedEntries) {
          let handled = false;
          for (const session of sessions) {
            if (await sameDeckPath(listed.path, session.path)) {
              handled = true;
              break;
            }
          }
          if (handled) {
            continue;
          }
          await rotateStoppedCredential(listed.path, listed.port, io);
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
      // Judge the caller-spelling entry before findLiveSession prunes an
      // unhealthy one or returns a healthy alias: a stale-build entry is alive
      // and must be stopped, not reported missing.
      const registered = await lookupRegisteredSession(filePath);
      if (
        registered?.health === 'healthy' ||
        registered?.health === 'stale-build'
      ) {
        if (!(await stopSession(registered.entry, io, registered.snapshot))) {
          exitCode = 1;
        }
        return;
      }
      // A healthy host may still be registered under another spelling.
      const live = await findLiveSession(filePath);
      if (live) {
        if (!(await stopSession(live, io))) {
          exitCode = 1;
        }
        return;
      }
      if (registered?.health === 'unknown') {
        io.stderr(
          `Could not verify the editor session for ${file}; leaving it running. Retry "htmlppt stop ${file}" when it responds.`
        );
        exitCode = 1;
        return;
      }
      io.stderr(
        `No live editor session for ${file}. Start one with "htmlppt open ${file}".`
      );
      exitCode = 1;
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
