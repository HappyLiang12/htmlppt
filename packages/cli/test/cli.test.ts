import {
  spawn,
  type ChildProcess,
  type ChildProcessWithoutNullStreams
} from 'node:child_process';
import {
  mkdir,
  readFile,
  readdir,
  rm,
  stat,
  symlink,
  writeFile
} from 'node:fs/promises';
import { createRequire } from 'node:module';
import { createServer, type Socket } from 'node:net';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { canonicalDeckPath, sessionKey } from '@htmlppt/host';
import {
  copyFixture,
  fixturesDir,
  makeTempDir
} from '@htmlppt/test-utils';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { formatHostStartError, runCli } from '../src/index.js';

function capture() {
  const stdout: string[] = [];
  const stderr: string[] = [];
  return {
    stdout,
    stderr,
    io: {
      stdout: (line: string) => stdout.push(line),
      stderr: (line: string) => stderr.push(line)
    }
  };
}

describe('htmlppt cli', () => {
  it('creates a deck with slides and a runtime', async () => {
    const cwd = await makeTempDir('htmlppt-cli-');
    const output = capture();

    const code = await runCli(['new', 'demo.html', '--slides', '3'], {
      cwd,
      ...output.io
    });

    expect(code).toBe(0);
    const html = await readFile(join(cwd, 'demo.html'), 'utf8');
    expect(html).toContain('data-slide-id="s3"');
    expect(html).toContain('data-ppt-runtime="1"');
  });

  it('refuses to overwrite an existing deck without --force', async () => {
    const cwd = await makeTempDir('htmlppt-cli-');
    const original = '<!doctype html><title>Keep me</title>';
    await writeFile(join(cwd, 'existing.html'), original, 'utf8');
    const output = capture();

    const code = await runCli(['new', 'existing.html'], {
      cwd,
      ...output.io
    });

    expect(code).toBe(1);
    expect(output.stderr.join('\n')).toContain(
      'Refusing to overwrite existing.html.'
    );
    expect(output.stderr.join('\n')).toContain('Pass --force to replace it.');
    expect(await readFile(join(cwd, 'existing.html'), 'utf8')).toBe(original);
  });

  it('overwrites an existing deck with --force', async () => {
    const cwd = await makeTempDir('htmlppt-cli-');
    await writeFile(join(cwd, 'existing.html'), 'stale', 'utf8');
    const output = capture();

    const code = await runCli(['new', 'existing.html', '--force'], {
      cwd,
      ...output.io
    });

    expect(code).toBe(0);
    const html = await readFile(join(cwd, 'existing.html'), 'utf8');
    expect(html).toContain('<title>Untitled deck</title>');
    expect(html).toContain('data-ppt-runtime="1"');
  });

  it('creates a new deck with --force when the target is absent', async () => {
    const cwd = await makeTempDir('htmlppt-cli-');
    const output = capture();

    const code = await runCli(['new', 'fresh.html', '--force'], {
      cwd,
      ...output.io
    });

    expect(code).toBe(0);
    const html = await readFile(join(cwd, 'fresh.html'), 'utf8');
    expect(html).toContain('data-slide-id="s1"');
  });

  it('creates and force-overwrites decks without temporary files', async () => {
    const cwd = await makeTempDir('htmlppt-cli-');
    const output = capture();

    expect(await runCli(['new', 'deck.html'], { cwd, ...output.io })).toBe(0);
    expect(
      await runCli(['new', 'deck.html', '--force'], { cwd, ...output.io })
    ).toBe(0);

    expect(await readdir(cwd)).toEqual(['deck.html']);
    expect((await readFile(join(cwd, 'deck.html'), 'utf8'))).toContain(
      'data-slide-id="s1"'
    );
  });

  it('leaves no partial destination when new fails', async () => {
    const cwd = await makeTempDir('htmlppt-cli-');
    await mkdir(join(cwd, 'taken.html'));
    const output = capture();

    const code = await runCli(['new', 'taken.html'], { cwd, ...output.io });

    expect(code).toBe(1);
    expect(output.stderr.join('\n')).toContain(
      'Refusing to overwrite taken.html.'
    );
    expect((await stat(join(cwd, 'taken.html'))).isDirectory()).toBe(true);
    expect(await readdir(cwd)).toEqual(['taken.html']);
  });

  it('validates a generated deck as JSON', async () => {
    const cwd = await makeTempDir('htmlppt-cli-');
    await runCli(['new', 'deck.html'], { cwd, ...capture().io });
    const output = capture();

    const code = await runCli(['validate', 'deck.html', '--json'], {
      cwd,
      ...output.io
    });

    expect(code).toBe(0);
    const parsed = JSON.parse(output.stdout.join('\n')) as {
      valid: boolean;
      errors: unknown[];
    };
    expect(parsed.valid).toBe(true);
    expect(parsed.errors).toEqual([]);
  });

  it('returns a non-zero code and a diagnostic for duplicate slide ids', async () => {
    const cwd = await makeTempDir('htmlppt-cli-');
    await writeFile(
      join(cwd, 'bad.html'),
      `<!doctype html><html><head><title>Bad</title></head><body><section data-slide-id="same"></section><section data-slide-id="same"></section></body></html>`,
      'utf8'
    );
    const output = capture();

    const code = await runCli(['validate', 'bad.html', '--json'], {
      cwd,
      ...output.io
    });

    expect(code).toBe(1);
    expect(output.stdout.join('\n')).toContain('duplicate-slide-id');
  });

  it('exports HTML with a generator comment and no editor artifacts', async () => {
    const cwd = await makeTempDir('htmlppt-cli-');
    await runCli(['new', 'deck.html'], { cwd, ...capture().io });
    const output = capture();

    const code = await runCli(
      ['export', 'deck.html', '--format', 'html', '--out', 'out.html'],
      { cwd, ...output.io }
    );

    expect(code).toBe(0);
    const exported = await readFile(join(cwd, 'out.html'), 'utf8');
    expect(exported).toContain('<!-- Edited with htmlppt. Format: htmldeck/v1. -->');
    expect(exported).not.toContain('contenteditable');
  });

  it('exports without leaving temporary files', async () => {
    const cwd = await makeTempDir('htmlppt-cli-');
    await runCli(['new', 'deck.html'], { cwd, ...capture().io });
    const output = capture();

    const code = await runCli(
      ['export', 'deck.html', '--format', 'html'],
      { cwd, ...output.io }
    );

    expect(code).toBe(0);
    expect((await readdir(cwd)).sort()).toEqual([
      'deck.export.html',
      'deck.html'
    ]);
  });

  it('leaves no partial export when the destination cannot be replaced', async () => {
    const cwd = await makeTempDir('htmlppt-cli-');
    await runCli(['new', 'deck.html'], { cwd, ...capture().io });
    await mkdir(join(cwd, 'out.html'));
    const output = capture();

    const code = await runCli(
      ['export', 'deck.html', '--format', 'html', '--out', 'out.html'],
      { cwd, ...output.io }
    );

    expect(code).toBe(1);
    expect((await stat(join(cwd, 'out.html'))).isDirectory()).toBe(true);
    expect((await readdir(cwd)).sort()).toEqual(['deck.html', 'out.html']);
  });

  it('refuses to overwrite the source deck with an HTML export', async () => {
    const cwd = await makeTempDir('htmlppt-cli-');
    await runCli(['new', 'deck.html'], { cwd, ...capture().io });
    const source = await readFile(join(cwd, 'deck.html'));

    for (const out of ['deck.html', './deck.html', join(cwd, 'deck.html')]) {
      const output = capture();
      const code = await runCli(
        ['export', 'deck.html', '--format', 'html', '--out', out],
        { cwd, ...output.io }
      );

      expect(code).toBe(1);
      expect(output.stderr.join('\n')).toContain(
        'Refusing to overwrite the source deck. Choose a different --out path.'
      );
      expect(output.stdout).toEqual([]);
      expect(await readFile(join(cwd, 'deck.html'))).toEqual(source);
    }
    expect((await readdir(cwd)).sort()).toEqual(['deck.html']);
  });

  it.runIf(process.platform === 'win32')(
    'refuses a case-variant --out that names the source deck',
    async () => {
      const cwd = await makeTempDir('htmlppt-cli-');
      await runCli(['new', 'deck.html'], { cwd, ...capture().io });
      const source = await readFile(join(cwd, 'deck.html'));
      const output = capture();

      const code = await runCli(
        ['export', 'deck.html', '--format', 'html', '--out', 'DeCk.HtMl'],
        { cwd, ...output.io }
      );

      expect(code).toBe(1);
      expect(output.stderr.join('\n')).toContain(
        'Refusing to overwrite the source deck.'
      );
      expect(await readFile(join(cwd, 'deck.html'))).toEqual(source);
    }
  );

  it(
    'refuses to overwrite the source deck with a PDF export',
    async () => {
      const cwd = await makeTempDir('htmlppt-cli-');
      await runCli(['new', 'deck.html'], { cwd, ...capture().io });
      const source = await readFile(join(cwd, 'deck.html'));
      const previous = process.env.HTMLPPT_CHROMIUM;
      // A missing browser proves the refusal happens before rendering.
      process.env.HTMLPPT_CHROMIUM = join(cwd, 'missing-browser.exe');
      try {
        const output = capture();
        const code = await runCli(
          ['export', 'deck.html', '--format', 'pdf', '--out', 'deck.html'],
          { cwd, ...output.io }
        );

        expect(code).toBe(1);
        expect(output.stderr.join('\n')).toContain(
          'Refusing to overwrite the source deck. Choose a different --out path.'
        );
        expect(output.stderr.join('\n')).not.toContain('Chromium');
        expect(await readFile(join(cwd, 'deck.html'))).toEqual(source);
      } finally {
        if (previous === undefined) {
          delete process.env.HTMLPPT_CHROMIUM;
        } else {
          process.env.HTMLPPT_CHROMIUM = previous;
        }
      }
      expect((await readdir(cwd)).sort()).toEqual(['deck.html']);
    },
    30_000
  );

  it('rejects unsupported export formats with a clear error', async () => {
    const cwd = await makeTempDir('htmlppt-cli-');
    await runCli(['new', 'deck.html'], { cwd, ...capture().io });
    const output = capture();

    const code = await runCli(['export', 'deck.html', '--format', 'jpg'], {
      cwd,
      ...output.io
    });

    expect(code).toBe(1);
    expect(output.stderr.join('\n')).toContain(
      'Unsupported export format "jpg". Use --format html, pdf, or png.'
    );
    expect(await readdir(cwd)).toEqual(['deck.html']);
  });

  it(
    'exports a PDF beside the deck or to an explicit file',
    async () => {
      const cwd = await makeTempDir('htmlppt-cli-');
      await runCli(['new', 'deck.html'], { cwd, ...capture().io });

      const defaultOutput = capture();
      const defaultCode = await runCli(
        ['export', 'deck.html', '--format', 'pdf'],
        { cwd, ...defaultOutput.io }
      );
      expect(defaultCode).toBe(0);
      const defaultPath = join(cwd, 'deck.pdf');
      expect(defaultOutput.stdout).toEqual([`Exported ${defaultPath}`]);
      expect(
        (await readFile(defaultPath)).subarray(0, 5).toString('latin1')
      ).toBe('%PDF-');

      const output = capture();
      const code = await runCli(
        ['export', 'deck.html', '--format', 'pdf', '--out', 'custom.pdf'],
        { cwd, ...output.io }
      );
      expect(code).toBe(0);
      expect(output.stdout).toEqual([`Exported ${join(cwd, 'custom.pdf')}`]);
      expect((await readdir(cwd)).sort()).toEqual([
        'custom.pdf',
        'deck.html',
        'deck.pdf'
      ]);
      expect(await readFile(join(cwd, 'deck.html'), 'utf8')).toContain(
        'data-ppt-runtime="1"'
      );
    },
    30_000
  );

  it(
    'exports one PNG per slide beside the deck by default',
    async () => {
      const cwd = await makeTempDir('htmlppt-cli-');
      await runCli(['new', 'deck.html', '--slides', '2'], {
        cwd,
        ...capture().io
      });
      const output = capture();

      const code = await runCli(['export', 'deck.html', '--format', 'png'], {
        cwd,
        ...output.io
      });

      expect(code).toBe(0);
      const expected = [join(cwd, 'deck-s1.png'), join(cwd, 'deck-s2.png')];
      expect(output.stdout).toEqual(expected.map((file) => `Exported ${file}`));
      for (const file of expected) {
        const signature = await readFile(file);
        expect(signature.subarray(0, 8)).toEqual(
          Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
        );
      }
      expect((await readdir(cwd)).sort()).toEqual([
        'deck-s1.png',
        'deck-s2.png',
        'deck.html'
      ]);
    },
    30_000
  );

  it(
    'treats --out as a PNG output directory and creates it',
    async () => {
      const cwd = await makeTempDir('htmlppt-cli-');
      await runCli(['new', 'deck.html', '--slides', '1'], {
        cwd,
        ...capture().io
      });
      const output = capture();

      const code = await runCli(
        ['export', 'deck.html', '--format', 'png', '--out', 'renders'],
        { cwd, ...output.io }
      );

      expect(code).toBe(0);
      const expected = join(cwd, 'renders', 'deck-s1.png');
      expect(output.stdout).toEqual([`Exported ${expected}`]);
      expect((await readFile(expected)).subarray(0, 4)).toEqual(
        Buffer.from([0x89, 0x50, 0x4e, 0x47])
      );
    },
    30_000
  );

  it(
    'reports an unavailable Chromium with actionable guidance',
    async () => {
      const cwd = await makeTempDir('htmlppt-cli-');
      await runCli(['new', 'deck.html'], { cwd, ...capture().io });
      const previous = process.env.HTMLPPT_CHROMIUM;
      process.env.HTMLPPT_CHROMIUM = join(cwd, 'missing-browser.exe');
      try {
        const output = capture();
        const code = await runCli(
          ['export', 'deck.html', '--format', 'pdf'],
          { cwd, ...output.io }
        );
        expect(code).toBe(1);
        expect(output.stderr.join('\n')).toContain('Chromium is unavailable');
        expect(output.stderr.join('\n')).toContain('HTMLPPT_CHROMIUM');
      } finally {
        if (previous === undefined) {
          delete process.env.HTMLPPT_CHROMIUM;
        } else {
          process.env.HTMLPPT_CHROMIUM = previous;
        }
      }
      expect(await readdir(cwd)).toEqual(['deck.html']);
    },
    30_000
  );

  it('routes help output through the injected io', async () => {
    const output = capture();

    const code = await runCli(['--help'], output.io);

    expect(code).toBe(0);
    const stdout = output.stdout.join('\n');
    expect(stdout).toContain('Usage');
    expect(stdout).toContain('new');
  });

  it('routes version output through the injected io', async () => {
    const output = capture();

    const code = await runCli(['--version'], output.io);

    expect(code).toBe(0);
    expect(output.stdout.join('\n')).toContain('0.0.0');
  });

  it('rejects a zero size with the size error', async () => {
    const cwd = await makeTempDir('htmlppt-cli-');
    const output = capture();

    const code = await runCli(['new', 'zero.html', '--size', '0x0'], {
      cwd,
      ...output.io
    });

    expect(code).toBe(1);
    expect(output.stderr.join('\n')).toContain(
      'Invalid --size. Use positive WIDTHxHEIGHT, for example 1600x900.'
    );
  });

  it.each(['0', '1001', '1e3'])('rejects --slides %s', async (slides) => {
    const cwd = await makeTempDir('htmlppt-cli-');
    const output = capture();

    const code = await runCli(['new', 'deck.html', '--slides', slides], {
      cwd,
      ...output.io
    });

    expect(code).toBe(1);
    expect(output.stderr.join('\n')).toContain(
      'Invalid --slides. Use a positive integer up to 1000.'
    );
  });

  it('reports a valid deck in plain mode', async () => {
    const cwd = await makeTempDir('htmlppt-cli-');
    await runCli(['new', 'deck.html'], { cwd, ...capture().io });
    const output = capture();

    const code = await runCli(['validate', 'deck.html'], { cwd, ...output.io });

    expect(code).toBe(0);
    expect(output.stdout.join('\n')).toContain('Deck is valid.');
  });

  it('exports beside the source by default', async () => {
    const cwd = await makeTempDir('htmlppt-cli-');
    await runCli(['new', 'deck.html'], { cwd, ...capture().io });
    const output = capture();

    const code = await runCli(['export', 'deck.html', '--format', 'html'], {
      cwd,
      ...output.io
    });

    expect(code).toBe(0);
    const exported = await readFile(join(cwd, 'deck.export.html'), 'utf8');
    expect(exported).toContain('<!-- Edited with htmlppt. Format: htmldeck/v1. -->');
  });

  it.each(['abc', '-1', '1.5', '70000'])(
    'rejects --port %s before starting the host',
    async (port) => {
      const cwd = await makeTempDir('htmlppt-cli-');
      const output = capture();

      const code = await runCli(
        ['open', 'deck.html', `--port=${port}`, '--no-browser'],
        { cwd, ...output.io }
      );

      expect(code).toBe(1);
      expect(output.stderr.join('\n')).toContain(
        'Invalid --port. Use an integer between 0 and 65535.'
      );
    }
  );

  it('reports a missing deck file with actionable guidance', async () => {
    const cwd = await makeTempDir('htmlppt-cli-');
    const output = capture();

    const code = await runCli(['open', 'missing.html', '--no-browser'], {
      cwd,
      ...output.io
    });

    expect(code).toBe(1);
    expect(output.stderr.join('\n')).toContain(
      'Deck file not found: missing.html. Create one with "htmlppt new missing.html".'
    );
    expect(output.stdout.join('\n')).not.toContain('HTMLPPT_URL=');
  });

  it('reports an occupied port with actionable guidance', async () => {
    const cwd = await makeTempDir('htmlppt-cli-');
    await runCli(['new', 'deck.html'], { cwd, ...capture().io });
    const probe = createServer();
    await new Promise<void>((resolve, reject) => {
      probe.once('error', reject);
      probe.listen(0, '127.0.0.1', resolve);
    });
    const address = probe.address();
    if (!address || typeof address === 'string') {
      throw new Error('Probe server did not expose a TCP port.');
    }
    const output = capture();
    try {
      const code = await runCli(
        ['open', 'deck.html', `--port=${address.port}`, '--no-browser'],
        { cwd, ...output.io }
      );

      expect(code).toBe(1);
      expect(output.stderr.join('\n')).toContain(
        `Port ${address.port} is already in use. Omit --port or choose another.`
      );
      expect(output.stdout.join('\n')).not.toContain('HTMLPPT_URL=');
    } finally {
      await new Promise<void>((resolve, reject) => {
        probe.close((error) => (error ? reject(error) : resolve()));
      });
    }
  });

  it('reports a directory deck path as unreadable', async () => {
    const cwd = await makeTempDir('htmlppt-cli-');
    await mkdir(join(cwd, 'deck-dir'));
    const output = capture();

    const code = await runCli(['open', 'deck-dir', '--no-browser'], {
      cwd,
      ...output.io
    });

    expect(code).toBe(1);
    expect(output.stderr.join('\n')).toContain('Deck file could not be read');
    expect(output.stdout.join('\n')).not.toContain('HTMLPPT_URL=');
  });

  describe('formatHostStartError', () => {
    const deckPath = join('decks', 'deck.html');

    function errnoError(
      code: string,
      details: Partial<NodeJS.ErrnoException> = {}
    ): NodeJS.ErrnoException {
      return Object.assign(new Error(`${code}: synthetic failure`), {
        code,
        ...details
      });
    }

    it('maps ENOENT for the deck path to the missing-deck message', () => {
      const message = formatHostStartError(
        errnoError('ENOENT', { path: deckPath }),
        deckPath,
        4321
      );

      expect(message).toBe(
        `Deck file not found: ${deckPath}. Create one with "htmlppt new ${deckPath}".`
      );
    });

    it('does not map ENOENT for another path', () => {
      const message = formatHostStartError(
        errnoError('ENOENT', { path: join('other', 'deck.html') }),
        deckPath,
        4321
      );

      expect(message).toBeNull();
    });

    it('does not map a listen EACCES to an unreadable deck', () => {
      const message = formatHostStartError(
        errnoError('EACCES', { syscall: 'listen' }),
        deckPath,
        4321
      );

      expect(message).toBeNull();
    });

    it('maps an open EACCES on the deck path to the unreadable message', () => {
      const message = formatHostStartError(
        errnoError('EACCES', { syscall: 'open', path: deckPath }),
        deckPath,
        4321
      );

      expect(message).toBe(`Deck file could not be read: ${deckPath}.`);
    });

    it('maps EISDIR on the deck path to the unreadable message', () => {
      const message = formatHostStartError(
        errnoError('EISDIR', { path: deckPath }),
        deckPath,
        4321
      );

      expect(message).toBe(`Deck file could not be read: ${deckPath}.`);
    });
  });

  it('reports a missing editor build with an actionable error', async () => {
    const cwd = await makeTempDir('htmlppt-cli-');
    const emptyEditorDir = await makeTempDir('htmlppt-editor-empty-');
    const output = capture();
    const previous = process.env.HTMLPPT_EDITOR_DIR;
    process.env.HTMLPPT_EDITOR_DIR = emptyEditorDir;

    try {
      const code = await runCli(['open', 'deck.html', '--no-browser'], {
        cwd,
        ...output.io
      });

      expect(code).toBe(1);
      expect(output.stderr.join('\n')).toContain('Editor build not found');
    } finally {
      if (previous === undefined) {
        delete process.env.HTMLPPT_EDITOR_DIR;
      } else {
        process.env.HTMLPPT_EDITOR_DIR = previous;
      }
    }
  });
});

