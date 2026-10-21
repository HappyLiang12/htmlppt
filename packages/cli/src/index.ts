import { randomUUID } from 'node:crypto';
import { access, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { basename, dirname, join, parse, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  createDeckHtml,
  serializeExport,
  validateDeck,
  type ValidationResult
} from '@htmlppt/core';
import { parseDeckHtml } from '@htmlppt/core/node';
import { startHost } from '@htmlppt/host';
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

function editorDir(): string {
  return (
    process.env.HTMLPPT_EDITOR_DIR ??
    fileURLToPath(new URL('../../editor/dist', import.meta.url))
  );
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
      const directory = editorDir();
      try {
        await access(join(directory, 'index.html'));
      } catch {
        throw new Error('Editor build not found. Run "npm run build" first.');
      }
      let host: Awaited<ReturnType<typeof startHost>>;
      try {
        host = await startHost({
          filePath,
          token: randomUUID(),
          editorDir: directory,
          port: Number(options.port)
        });
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code === 'ENOENT') {
          throw new Error(
            `Deck file not found: ${file}. Create one with "htmlppt new ${file}".`
          );
        }
        if (code === 'EADDRINUSE') {
          throw new Error(
            `Port ${options.port} is already in use. Omit --port or choose another.`
          );
        }
        throw error;
      }

      io.stdout(`HTMLPPT_URL=${host.url}`);

      await new Promise<void>((resolvePromise) => {
        const stop = () => {
          void host.close().finally(() => resolvePromise());
        };
        process.once('SIGINT', stop);
        process.once('SIGTERM', stop);

        if (options.browser) {
          void (async () => {
            try {
              const { default: openUrl } = await import('open');
              await openUrl(host.url);
            } catch (cause) {
              io.stderr(
                `Could not open a browser: ${cause instanceof Error ? cause.message : String(cause)}. Open the URL manually.`
              );
            }
          })();
        }
      });
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
