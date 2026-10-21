import { readFile, writeFile } from 'node:fs/promises';
import { join, parse, resolve } from 'node:path';
import {
  createDeckHtml,
  serializeExport,
  validateDeck,
  type ValidationResult
} from '@htmlppt/core';
import { parseDeckHtml } from '@htmlppt/core/node';
import { Command, CommanderError } from 'commander';

export interface CliIO {
  cwd: string;
  stdout: (line: string) => void;
  stderr: (line: string) => void;
}

const DEFAULT_IO: CliIO = {
  cwd: process.cwd(),
  stdout: (line) => console.log(line),
  stderr: (line) => console.error(line)
};

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
  const io: CliIO = { ...DEFAULT_IO, ...overrides };
  let exitCode = 0;

  const program = new Command();
  program
    .name('htmlppt')
    .description('Visual editor and tooling for static HTML presentations')
    .version('0.0.0')
    .exitOverride();

  program
    .command('new <file>')
    .description('Create a contract-compliant deck')
    .option('--title <title>', 'deck title', 'Untitled deck')
    .option('--slides <count>', 'number of slides', '2')
    .option('--size <size>', 'canvas size, for example 1600x900', '1600x900')
    .action(async (file: string, options: { title: string; slides: string; size: string }) => {
      const match = /^(\d+)x(\d+)$/.exec(options.size);
      if (!match) {
        throw new Error('Invalid --size. Use WIDTHxHEIGHT, for example 1600x900.');
      }
      const width = Number(match[1]);
      const height = Number(match[2]);
      const slides = Number(options.slides);
      if (!Number.isInteger(slides) || slides < 1) {
        throw new Error('Invalid --slides. Use a positive integer.');
      }
      const html = createDeckHtml({ title: options.title, slides, width, height });
      await writeFile(resolve(io.cwd, file), html, 'utf8');
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