const repoRoot = fileURLToPath(new URL('../../..', import.meta.url));
const cliBin = join(repoRoot, 'packages', 'cli', 'dist', 'bin.js');
const tsupCli = createRequire(import.meta.url).resolve(
  'tsup/dist/cli-default.js'
);

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

interface CliWorkspace {
  cwd: string;
  home: string;
  editorDir: string;
}

async function createCliWorkspace(): Promise<CliWorkspace> {
  const cwd = await makeTempDir('htmlppt-cli-process-');
  const home = join(cwd, 'home');
  await mkdir(home, { recursive: true });
  const editorDir = join(cwd, 'editor');
  await mkdir(editorDir, { recursive: true });
  await writeFile(
    join(editorDir, 'index.html'),
    '<!doctype html><title>Editor</title><div id="root">editor-shell</div>',
    'utf8'
  );
  return { cwd, home, editorDir };
}

function cliEnvironment(workspace: CliWorkspace): NodeJS.ProcessEnv {
  return {
    ...process.env,
    HTMLPPT_HOME: workspace.home,
    HTMLPPT_EDITOR_DIR: workspace.editorDir
  };
}

function sessionFilePath(workspace: CliWorkspace, deckPath: string): string {
  return join(
    workspace.home,
    'sessions',
    `${sessionKey(deckPath)}.json`
  );
}

async function sessionCount(workspace: CliWorkspace): Promise<number> {
  try {
    const names = await readdir(join(workspace.home, 'sessions'));
    return names.filter((name) => name.endsWith('.json')).length;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return 0;
    }
    throw error;
  }
}

interface CliProcessOptions {
  cwd: string;
  env?: NodeJS.ProcessEnv;
}

class CliProcess {
  readonly child: ChildProcessWithoutNullStreams;
  private stdoutBuffer = '';
  private stderrBuffer = '';
  private exitCodeValue: number | null = null;
  private readonly waiters = new Set<() => void>();

  constructor(args: string[], options: CliProcessOptions) {
    this.child = spawn(process.execPath, [cliBin, ...args], {
      cwd: options.cwd,
      env: options.env ?? process.env,
      stdio: ['pipe', 'pipe', 'pipe']
    });
    this.child.stdout.setEncoding('utf8');
    this.child.stderr.setEncoding('utf8');
    this.child.stdout.on('data', (chunk: string) => {
      this.stdoutBuffer += chunk;
      this.notify();
    });
    this.child.stderr.on('data', (chunk: string) => {
      this.stderrBuffer += chunk;
      this.notify();
    });
    this.child.once('close', (code) => {
      this.exitCodeValue = code;
      this.notify();
    });
  }

  get stdout(): string {
    return this.stdoutBuffer;
  }

  get stderr(): string {
    return this.stderrBuffer;
  }

  waitForOutput(
    pattern: RegExp,
    timeoutMs = 15_000
  ): Promise<RegExpExecArray> {
    return this.waitUntil(
      () => pattern.exec(this.stdout) ?? undefined,
      timeoutMs,
      `stdout to match ${pattern}`
    );
  }

  waitForJsonRpc(
    id: number,
    timeoutMs = 15_000
  ): Promise<Record<string, unknown>> {
    return this.waitUntil(
      () => {
        for (const line of this.stdout.split('\n')) {
          const trimmed = line.trim();
          if (!trimmed.startsWith('{')) {
            continue;
          }
          try {
            const parsed = JSON.parse(trimmed) as Record<string, unknown>;
            if (parsed.id === id) {
              return parsed;
            }
          } catch {
            // The line is still being written.
          }
        }
        return undefined;
      },
      timeoutMs,
      `a JSON-RPC response with id ${id}`
    );
  }

  waitForExit(timeoutMs = 15_000): Promise<number | null> {
    return this.waitUntil(
      () => (this.exitCodeValue === null ? undefined : this.exitCodeValue),
      timeoutMs,
      'the process to exit'
    );
  }

  kill(): void {
    if (this.exitCodeValue === null) {
      this.child.kill('SIGKILL');
    }
  }

  private notify(): void {
    for (const waiter of [...this.waiters]) {
      waiter();
    }
  }

  private waitUntil<T>(
    check: () => T | null | undefined | false,
    timeoutMs: number,
    description: string
  ): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.waiters.delete(run);
        reject(
          new Error(
            `Timed out after ${timeoutMs} ms waiting for ${description}.\nstdout:\n${this.stdout}\nstderr:\n${this.stderr}`
          )
        );
      }, timeoutMs);
      const run = (): void => {
        const value = check();
        if (value !== undefined && value !== null && value !== false) {
          clearTimeout(timer);
          this.waiters.delete(run);
          resolve(value);
        }
      };
      this.waiters.add(run);
      run();
    });
  }
}

async function runCliProcess(
  args: string[],
  options: CliProcessOptions,
  timeoutMs = 15_000
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  const cli = new CliProcess(args, options);
  cli.child.stdin.end();
  try {
    const code = await cli.waitForExit(timeoutMs);
    return { code, stdout: cli.stdout, stderr: cli.stderr };
  } finally {
    cli.kill();
  }
}

async function closedPort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  if (!address || typeof address === 'string') {
    throw new Error('The probe server did not expose a TCP port.');
  }
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
  return address.port;
}

function spawnKeepalive(): Promise<ChildProcess> {
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
    stdio: 'ignore'
  });
  return new Promise((resolve, reject) => {
    child.once('spawn', () => resolve(child));
    child.once('error', reject);
  });
}

async function exitedPid(): Promise<number> {
  const child = spawn(process.execPath, ['-e', ''], { stdio: 'ignore' });
  const pid = child.pid;
  if (pid === undefined) {
    throw new Error('The short-lived process did not expose a pid.');
  }
  await new Promise<void>((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', () => resolve());
  });
  return pid;
}

interface SilentHost {
  port: number;
  close: () => Promise<void>;
}

/** Accepts TCP connections but never answers, so health checks time out. */
async function silentHost(): Promise<SilentHost> {
  const sockets = new Set<Socket>();
  const server = createServer((socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  if (!address || typeof address === 'string') {
    throw new Error('The silent server did not expose a TCP port.');
  }
  return {
    port: address.port,
    close: async () => {
      for (const socket of sockets) {
        socket.destroy();
      }
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  };
}

interface StaleSessionOptions {
  pid: number;
  port: number;
}

async function writeStaleSession(
  workspace: CliWorkspace,
  deckPath: string,
  options: StaleSessionOptions
): Promise<string> {
  await mkdir(join(workspace.home, 'sessions'), { recursive: true });
  const raw = `${JSON.stringify(
    {
      path: deckPath,
      port: options.port,
      token: 'stale-token',
      pid: options.pid,
      startedAt: new Date().toISOString(),
      revision: 'a'.repeat(64)
    },
    null,
    2
  )}\n`;
  await writeFile(sessionFilePath(workspace, deckPath), raw, 'utf8');
  return raw;
}

describe('htmlppt cli as a real process', () => {
  beforeAll(async () => {
    await buildWorkspace();
  }, 180_000);

  it('writes a session entry and reuses a live editor for a second open', async () => {
    const workspace = await createCliWorkspace();
    await copyFixture('basic.deck.html', workspace.cwd);
    const deckPath = join(workspace.cwd, 'basic.deck.html');
    const processes: CliProcess[] = [];

    try {
      const first = new CliProcess(['open', 'basic.deck.html', '--no-browser'], {
        cwd: workspace.cwd,
        env: cliEnvironment(workspace)
      });
      processes.push(first);
      const firstMatch = await first.waitForOutput(/HTMLPPT_URL=(\S+)\r?\n/);
      const url = new URL(firstMatch[1]);
      expect(url.protocol).toBe('http:');
      expect(url.hostname).toBe('127.0.0.1');
      const token = url.searchParams.get('token');
      expect(token).toBeTruthy();
      const pid = first.child.pid;
      if (pid === undefined) {
        throw new Error('The CLI process did not expose a pid.');
      }

      const entry = JSON.parse(
        await readFile(sessionFilePath(workspace, deckPath), 'utf8')
      ) as Record<string, unknown>;
      expect(entry).toMatchObject({
        path: deckPath,
        port: Number(url.port),
        token,
        pid
      });
      expect(entry.revision).toMatch(/^[a-f0-9]{64}$/);
      expect(new Date(String(entry.startedAt)).toISOString()).toBe(
        entry.startedAt
      );

      const second = new CliProcess(
        ['open', 'basic.deck.html', '--no-browser'],
        { cwd: workspace.cwd, env: cliEnvironment(workspace) }
      );
      processes.push(second);
      const secondMatch = await second.waitForOutput(/HTMLPPT_URL=(\S+)\r?\n/);
      expect(secondMatch[1]).toBe(url.href);
      expect(await second.waitForExit(10_000)).toBe(0);
      expect(await sessionCount(workspace)).toBe(1);
      expect(
        JSON.parse(
          await readFile(sessionFilePath(workspace, deckPath), 'utf8')
        )
      ).toEqual(entry);
    } finally {
      for (const cli of processes) {
        cli.kill();
      }
    }
  });

  it('keeps the deck port when a stopped deck reopens', async () => {
    const workspace = await createCliWorkspace();
    await copyFixture('basic.deck.html', workspace.cwd);
    const first = new CliProcess(['open', 'basic.deck.html', '--no-browser'], {
      cwd: workspace.cwd,
      env: cliEnvironment(workspace)
    });
    let second: CliProcess | undefined;

    try {
      const firstMatch = await first.waitForOutput(/HTMLPPT_URL=(\S+)\r?\n/);
      const firstUrl = new URL(firstMatch[1]);

      const stop = await runCliProcess(['stop', 'basic.deck.html'], {
        cwd: workspace.cwd,
        env: cliEnvironment(workspace)
      });
      expect(stop.code).toBe(0);
      await first.waitForExit(10_000);

      second = new CliProcess(['open', 'basic.deck.html', '--no-browser'], {
        cwd: workspace.cwd,
        env: cliEnvironment(workspace)
      });
      const secondMatch = await second.waitForOutput(/HTMLPPT_URL=(\S+)\r?\n/);
      const secondUrl = new URL(secondMatch[1]);

      expect(secondUrl.port).toBe(firstUrl.port);
    } finally {
      first.kill();
      second?.kill();
    }
  });

  it('rotates the token on stop and keeps the port', async () => {
    const workspace = await createCliWorkspace();
    await copyFixture('basic.deck.html', workspace.cwd);
    const deckPath = join(workspace.cwd, 'basic.deck.html');
    const credentialPath = join(
      workspace.home,
      'decks',
      `${sessionKey(await canonicalDeckPath(deckPath))}.json`
    );
    const open = new CliProcess(['open', 'basic.deck.html', '--no-browser'], {
      cwd: workspace.cwd,
      env: cliEnvironment(workspace)
    });

    try {
      const match = await open.waitForOutput(/HTMLPPT_URL=(\S+)\r?\n/);
      const url = new URL(match[1]);
      // Positive control: open records the identity it printed, so a later
      // difference proves the stop rotated it.
      const before = JSON.parse(await readFile(credentialPath, 'utf8')) as {
        token: string;
        port: number;
      };
      expect(before.token).toBe(url.searchParams.get('token'));
      expect(before.port).toBe(Number(url.port));

      const stop = await runCliProcess(['stop', 'basic.deck.html'], {
        cwd: workspace.cwd,
        env: cliEnvironment(workspace)
      });
      expect(stop.code).toBe(0);
      expect(stop.stdout).toContain('Stopped editor');
      await open.waitForExit(10_000);

      const after = JSON.parse(await readFile(credentialPath, 'utf8')) as {
        token: string;
        port: number;
      };
      expect(after.port).toBe(before.port);
      expect(after.port).toBe(Number(url.port));
      expect(after.token).not.toBe(before.token);
      expect(after.token.length).toBeGreaterThan(0);
    } finally {
      open.kill();
    }
  });

  it('warns but still stops when the credential cannot be rotated', async () => {
    const workspace = await createCliWorkspace();
    await copyFixture('basic.deck.html', workspace.cwd);
    const deckPath = join(workspace.cwd, 'basic.deck.html');
    const credentialPath = join(
      workspace.home,
      'decks',
      `${sessionKey(await canonicalDeckPath(deckPath))}.json`
    );
    // A directory where the credential file belongs makes the record and the
    // rotation fail without relying on permission bits, which Windows ignores.
    await mkdir(credentialPath, { recursive: true });
    const open = new CliProcess(['open', 'basic.deck.html', '--no-browser'], {
      cwd: workspace.cwd,
      env: cliEnvironment(workspace)
    });

    try {
      await open.waitForOutput(/HTMLPPT_URL=(\S+)\r?\n/);

      const stop = await runCliProcess(['stop', 'basic.deck.html'], {
        cwd: workspace.cwd,
        env: cliEnvironment(workspace)
      });

      expect(stop.code).toBe(0);
      expect(stop.stdout).toContain('Stopped editor');
      expect(stop.stderr).toContain('could not rotate its credential');
      await open.waitForExit(10_000);
      await expect(
        readFile(sessionFilePath(workspace, deckPath), 'utf8')
      ).rejects.toMatchObject({ code: 'ENOENT' });
    } finally {
      open.kill();
      await rm(credentialPath, { recursive: true, force: true });
    }
  });

  it('reuses the deck token when an editor restarts without a stop', async () => {
    const workspace = await createCliWorkspace();
    await copyFixture('basic.deck.html', workspace.cwd);
    const first = new CliProcess(['open', 'basic.deck.html', '--no-browser'], {
      cwd: workspace.cwd,
      env: cliEnvironment(workspace)
    });
    let second: CliProcess | undefined;

    try {
      const firstMatch = await first.waitForOutput(/HTMLPPT_URL=(\S+)\r?\n/);
      const firstUrl = new URL(firstMatch[1]);
      expect(firstUrl.searchParams.get('token')).toBeTruthy();

      // Simulate an editor that went away without `htmlppt stop`, so the next
      // open has to read the token back from the credential store.
      const exited = new Promise<void>((resolve) => {
        first.child.once('close', () => resolve());
      });
      first.kill();
      await exited;

      second = new CliProcess(['open', 'basic.deck.html', '--no-browser'], {
        cwd: workspace.cwd,
        env: cliEnvironment(workspace)
      });
      const secondMatch = await second.waitForOutput(/HTMLPPT_URL=(\S+)\r?\n/);
      const secondUrl = new URL(secondMatch[1]);

      expect(secondUrl.searchParams.get('token')).toBe(
        firstUrl.searchParams.get('token')
      );
      expect(secondUrl.port).toBe(firstUrl.port);
    } finally {
      first.kill();
      second?.kill();
    }
  });

  it('adopts the live identity when the credential store is empty', async () => {
    const workspace = await createCliWorkspace();
    await copyFixture('basic.deck.html', workspace.cwd);
    const deckPath = join(workspace.cwd, 'basic.deck.html');
    const first = new CliProcess(['open', 'basic.deck.html', '--no-browser'], {
      cwd: workspace.cwd,
      env: cliEnvironment(workspace)
    });
    let second: CliProcess | undefined;

    try {
      const firstMatch = await first.waitForOutput(/HTMLPPT_URL=(\S+)\r?\n/);
      const firstUrl = new URL(firstMatch[1]);
      const credentialPath = join(
        workspace.home,
        'decks',
        `${sessionKey(await canonicalDeckPath(deckPath))}.json`
      );

      // A live host from before the store existed has no credential file.
      await rm(credentialPath);
      await expect(readFile(credentialPath, 'utf8')).rejects.toMatchObject({
        code: 'ENOENT'
      });

      second = new CliProcess(['open', 'basic.deck.html', '--no-browser'], {
        cwd: workspace.cwd,
        env: cliEnvironment(workspace)
      });
      const secondMatch = await second.waitForOutput(/HTMLPPT_URL=(\S+)\r?\n/);
      expect(secondMatch[1]).toBe(firstUrl.href);
      expect(await second.waitForExit(10_000)).toBe(0);

      expect(
        JSON.parse(await readFile(credentialPath, 'utf8'))
      ).toMatchObject({
        token: firstUrl.searchParams.get('token'),
        port: Number(firstUrl.port)
      });
    } finally {
      first.kill();
      second?.kill();
    }
  });

  it('falls back to a new port when the recorded one is taken', async () => {
    const workspace = await createCliWorkspace();
    await copyFixture('basic.deck.html', workspace.cwd);
    const deckPath = join(workspace.cwd, 'basic.deck.html');
    const first = new CliProcess(['open', 'basic.deck.html', '--no-browser'], {
      cwd: workspace.cwd,
      env: cliEnvironment(workspace)
    });
    let second: CliProcess | undefined;
    const probe = createServer();

    try {
      const firstMatch = await first.waitForOutput(/HTMLPPT_URL=(\S+)\r?\n/);
      const firstUrl = new URL(firstMatch[1]);

      const stop = await runCliProcess(['stop', 'basic.deck.html'], {
        cwd: workspace.cwd,
        env: cliEnvironment(workspace)
      });
      expect(stop.code).toBe(0);
      await first.waitForExit(10_000);
      const credentialPath = join(
        workspace.home,
        'decks',
        `${sessionKey(await canonicalDeckPath(deckPath))}.json`
      );
      const rotated = JSON.parse(await readFile(credentialPath, 'utf8')) as {
        token: string;
        port: number;
      };
      expect(rotated.port).toBe(Number(firstUrl.port));
      expect(rotated.token).not.toBe(firstUrl.searchParams.get('token'));

      await new Promise<void>((resolve, reject) => {
        probe.once('error', reject);
        probe.listen(Number(firstUrl.port), '127.0.0.1', resolve);
      });

      second = new CliProcess(['open', 'basic.deck.html', '--no-browser'], {
        cwd: workspace.cwd,
        env: cliEnvironment(workspace)
      });
      const secondMatch = await second.waitForOutput(/HTMLPPT_URL=(\S+)\r?\n/);
      const secondUrl = new URL(secondMatch[1]);

      const warning = `Port ${firstUrl.port} is in use; starting basic.deck.html on a new port. Existing bookmarks for this deck will stop working.`;
      await vi.waitFor(() => expect(second?.stderr).toContain(warning), {
        timeout: 10_000
      });
      expect(secondUrl.port).not.toBe(firstUrl.port);

      // stop rotates the token, so the fallback must keep that rotated
      // identity and only change the address: the printed URL carries the
      // rotated token, and the recorded credential pairs it with the new port.
      expect(secondUrl.searchParams.get('token')).toBe(rotated.token);
      expect(
        JSON.parse(await readFile(credentialPath, 'utf8'))
      ).toMatchObject({
        token: rotated.token,
        port: Number(secondUrl.port)
      });
    } finally {
      first.kill();
      second?.kill();
      if (probe.listening) {
        await new Promise<void>((resolve) => probe.close(() => resolve()));
      }
    }
  });

  it('stops a host, removes the entry, and fails a second stop', async () => {
    const workspace = await createCliWorkspace();
    await copyFixture('basic.deck.html', workspace.cwd);
    const deckPath = join(workspace.cwd, 'basic.deck.html');
    const open = new CliProcess(['open', 'basic.deck.html', '--no-browser'], {
      cwd: workspace.cwd,
      env: cliEnvironment(workspace)
    });
    let stopProcess: CliProcess | undefined;

    try {
      await open.waitForOutput(/HTMLPPT_URL=(\S+)\r?\n/);
      const entry = JSON.parse(
        await readFile(sessionFilePath(workspace, deckPath), 'utf8')
      ) as { pid: number };

      stopProcess = new CliProcess(['stop', 'basic.deck.html'], {
        cwd: workspace.cwd,
        env: cliEnvironment(workspace)
      });
      stopProcess.child.stdin.end();
      const [, stopCode] = await Promise.all([
        open.waitForExit(5_000),
        stopProcess.waitForExit(15_000)
      ]);

      expect(stopCode).toBe(0);
      expect(stopProcess.stdout).toContain('Stopped editor');
      await expect(
        readFile(sessionFilePath(workspace, deckPath), 'utf8')
      ).rejects.toMatchObject({ code: 'ENOENT' });
      expect(() => process.kill(entry.pid, 0)).toThrow();

      const second = await runCliProcess(['stop', 'basic.deck.html'], {
        cwd: workspace.cwd,
        env: cliEnvironment(workspace)
      });
      expect(second.code).toBe(1);
      expect(second.stderr).toContain('No live editor session');
      expect(second.stderr).toContain('htmlppt open');
    } finally {
      open.kill();
      stopProcess?.kill();
    }
  });

  it('stops a host after its deck file is deleted', async () => {
    const workspace = await createCliWorkspace();
    await copyFixture('basic.deck.html', workspace.cwd);
    const deckPath = join(workspace.cwd, 'basic.deck.html');
    const open = new CliProcess(['open', 'basic.deck.html', '--no-browser'], {
      cwd: workspace.cwd,
      env: cliEnvironment(workspace)
    });

    try {
      await open.waitForOutput(/HTMLPPT_URL=(\S+)\r?\n/);
      await rm(deckPath);

      const stop = await runCliProcess(['stop', 'basic.deck.html'], {
        cwd: workspace.cwd,
        env: cliEnvironment(workspace)
      });

      expect(stop.code).toBe(0);
      expect(stop.stdout).toContain('Stopped editor');
      await open.waitForExit(10_000);
      await expect(
        readFile(sessionFilePath(workspace, deckPath), 'utf8')
      ).rejects.toMatchObject({ code: 'ENOENT' });
    } finally {
      open.kill();
    }
  });

  it('stops every live editor with --all', async () => {
    const workspace = await createCliWorkspace();
    const directories = ['one', 'two'];
    const opens: CliProcess[] = [];
    const deckPaths: string[] = [];
    const urls: URL[] = [];
    for (const name of directories) {
      const directory = join(workspace.cwd, name);
      await mkdir(directory, { recursive: true });
      const deckPath = await copyFixture('basic.deck.html', directory);
      deckPaths.push(deckPath);
      opens.push(
        new CliProcess(
          ['open', join(name, 'basic.deck.html'), '--no-browser'],
          { cwd: workspace.cwd, env: cliEnvironment(workspace) }
        )
      );
    }

    try {
      for (const open of opens) {
        const match = await open.waitForOutput(/HTMLPPT_URL=(\S+)\r?\n/);
        urls.push(new URL(match[1]));
      }
      expect(await sessionCount(workspace)).toBe(2);

      const stop = new CliProcess(['stop', '--all'], {
        cwd: workspace.cwd,
        env: cliEnvironment(workspace)
      });
      stop.child.stdin.end();
      const [stopCode] = await Promise.all([
        stop.waitForExit(15_000),
        ...opens.map((open) => open.waitForExit(5_000))
      ]);

      expect(stopCode).toBe(0);
      expect(stop.stdout).toContain('Stopped editor');
      expect(await sessionCount(workspace)).toBe(0);
      for (const [index, deckPath] of deckPaths.entries()) {
        await expect(
          readFile(sessionFilePath(workspace, deckPath), 'utf8')
        ).rejects.toMatchObject({ code: 'ENOENT' });
        // --all routes through stopSession too, so every stopped deck must
        // keep its port and receive a rotated token.
        const credential = JSON.parse(
          await readFile(
            join(
              workspace.home,
              'decks',
              `${sessionKey(await canonicalDeckPath(deckPath))}.json`
            ),
            'utf8'
          )
        ) as { token: string; port: number };
        expect(credential.port).toBe(Number(urls[index].port));
        expect(credential.token).not.toBe(urls[index].searchParams.get('token'));
      }
    } finally {
      for (const open of opens) {
        open.kill();
      }
    }
  });

  it('requires a deck file or --all for stop', async () => {
    const workspace = await createCliWorkspace();

    const result = await runCliProcess(['stop'], {
      cwd: workspace.cwd,
      env: cliEnvironment(workspace)
    });

    expect(result.code).toBe(1);
    expect(result.stderr).toContain('Specify a deck file to stop or pass --all.');
  });

  it('rejects stop with both a deck file and --all', async () => {
    const workspace = await createCliWorkspace();
    await copyFixture('basic.deck.html', workspace.cwd);

    const result = await runCliProcess(
      ['stop', 'basic.deck.html', '--all'],
      { cwd: workspace.cwd, env: cliEnvironment(workspace) }
    );

    expect(result.code).toBe(1);
    expect(result.stderr).toContain(
      'Pass either a deck file or --all, not both.'
    );
  });

  it('starts a new host after removing a stale dead entry', async () => {
    const workspace = await createCliWorkspace();
    await copyFixture('basic.deck.html', workspace.cwd);
    const deckPath = join(workspace.cwd, 'basic.deck.html');
    await writeStaleSession(workspace, deckPath, {
      pid: await exitedPid(),
      port: await closedPort()
    });
    const open = new CliProcess(['open', 'basic.deck.html', '--no-browser'], {
      cwd: workspace.cwd,
      env: cliEnvironment(workspace)
    });

    try {
      const match = await open.waitForOutput(/HTMLPPT_URL=(\S+)\r?\n/);
      const url = new URL(match[1]);
      expect(url.hostname).toBe('127.0.0.1');
      const pid = open.child.pid;
      if (pid === undefined) {
        throw new Error('The CLI process did not expose a pid.');
      }
      const entry = JSON.parse(
        await readFile(sessionFilePath(workspace, deckPath), 'utf8')
      ) as { pid: number; port: number; token: string };
      expect(entry.pid).toBe(pid);
      expect(entry.port).toBe(Number(url.port));
      expect(entry.token).toBe(url.searchParams.get('token'));
      expect(await sessionCount(workspace)).toBe(1);
    } finally {
      open.kill();
    }
  });

  it('refuses to orphan a busy host that fails the health check', async () => {
    const workspace = await createCliWorkspace();
    await copyFixture('basic.deck.html', workspace.cwd);
    const deckPath = join(workspace.cwd, 'basic.deck.html');
    const keepalive = await spawnKeepalive();
    const pid = keepalive.pid;
    if (pid === undefined) {
      throw new Error('The keepalive process did not expose a pid.');
    }
    const silent = await silentHost();
    let open: CliProcess | undefined;

    try {
      const raw = await writeStaleSession(workspace, deckPath, {
        pid,
        port: silent.port
      });
      open = new CliProcess(['open', 'basic.deck.html', '--no-browser'], {
        cwd: workspace.cwd,
        env: cliEnvironment(workspace)
      });

      const code = await open.waitForExit(10_000);

      expect(code).toBe(1);
      expect(open.stderr).toContain(
        'appears to be running but is not responding'
      );
      expect(open.stderr).toContain('htmlppt stop');
      expect(open.stdout).not.toContain('HTMLPPT_URL=');
      expect(await readFile(sessionFilePath(workspace, deckPath), 'utf8')).toBe(
        raw
      );
      expect(await sessionCount(workspace)).toBe(1);
      expect(() => process.kill(pid, 0)).not.toThrow();
    } finally {
      open?.kill();
      await silent.close();
      if (keepalive.exitCode === null && keepalive.signalCode === null) {
        keepalive.kill('SIGKILL');
      }
    }
  });

  it('refuses a busy host registered under an alias spelling', async () => {
    const workspace = await createCliWorkspace();
    await copyFixture('basic.deck.html', workspace.cwd);
    const aliasDir = join(workspace.cwd, 'basic-alias');
    await symlink(
      workspace.cwd,
      aliasDir,
      process.platform === 'win32' ? 'junction' : 'dir'
    );
    const keepalive = await spawnKeepalive();
    const pid = keepalive.pid;
    if (pid === undefined) {
      throw new Error('The keepalive process did not expose a pid.');
    }
    const silent = await silentHost();
    let open: CliProcess | undefined;

    try {
      const raw = await writeStaleSession(
        workspace,
        join(aliasDir, 'basic.deck.html'),
        { pid, port: silent.port }
      );
      open = new CliProcess(['open', 'basic.deck.html', '--no-browser'], {
        cwd: workspace.cwd,
        env: cliEnvironment(workspace)
      });

      const code = await open.waitForExit(10_000);

      expect(code).toBe(1);
      expect(open.stderr).toContain(
        'appears to be running but is not responding'
      );
      expect(open.stderr).toContain('htmlppt stop');
      expect(open.stdout).not.toContain('HTMLPPT_URL=');
      expect(
        await readFile(
          sessionFilePath(workspace, join(aliasDir, 'basic.deck.html')),
          'utf8'
        )
      ).toBe(raw);
      expect(await sessionCount(workspace)).toBe(1);
      expect(() => process.kill(pid, 0)).not.toThrow();
    } finally {
      open?.kill();
      await silent.close();
      if (keepalive.exitCode === null && keepalive.signalCode === null) {
        keepalive.kill('SIGKILL');
      }
    }
  });

  it('treats a definitively stale --all entry as success', async () => {
    const workspace = await createCliWorkspace();
    const liveDir = join(workspace.cwd, 'live');
    const staleDir = join(workspace.cwd, 'stale');
    await mkdir(liveDir, { recursive: true });
    await mkdir(staleDir, { recursive: true });
    const liveDeck = await copyFixture('basic.deck.html', liveDir);
    const staleDeck = await copyFixture('basic.deck.html', staleDir);
    const keepalive = await spawnKeepalive();
    const pid = keepalive.pid;
    if (pid === undefined) {
      throw new Error('The keepalive process did not expose a pid.');
    }
    const open = new CliProcess(['open', 'live/basic.deck.html', '--no-browser'], {
      cwd: workspace.cwd,
      env: cliEnvironment(workspace)
    });
    let stop: CliProcess | undefined;

    try {
      await open.waitForOutput(/HTMLPPT_URL=(\S+)\r?\n/);
      await writeStaleSession(workspace, staleDeck, {
        pid,
        port: await closedPort()
      });

      stop = new CliProcess(['stop', '--all'], {
        cwd: workspace.cwd,
        env: cliEnvironment(workspace)
      });
      stop.child.stdin.end();
      const [stopCode] = await Promise.all([
        stop.waitForExit(15_000),
        open.waitForExit(5_000)
      ]);

      expect(stopCode).toBe(0);
      expect(stop.stdout).toContain('Stopped editor');
      expect(stop.stdout).toContain('Removed stale editor session');
      await expect(
        readFile(sessionFilePath(workspace, liveDeck), 'utf8')
      ).rejects.toMatchObject({ code: 'ENOENT' });
      await expect(
        readFile(sessionFilePath(workspace, staleDeck), 'utf8')
      ).rejects.toMatchObject({ code: 'ENOENT' });
      expect(() => process.kill(pid, 0)).not.toThrow();
    } finally {
      open.kill();
      stop?.kill();
      if (keepalive.exitCode === null && keepalive.signalCode === null) {
        keepalive.kill('SIGKILL');
      }
    }
  });

  it('treats a stale-only --all as success', async () => {
    const workspace = await createCliWorkspace();
    await copyFixture('basic.deck.html', workspace.cwd);
    const deckPath = join(workspace.cwd, 'basic.deck.html');
    const keepalive = await spawnKeepalive();
    const pid = keepalive.pid;
    if (pid === undefined) {
      throw new Error('The keepalive process did not expose a pid.');
    }

    try {
      await writeStaleSession(workspace, deckPath, {
        pid,
        port: await closedPort()
      });

      const result = await runCliProcess(['stop', '--all'], {
        cwd: workspace.cwd,
        env: cliEnvironment(workspace)
      });

      expect(result.code).toBe(0);
      expect(result.stdout).toContain('Removed stale editor session');
      expect(await sessionCount(workspace)).toBe(0);
      expect(() => process.kill(pid, 0)).not.toThrow();
    } finally {
      if (keepalive.exitCode === null && keepalive.signalCode === null) {
        keepalive.kill('SIGKILL');
      }
    }
  });

  it('cleans a dead-pid registry entry with --all and exits 0', async () => {
    const workspace = await createCliWorkspace();
    await copyFixture('basic.deck.html', workspace.cwd);
    const deckPath = join(workspace.cwd, 'basic.deck.html');
    await writeStaleSession(workspace, deckPath, {
      pid: await exitedPid(),
      port: await closedPort()
    });

    const result = await runCliProcess(['stop', '--all'], {
      cwd: workspace.cwd,
      env: cliEnvironment(workspace)
    });

    expect(result.code).toBe(0);
    expect(result.stdout).toContain('Removed 1 stale editor session(s).');
    expect(result.stderr).not.toContain('No live editor sessions.');
    await expect(
      readFile(sessionFilePath(workspace, deckPath), 'utf8')
    ).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await sessionCount(workspace)).toBe(0);
  });

  it('never kills a registered pid when the host fails the health check', async () => {
    const workspace = await createCliWorkspace();
    await copyFixture('basic.deck.html', workspace.cwd);
    const deckPath = join(workspace.cwd, 'basic.deck.html');
    const unrelated = await spawnKeepalive();
    const pid = unrelated.pid;
    if (pid === undefined) {
      throw new Error('The keepalive process did not expose a pid.');
    }

    try {
      const sessionsDirectory = join(workspace.home, 'sessions');
      await mkdir(sessionsDirectory, { recursive: true });
      await writeFile(
        sessionFilePath(workspace, deckPath),
        `${JSON.stringify(
          {
            path: deckPath,
            port: await closedPort(),
            token: 'stale-token',
            pid,
            startedAt: new Date().toISOString(),
            revision: 'a'.repeat(64)
          },
          null,
          2
        )}\n`,
        'utf8'
      );

      const result = await runCliProcess(['stop', 'basic.deck.html'], {
        cwd: workspace.cwd,
        env: cliEnvironment(workspace)
      });

      expect(result.code).toBe(1);
      expect(result.stderr).toContain('No live editor session');
      expect(() => process.kill(pid, 0)).not.toThrow();
    } finally {
      if (unrelated.exitCode === null && unrelated.signalCode === null) {
        unrelated.kill('SIGKILL');
      }
    }
  });

  it('prints a JSON outline that matches the fixture golden', async () => {
    const workspace = await createCliWorkspace();
    await copyFixture('basic.deck.html', workspace.cwd);

    const result = await runCliProcess(
      ['outline', 'basic.deck.html', '--json'],
      { cwd: workspace.cwd, env: cliEnvironment(workspace) }
    );

    expect(result.code).toBe(0);
    const expected = JSON.parse(
      await readFile(join(fixturesDir, 'basic.outline.expected.json'), 'utf8')
    );
    expect(JSON.parse(result.stdout.trim())).toEqual(expected);
  });

  it('prints a human-readable outline', async () => {
    const workspace = await createCliWorkspace();
    await copyFixture('basic.deck.html', workspace.cwd);

    const result = await runCliProcess(['outline', 'basic.deck.html'], {
      cwd: workspace.cwd,
      env: cliEnvironment(workspace)
    });

    expect(result.code).toBe(0);
    expect(result.stdout).toContain('Basic deck (1600x900, 2 slides)');
    expect(result.stdout).toContain('s1: 2 elements');
    expect(result.stdout).toContain('e1 <h1> Basic deck');
    expect(result.stdout).toContain('s2: 1 element');
  });

  it('reports a missing outline deck with an actionable error', async () => {
    const workspace = await createCliWorkspace();

    const result = await runCliProcess(
      ['outline', 'missing.deck.html', '--json'],
      { cwd: workspace.cwd, env: cliEnvironment(workspace) }
    );

    expect(result.code).toBe(1);
    expect(result.stderr).toContain(
      'Deck file not found: missing.deck.html.'
    );
  });

  it('shows mcp help and serves the stdio handshake', async () => {
    const workspace = await createCliWorkspace();

    const help = await runCliProcess(['mcp', '--help'], {
      cwd: workspace.cwd,
      env: cliEnvironment(workspace)
    });
    expect(help.code).toBe(0);
    expect(help.stdout).toContain('Usage: htmlppt mcp');
    expect(help.stdout).toContain('MCP');

    const server = new CliProcess(['mcp'], {
      cwd: workspace.cwd,
      env: cliEnvironment(workspace)
    });
    try {
      server.child.stdin.write(
        `${JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'initialize',
          params: {
            protocolVersion: '2024-11-05',
            capabilities: {},
            clientInfo: { name: 'htmlppt-cli-test', version: '0.0.0' }
          }
        })}\n`
      );
      const response = await server.waitForJsonRpc(1);
      expect(response.result).toMatchObject({
        serverInfo: { name: 'htmlppt', version: '0.0.0' }
      });
      server.child.stdin.end();
      expect(await server.waitForExit(10_000)).toBe(0);
    } finally {
      server.kill();
    }
  });

  it('exports a deck whose name contains shell metacharacters', async () => {
    const workspace = await createCliWorkspace();
    const name =
      'deck 幻灯片;touch marker.txt;& copy nul marker.txt.html';
    await runCli(['new', name], { cwd: workspace.cwd, ...capture().io });

    const result = await runCliProcess(
      ['export', name, '--format', 'html', '--out', 'exported.html'],
      { cwd: workspace.cwd, env: cliEnvironment(workspace) }
    );

    expect(result.code).toBe(0);
    expect(result.stderr).toBe('');
    expect(await readFile(join(workspace.cwd, 'exported.html'), 'utf8'))
      .toContain('Untitled deck');
    // The argument array is passed literally: no injected command ran.
    for (const marker of ['marker.txt', 'marker.txt.html']) {
      await expect(
        readFile(join(workspace.cwd, marker))
      ).rejects.toMatchObject({ code: 'ENOENT' });
    }
  });
});
