import {
  spawn,
  type ChildProcess,
  type ChildProcessWithoutNullStreams
} from 'node:child_process';
import {
  chmod,
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  symlink,
  writeFile
} from 'node:fs/promises';
import { createServer as createHttpServer } from 'node:http';
import { createServer, type Socket } from 'node:net';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { canonicalDeckPath, sessionKey } from '@htmlppt/host';
import {
  allocateLanePort,
  bindToLanePort,
  copyFixture,
  ensureBuiltWorkspaces,
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

/** The store canonicalizes keys; tests must read the same file the CLI writes. */
async function credentialFilePath(
  workspace: CliWorkspace,
  deckPath: string
): Promise<string> {
  return join(
    workspace.home,
    'decks',
    `${sessionKey(await canonicalDeckPath(deckPath))}.json`
  );
}

/**
 * Seeds a credential without touching the host module, whose store reads the
 * test runner's own `HTMLPPT_HOME` rather than the workspace one.
 */
async function writeStoredCredential(
  workspace: CliWorkspace,
  deckPath: string,
  credential: {
    token: string;
    port: number;
    createdAt: string;
    updatedAt: string;
  }
): Promise<string> {
  const filePath = await credentialFilePath(workspace, deckPath);
  await mkdir(join(workspace.home, 'decks'), { recursive: true });
  await writeFile(filePath, `${JSON.stringify(credential, null, 2)}\n`, {
    encoding: 'utf8',
    mode: 0o600
  });
  return filePath;
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
  // A lane-scoped port, so a peer suite running concurrently can neither be
  // handed this number by the OS dynamic range nor claim it first.
  return allocateLanePort();
}

interface BrieflyHeldPort {
  port: number;
  release: () => Promise<void>;
}

/**
 * Holds a port and gives it back a short moment after the first health probe.
 * That probe is the last request `open` sends before it binds the recorded
 * port, so the first bind is refused while the address is already free inside
 * the retry window. The 401 is a definitive rejection, so the registered entry
 * is pruned instead of being reported as a live host.
 */
async function brieflyHeldPort(
  releaseDelayMs: number
): Promise<BrieflyHeldPort> {
  const sockets = new Set<Socket>();
  let closing: Promise<void> | null = null;
  let releaseTimer: NodeJS.Timeout | undefined;
  const server = createHttpServer((_request, response) => {
    response.writeHead(401, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ error: 'unauthorized' }));
    if (releaseTimer === undefined) {
      releaseTimer = setTimeout(() => {
        void release();
      }, releaseDelayMs);
    }
  });
  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
  });
  await bindToLanePort(server);
  const address = server.address();
  if (!address || typeof address === 'string') {
    throw new Error('The held port did not expose a TCP port.');
  }

  function release(): Promise<void> {
    if (closing !== null) {
      return closing;
    }
    if (releaseTimer !== undefined) {
      clearTimeout(releaseTimer);
      releaseTimer = undefined;
    }
    for (const socket of sockets) {
      socket.destroy();
    }
    closing = new Promise<void>((resolve) => server.close(() => resolve()));
    return closing;
  }

  return { port: address.port, release };
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

interface StubbornHost {
  pid: number;
  port: number;
  kill: () => void;
}

/**
 * A live host that answers the token-authenticated health check, serves the
 * editor shell, but ignores SIGTERM, so `stop` reaches its five second timeout
 * with the process still running. Windows cannot ignore SIGTERM (the signal
 * terminates the process), so callers gate this helper on POSIX.
 */
async function stubbornHost(): Promise<StubbornHost> {
  const script = `
    const http = require('node:http');
    const server = http.createServer((request, response) => {
      if (
        request.url === '/api/health' &&
        request.headers.authorization === 'Bearer stale-token'
      ) {
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ ok: true }));
        return;
      }
      if (request.url.startsWith('/') && !request.url.startsWith('/api/')) {
        response.writeHead(200, { 'content-type': 'text/html' });
        response.end('<div id="root">stub editor</div>');
        return;
      }
      response.writeHead(404);
      response.end();
    });
    process.on('SIGTERM', () => undefined);
    server.listen(0, '127.0.0.1', () => {
      process.stdout.write('PORT=' + server.address().port + '\\n');
    });
  `;
  const child = spawn(process.execPath, ['-e', script], {
    stdio: ['ignore', 'pipe', 'ignore']
  });
  const pid = child.pid;
  if (pid === undefined) {
    throw new Error('The stubborn host did not expose a pid.');
  }
  child.stdout?.setEncoding('utf8');
  const port = await new Promise<number>((resolve, reject) => {
    let buffer = '';
    child.stdout?.on('data', (chunk: string) => {
      buffer += chunk;
      const match = /PORT=(\d+)\r?\n/.exec(buffer);
      if (match && match[1] !== undefined) {
        resolve(Number(match[1]));
      }
    });
    child.once('error', reject);
    child.once('exit', (code) => {
      reject(new Error(`The stubborn host exited early with code ${code}.`));
    });
  });
  return { pid, port, kill: () => child.kill('SIGKILL') };
}

interface BrokenShellHost {
  pid: number;
  port: number;
  kill: () => void;
}

/**
 * A live host that answers the token-authenticated health check for its deck
 * but answers the editor shell with a server error, like a host whose build
 * was moved or deleted after it started. The process exits on SIGTERM, so
 * `stop` can prove it reached the pid that health recorded.
 */
async function brokenShellHost(): Promise<BrokenShellHost> {
  const script = `
    const http = require('node:http');
    const server = http.createServer((request, response) => {
      if (
        request.url === '/api/health' &&
        request.headers.authorization === 'Bearer stale-token'
      ) {
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ ok: true }));
        return;
      }
      response.writeHead(500, { 'content-type': 'text/plain' });
      response.end('editor build missing');
    });
    server.listen(0, '127.0.0.1', () => {
      process.stdout.write('PORT=' + server.address().port + '\\n');
    });
  `;
  const child = spawn(process.execPath, ['-e', script], {
    stdio: ['ignore', 'pipe', 'ignore']
  });
  const pid = child.pid;
  if (pid === undefined) {
    throw new Error('The broken-shell host did not expose a pid.');
  }
  child.stdout?.setEncoding('utf8');
  const port = await new Promise<number>((resolve, reject) => {
    let buffer = '';
    child.stdout?.on('data', (chunk: string) => {
      buffer += chunk;
      const match = /PORT=(\d+)\r?\n/.exec(buffer);
      if (match && match[1] !== undefined) {
        resolve(Number(match[1]));
      }
    });
    child.once('error', reject);
    child.once('exit', (code) => {
      reject(new Error(`The broken-shell host exited early with code ${code}.`));
    });
  });
  return { pid, port, kill: () => child.kill('SIGKILL') };
}

type ScriptedProbe = 'stale-build' | 'unknown' | 'unhealthy' | 'healthy';

interface ScriptedHost {
  pid: number;
  port: number;
  kill: () => void;
}

/**
 * A live host whose editor-shell verdict is scripted per health probe. The nth
 * `/api/health` request uses `probes[n - 1]`; later probes repeat the last
 * entry. `stale-build` answers health but fails the shell, `unknown` answers
 * health with a 5xx like a busy host, `unhealthy` answers health with a 401
 * like a revoked token, and `healthy` serves the editor root.
 * The process exits on SIGTERM, so a test can prove `open` never signalled it
 * by checking that the pid is still alive.
 */
async function scriptedHost(probes: ScriptedProbe[]): Promise<ScriptedHost> {
  if (probes.length === 0) {
    throw new Error('A scripted host needs at least one probe verdict.');
  }
  const script = `
    const http = require('node:http');
    const probes = ${JSON.stringify(probes)};
    let count = 0;
    const verdictFor = (index) => probes[Math.min(index, probes.length - 1)];
    const server = http.createServer((request, response) => {
      if (request.url === '/probes') {
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ count }));
        return;
      }
      if (
        request.url === '/api/health' &&
        request.headers.authorization === 'Bearer stale-token'
      ) {
        const verdict = verdictFor(count);
        count += 1;
        if (verdict === 'unknown') {
          response.writeHead(500, { 'content-type': 'text/plain' });
          response.end('busy');
          return;
        }
        if (verdict === 'unhealthy') {
          response.writeHead(401, { 'content-type': 'application/json' });
          response.end(JSON.stringify({ error: 'unauthorized' }));
          return;
        }
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ ok: true }));
        return;
      }
      if (request.url.startsWith('/') && !request.url.startsWith('/api/')) {
        if (verdictFor(Math.max(0, count - 1)) === 'healthy') {
          response.writeHead(200, { 'content-type': 'text/html' });
          response.end('<div id="root">scripted editor</div>');
          return;
        }
        response.writeHead(500, { 'content-type': 'text/plain' });
        response.end('editor build missing');
        return;
      }
      response.writeHead(404);
      response.end();
    });
    server.listen(0, '127.0.0.1', () => {
      process.stdout.write('PORT=' + server.address().port + '\\n');
    });
  `;
  const child = spawn(process.execPath, ['-e', script], {
    stdio: ['ignore', 'pipe', 'ignore']
  });
  const pid = child.pid;
  if (pid === undefined) {
    throw new Error('The scripted host did not expose a pid.');
  }
  child.stdout?.setEncoding('utf8');
  const port = await new Promise<number>((resolve, reject) => {
    let buffer = '';
    child.stdout?.on('data', (chunk: string) => {
      buffer += chunk;
      const match = /PORT=(\d+)\r?\n/.exec(buffer);
      if (match && match[1] !== undefined) {
        resolve(Number(match[1]));
      }
    });
    child.once('error', reject);
    child.once('exit', (code) => {
      reject(new Error(`The scripted host exited early with code ${code}.`));
    });
  });
  return { pid, port, kill: () => child.kill('SIGKILL') };
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
    await ensureBuiltWorkspaces();
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
        createdAt: string;
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
        createdAt: string;
      };
      expect(after.port).toBe(before.port);
      expect(after.port).toBe(Number(url.port));
      expect(after.token).not.toBe(before.token);
      expect(after.token.length).toBeGreaterThan(0);
      // Rotation replaces the secret, not the deck's credential history.
      expect(after.createdAt).toBe(before.createdAt);
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
      expect(stop.stderr).toContain('Could not rotate the credential');
      // The sentinel is a directory, so the discard fails too and the warning
      // must say so instead of claiming the old token is gone, and it must
      // name the canonical credential file a user has to delete.
      expect(stop.stderr).toContain('could not be removed');
      expect(stop.stderr).toContain(credentialPath);
      await open.waitForExit(10_000);
      await expect(
        readFile(sessionFilePath(workspace, deckPath), 'utf8')
      ).rejects.toMatchObject({ code: 'ENOENT' });
    } finally {
      open.kill();
      await rm(credentialPath, { recursive: true, force: true });
    }
  });

  it.runIf(process.platform === 'win32')(
    'discards the stored credential when the rotated token cannot be written',
    async (context) => {
      const workspace = await createCliWorkspace();
      await copyFixture('basic.deck.html', workspace.cwd);
      const deckPath = join(workspace.cwd, 'basic.deck.html');
      const credentialPath = await credentialFilePath(workspace, deckPath);
      const open = new CliProcess(['open', 'basic.deck.html', '--no-browser'], {
        cwd: workspace.cwd,
        env: cliEnvironment(workspace)
      });
      let reopened: CliProcess | undefined;

      try {
        const match = await open.waitForOutput(/HTMLPPT_URL=(\S+)\r?\n/);
        const url = new URL(match[1]);
        const original = await readFile(credentialPath, 'utf8');
        const before = JSON.parse(original) as {
          token: string;
          port: number;
          createdAt: string;
        };
        expect(before.token).toBe(url.searchParams.get('token'));

        // A read-only credential file rejects the atomic rename while leaving
        // the recorded token readable: the realistic write-only failure. Prove
        // the injection fails the replacement before relying on it; a
        // filesystem that replaces read-only files cannot reproduce it.
        await chmod(credentialPath, 0o444);
        const temporary = `${credentialPath}.injection.tmp`;
        await writeFile(temporary, '{"token":"injected-token"}\n', 'utf8');
        let replaced = true;
        try {
          await rename(temporary, credentialPath);
        } catch {
          replaced = false;
        }
        if (replaced) {
          await chmod(credentialPath, 0o600);
          await writeFile(credentialPath, original, 'utf8');
          await rm(temporary, { force: true });
          context.skip(
            'This filesystem lets a rename replace a read-only file, so the write failure cannot be injected.'
          );
          return;
        }
        await rm(temporary, { force: true });
        expect(
          (
            JSON.parse(await readFile(credentialPath, 'utf8')) as {
              token: string;
            }
          ).token
        ).toBe(before.token);

        const stop = await runCliProcess(['stop', 'basic.deck.html'], {
          cwd: workspace.cwd,
          env: cliEnvironment(workspace)
        });

        expect(stop.code).toBe(0);
        expect(stop.stdout).toContain('Stopped editor');
        expect(stop.stderr).toContain('Could not rotate the credential');
        expect(stop.stderr).toContain('stored token was discarded');
        await open.waitForExit(10_000);
        // The warning is literally true: the token the dead host no longer
        // serves is gone instead of staying readable on disk.
        await expect(readFile(credentialPath, 'utf8')).rejects.toMatchObject({
          code: 'ENOENT'
        });

        reopened = new CliProcess(['open', 'basic.deck.html', '--no-browser'], {
          cwd: workspace.cwd,
          env: cliEnvironment(workspace)
        });
        const reopenedMatch = await reopened.waitForOutput(
          /HTMLPPT_URL=(\S+)\r?\n/
        );
        const reopenedUrl = new URL(reopenedMatch[1]);
        expect(reopenedUrl.searchParams.get('token')).not.toBe(before.token);
        expect(
          JSON.parse(await readFile(credentialPath, 'utf8'))
        ).toMatchObject({
          token: reopenedUrl.searchParams.get('token'),
          port: Number(reopenedUrl.port)
        });
      } finally {
        open.kill();
        reopened?.kill();
        await chmod(credentialPath, 0o600).catch(() => undefined);
      }
    }
  );

  it.skipIf(process.platform === 'win32')(
    'leaves the credential untouched when the host does not stop in time',
    async () => {
      const workspace = await createCliWorkspace();
      await copyFixture('basic.deck.html', workspace.cwd);
      const deckPath = join(workspace.cwd, 'basic.deck.html');
      const persistedAt = '2026-10-25T00:00:00.000Z';
      const host = await stubbornHost();

      try {
        await writeStaleSession(workspace, deckPath, {
          pid: host.pid,
          port: host.port
        });
        await writeStoredCredential(workspace, deckPath, {
          token: 'stale-token',
          port: host.port,
          createdAt: persistedAt,
          updatedAt: persistedAt
        });

        const stop = await runCliProcess(
          ['stop', 'basic.deck.html'],
          { cwd: workspace.cwd, env: cliEnvironment(workspace) },
          20_000
        );

        expect(stop.code).toBe(1);
        expect(stop.stderr).toContain('did not stop within 5 seconds');
        // Rotation belongs after the exit check: a failed stop must leave the
        // identity of the still-running host alone and stay silent about it.
        expect(stop.stderr).not.toContain('Could not rotate the credential');
        expect(
          JSON.parse(
            await readFile(
              await credentialFilePath(workspace, deckPath),
              'utf8'
            )
          )
        ).toEqual({
          token: 'stale-token',
          port: host.port,
          createdAt: persistedAt,
          updatedAt: persistedAt
        });
        // The registry entry survives too, so the retry can still find it.
        expect(
          await readFile(sessionFilePath(workspace, deckPath), 'utf8')
        ).toContain('stale-token');
      } finally {
        host.kill();
      }
    }
  );

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

  it('replaces a stale credential with the live host identity', async () => {
    const workspace = await createCliWorkspace();
    await copyFixture('basic.deck.html', workspace.cwd);
    const deckPath = join(workspace.cwd, 'basic.deck.html');
    const first = new CliProcess(['open', 'basic.deck.html', '--no-browser'], {
      cwd: workspace.cwd,
      env: cliEnvironment(workspace)
    });
    let adopted: CliProcess | undefined;
    let reopened: CliProcess | undefined;

    try {
      const firstMatch = await first.waitForOutput(/HTMLPPT_URL=(\S+)\r?\n/);
      const liveUrl = new URL(firstMatch[1]);
      const credentialPath = await credentialFilePath(workspace, deckPath);
      const seededAt = '2026-10-01T00:00:00.000Z';
      // A credential left by an older incarnation whose host is gone. The
      // live host is still answering on a different identity.
      await writeStoredCredential(workspace, deckPath, {
        token: 'stale-token',
        port: await closedPort(),
        createdAt: seededAt,
        updatedAt: seededAt
      });

      adopted = new CliProcess(['open', 'basic.deck.html', '--no-browser'], {
        cwd: workspace.cwd,
        env: cliEnvironment(workspace)
      });
      const adoptedMatch = await adopted.waitForOutput(
        /HTMLPPT_URL=(\S+)\r?\n/
      );
      expect(adoptedMatch[1]).toBe(liveUrl.href);
      expect(await adopted.waitForExit(10_000)).toBe(0);
      const rewritten = JSON.parse(
        await readFile(credentialPath, 'utf8')
      ) as { token: string; port: number; createdAt: string; updatedAt: string };
      expect(rewritten.token).toBe(liveUrl.searchParams.get('token'));
      expect(rewritten.port).toBe(Number(liveUrl.port));
      // Adoption keeps the credential's history but refreshes the timestamp.
      expect(rewritten.createdAt).toBe(seededAt);
      expect(rewritten.updatedAt).not.toBe(seededAt);

      // Crash without stop. The next open must start where the live host
      // actually was, not on the stale identity the old code kept.
      const exited = new Promise<void>((resolve) => {
        first.child.once('close', () => resolve());
      });
      first.kill();
      await exited;

      reopened = new CliProcess(['open', 'basic.deck.html', '--no-browser'], {
        cwd: workspace.cwd,
        env: cliEnvironment(workspace)
      });
      const reopenedMatch = await reopened.waitForOutput(
        /HTMLPPT_URL=(\S+)\r?\n/
      );
      const reopenedUrl = new URL(reopenedMatch[1]);
      expect(reopenedUrl.searchParams.get('token')).toBe(
        liveUrl.searchParams.get('token')
      );
      expect(reopenedUrl.port).toBe(liveUrl.port);
    } finally {
      first.kill();
      adopted?.kill();
      reopened?.kill();
    }
  });

  it('moves the credential to the switched deck and clears the old one', async () => {
    const workspace = await createCliWorkspace();
    const firstDir = join(workspace.cwd, 'one');
    const secondDir = join(workspace.cwd, 'two');
    await mkdir(firstDir, { recursive: true });
    await mkdir(secondDir, { recursive: true });
    const firstDeck = await copyFixture('basic.deck.html', firstDir);
    const secondDeck = await copyFixture('basic.deck.html', secondDir);
    const open = new CliProcess(
      ['open', join('one', 'basic.deck.html'), '--no-browser'],
      { cwd: workspace.cwd, env: cliEnvironment(workspace) }
    );
    let reopened: CliProcess | undefined;

    try {
      const match = await open.waitForOutput(/HTMLPPT_URL=(\S+)\r?\n/);
      const liveUrl = new URL(match[1]);
      const firstCredentialPath = await credentialFilePath(
        workspace,
        firstDeck
      );
      const firstCredential = JSON.parse(
        await readFile(firstCredentialPath, 'utf8')
      ) as { token: string; port: number; createdAt: string };
      expect(firstCredential.token).toBe(liveUrl.searchParams.get('token'));

      const token = liveUrl.searchParams.get('token');
      const response = await fetch(
        `http://127.0.0.1:${liveUrl.port}/api/open`,
        {
          method: 'POST',
          headers: {
            authorization: `Bearer ${token}`,
            'content-type': 'application/json'
          },
          body: JSON.stringify({ path: secondDeck })
        }
      );
      expect(response.status).toBe(200);

      // The host kept its token and port, so the deck it now serves owns
      // that identity; the previous deck must lose it.
      const secondCredentialPath = await credentialFilePath(
        workspace,
        secondDeck
      );
      const secondCredential = JSON.parse(
        await readFile(secondCredentialPath, 'utf8')
      ) as { token: string; port: number; createdAt: string };
      expect(secondCredential.token).toBe(token);
      expect(secondCredential.port).toBe(Number(liveUrl.port));
      const staleFirst = await readFile(firstCredentialPath, 'utf8').catch(
        () => null
      );
      if (staleFirst !== null) {
        expect(
          (JSON.parse(staleFirst) as { token: string }).token
        ).not.toBe(token);
      }

      reopened = new CliProcess(
        ['open', join('one', 'basic.deck.html'), '--no-browser'],
        { cwd: workspace.cwd, env: cliEnvironment(workspace) }
      );
      const reopenedMatch = await reopened.waitForOutput(
        /HTMLPPT_URL=(\S+)\r?\n/
      );
      const reopenedUrl = new URL(reopenedMatch[1]);
      expect(reopenedUrl.searchParams.get('token')).not.toBe(token);
      const reopenedCredential = JSON.parse(
        await readFile(firstCredentialPath, 'utf8')
      ) as { token: string };

      const stop = await runCliProcess(
        ['stop', join('two', 'basic.deck.html')],
        { cwd: workspace.cwd, env: cliEnvironment(workspace) }
      );
      expect(stop.code).toBe(0);

      const rotatedSecond = JSON.parse(
        await readFile(secondCredentialPath, 'utf8')
      ) as { token: string; port: number; createdAt: string };
      expect(rotatedSecond.token).not.toBe(token);
      expect(rotatedSecond.port).toBe(Number(liveUrl.port));
      expect(rotatedSecond.createdAt).toBe(secondCredential.createdAt);
      // stop two must not rotate the deck that is now served by another host.
      expect(
        (
          JSON.parse(await readFile(firstCredentialPath, 'utf8')) as {
            token: string;
          }
        ).token
      ).toBe(reopenedCredential.token);
    } finally {
      open.kill();
      reopened?.kill();
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

  it('retries a briefly held recorded port instead of falling back', async () => {
    const workspace = await createCliWorkspace();
    await copyFixture('basic.deck.html', workspace.cwd);
    const deckPath = join(workspace.cwd, 'basic.deck.html');
    // The recorded address is the deck's bookmark. The helper answers the
    // health probe that precedes the bind and frees the port 300 ms later, so
    // the first bind is refused and a retry lands inside its own window.
    const held = await brieflyHeldPort(300);
    const persistedAt = '2026-10-01T00:00:00.000Z';
    let open: CliProcess | undefined;

    try {
      await writeStaleSession(workspace, deckPath, {
        pid: process.pid,
        port: held.port
      });
      const credentialPath = await writeStoredCredential(workspace, deckPath, {
        token: 'stale-token',
        port: held.port,
        createdAt: persistedAt,
        updatedAt: persistedAt
      });

      open = new CliProcess(['open', 'basic.deck.html', '--no-browser'], {
        cwd: workspace.cwd,
        env: cliEnvironment(workspace)
      });
      const match = await open.waitForOutput(/HTMLPPT_URL=(\S+)\r?\n/);
      const url = new URL(match[1]);

      expect(url.port).toBe(String(held.port));
      expect(open.stderr).not.toContain('is in use');
      expect(open.stderr).not.toContain('on a new port');
      expect(
        JSON.parse(await readFile(credentialPath, 'utf8'))
      ).toMatchObject({
        token: 'stale-token',
        port: held.port,
        createdAt: persistedAt
      });
    } finally {
      open?.kill();
      await held.release();
    }
  });

  it('gives an explicit --port precedence over the stored port', async () => {
    const workspace = await createCliWorkspace();
    await copyFixture('basic.deck.html', workspace.cwd);
    const deckPath = join(workspace.cwd, 'basic.deck.html');
    const storedPort = await closedPort();
    const requestedPort = await closedPort();
    const persistedAt = '2026-10-01T00:00:00.000Z';
    await writeStoredCredential(workspace, deckPath, {
      token: 'stored-token',
      port: storedPort,
      createdAt: persistedAt,
      updatedAt: persistedAt
    });
    const open = new CliProcess(
      ['open', 'basic.deck.html', '--port', String(requestedPort), '--no-browser'],
      { cwd: workspace.cwd, env: cliEnvironment(workspace) }
    );

    try {
      const match = await open.waitForOutput(/HTMLPPT_URL=(\S+)\r?\n/);
      const url = new URL(match[1]);
      expect(url.port).toBe(String(requestedPort));

      const credential = JSON.parse(
        await readFile(await credentialFilePath(workspace, deckPath), 'utf8')
      ) as { token: string; port: number; createdAt: string };
      expect(credential.port).toBe(requestedPort);
      expect(credential.token).toBe('stored-token');
      expect(credential.createdAt).toBe(persistedAt);
    } finally {
      open.kill();
    }
  });

  it('treats an explicit --port 0 as a fresh ephemeral port', async () => {
    const workspace = await createCliWorkspace();
    await copyFixture('basic.deck.html', workspace.cwd);
    const deckPath = join(workspace.cwd, 'basic.deck.html');
    // Hold the stored port so a sticky reuse would collide and warn, proving
    // the explicit `0` was not treated as "use the recorded port".
    const probe = createServer();
    await new Promise<void>((resolve, reject) => {
      probe.once('error', reject);
      probe.listen(0, '127.0.0.1', resolve);
    });
    const address = probe.address();
    if (!address || typeof address === 'string') {
      throw new Error('The probe server did not expose a TCP port.');
    }
    const storedPort = address.port;
    const persistedAt = '2026-10-01T00:00:00.000Z';
    await writeStoredCredential(workspace, deckPath, {
      token: 'stored-token',
      port: storedPort,
      createdAt: persistedAt,
      updatedAt: persistedAt
    });
    const open = new CliProcess(
      ['open', 'basic.deck.html', '--port', '0', '--no-browser'],
      { cwd: workspace.cwd, env: cliEnvironment(workspace) }
    );

    try {
      const match = await open.waitForOutput(/HTMLPPT_URL=(\S+)\r?\n/);
      const url = new URL(match[1]);
      expect(url.port).not.toBe(String(storedPort));
      expect(open.stderr).not.toContain('is in use');

      const credential = JSON.parse(
        await readFile(await credentialFilePath(workspace, deckPath), 'utf8')
      ) as { token: string; port: number; createdAt: string };
      expect(credential.port).toBe(Number(url.port));
      expect(credential.token).toBe('stored-token');
      expect(credential.createdAt).toBe(persistedAt);
    } finally {
      open.kill();
      await new Promise<void>((resolve) => probe.close(() => resolve()));
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

  it('stops a live host whose editor shell is broken', async () => {
    const workspace = await createCliWorkspace();
    await copyFixture('basic.deck.html', workspace.cwd);
    const deckPath = join(workspace.cwd, 'basic.deck.html');
    const persistedAt = '2026-10-25T00:00:00.000Z';
    const host = await brokenShellHost();

    try {
      await writeStaleSession(workspace, deckPath, {
        pid: host.pid,
        port: host.port
      });
      const credentialPath = await writeStoredCredential(workspace, deckPath, {
        token: 'stale-token',
        port: host.port,
        createdAt: persistedAt,
        updatedAt: persistedAt
      });
      // Positive control: the entry is only reachable because this pid is
      // alive and answering health.
      expect(() => process.kill(host.pid, 0)).not.toThrow();

      const stop = await runCliProcess(['stop', 'basic.deck.html'], {
        cwd: workspace.cwd,
        env: cliEnvironment(workspace)
      });

      expect(stop.code).toBe(0);
      expect(stop.stdout).toContain('Stopped editor');
      expect(stop.stderr).not.toContain('No live editor session');
      await expect(
        readFile(sessionFilePath(workspace, deckPath), 'utf8')
      ).rejects.toMatchObject({ code: 'ENOENT' });
      // A broken editor build does not make the process unreachable: the stop
      // must signal the pid health proved and never leave a live host behind.
      expect(() => process.kill(host.pid, 0)).toThrow();
      const rotated = JSON.parse(await readFile(credentialPath, 'utf8')) as {
        token: string;
        port: number;
        createdAt: string;
      };
      expect(rotated.port).toBe(host.port);
      expect(rotated.token).not.toBe('stale-token');
      expect(rotated.createdAt).toBe(persistedAt);
    } finally {
      host.kill();
    }
  });

  it('stops every broken-shell host with --all and rotates its token', async () => {
    const workspace = await createCliWorkspace();
    await copyFixture('basic.deck.html', workspace.cwd);
    const deckPath = join(workspace.cwd, 'basic.deck.html');
    const persistedAt = '2026-10-25T00:00:00.000Z';
    const host = await brokenShellHost();

    try {
      await writeStaleSession(workspace, deckPath, {
        pid: host.pid,
        port: host.port
      });
      const credentialPath = await writeStoredCredential(workspace, deckPath, {
        token: 'stale-token',
        port: host.port,
        createdAt: persistedAt,
        updatedAt: persistedAt
      });
      expect(() => process.kill(host.pid, 0)).not.toThrow();

      const stop = await runCliProcess(['stop', '--all'], {
        cwd: workspace.cwd,
        env: cliEnvironment(workspace)
      });

      expect(stop.code).toBe(0);
      expect(stop.stdout).toContain('Stopped editor');
      expect(stop.stderr).not.toContain('No live editor sessions were stopped.');
      await expect(
        readFile(sessionFilePath(workspace, deckPath), 'utf8')
      ).rejects.toMatchObject({ code: 'ENOENT' });
      expect(() => process.kill(host.pid, 0)).toThrow();
      const rotated = JSON.parse(await readFile(credentialPath, 'utf8')) as {
        token: string;
        port: number;
        createdAt: string;
      };
      expect(rotated.port).toBe(host.port);
      expect(rotated.token).not.toBe('stale-token');
      expect(rotated.createdAt).toBe(persistedAt);
    } finally {
      host.kill();
    }
  });

  it('stops a broken-shell host registered under an alias spelling', async () => {
    const workspace = await createCliWorkspace();
    await copyFixture('basic.deck.html', workspace.cwd);
    const deckPath = join(workspace.cwd, 'basic.deck.html');
    const aliasDir = join(workspace.cwd, 'alias-decks');
    await symlink(
      workspace.cwd,
      aliasDir,
      process.platform === 'win32' ? 'junction' : 'dir'
    );
    const aliasDeck = join(aliasDir, 'basic.deck.html');
    const persistedAt = '2026-10-25T00:00:00.000Z';
    const host = await brokenShellHost();

    try {
      // The live host is registered under a different spelling of the deck,
      // exactly where `open` tells the user to run `stop` for it.
      await writeStaleSession(workspace, aliasDeck, {
        pid: host.pid,
        port: host.port
      });
      const credentialPath = await writeStoredCredential(workspace, deckPath, {
        token: 'stale-token',
        port: host.port,
        createdAt: persistedAt,
        updatedAt: persistedAt
      });
      expect(() => process.kill(host.pid, 0)).not.toThrow();

      const stop = await runCliProcess(['stop', 'basic.deck.html'], {
        cwd: workspace.cwd,
        env: cliEnvironment(workspace)
      });

      expect(stop.code).toBe(0);
      expect(stop.stdout).toContain('Stopped editor');
      expect(stop.stderr).not.toContain('No live editor session');
      await expect(
        readFile(sessionFilePath(workspace, aliasDeck), 'utf8')
      ).rejects.toMatchObject({ code: 'ENOENT' });
      expect(() => process.kill(host.pid, 0)).toThrow();
      const rotated = JSON.parse(await readFile(credentialPath, 'utf8')) as {
        token: string;
        port: number;
        createdAt: string;
      };
      expect(rotated.port).toBe(host.port);
      expect(rotated.token).not.toBe('stale-token');
      expect(rotated.createdAt).toBe(persistedAt);
    } finally {
      host.kill();
    }
  });

  it('leaves an unknown session and its credential untouched', async () => {
    const workspace = await createCliWorkspace();
    await copyFixture('basic.deck.html', workspace.cwd);
    const deckPath = join(workspace.cwd, 'basic.deck.html');
    const persistedAt = '2026-10-25T00:00:00.000Z';
    const silent = await silentHost();
    const keepalive = await spawnKeepalive();
    const pid = keepalive.pid;
    if (pid === undefined) {
      throw new Error('The keepalive process did not expose a pid.');
    }

    try {
      const raw = await writeStaleSession(workspace, deckPath, {
        pid,
        port: silent.port
      });
      const credentialPath = await writeStoredCredential(workspace, deckPath, {
        token: 'stale-token',
        port: silent.port,
        createdAt: persistedAt,
        updatedAt: persistedAt
      });
      const credentialBefore = await readFile(credentialPath, 'utf8');

      const stop = await runCliProcess(['stop', 'basic.deck.html'], {
        cwd: workspace.cwd,
        env: cliEnvironment(workspace)
      });

      // A host that may merely be busy must not be signalled or rotated.
      expect(stop.code).toBe(1);
      expect(stop.stderr).toContain('Could not verify');
      expect(stop.stderr).not.toContain('Stopped editor');
      expect(await readFile(sessionFilePath(workspace, deckPath), 'utf8')).toBe(
        raw
      );
      expect(await readFile(credentialPath, 'utf8')).toBe(credentialBefore);
      expect(() => process.kill(pid, 0)).not.toThrow();
    } finally {
      await silent.close();
      if (keepalive.exitCode === null && keepalive.signalCode === null) {
        keepalive.kill('SIGKILL');
      }
    }
  });

  it('does not advise opening a deck whose unverified host is registered under an alias', async () => {
    const workspace = await createCliWorkspace();
    await copyFixture('basic.deck.html', workspace.cwd);
    const deckPath = join(workspace.cwd, 'basic.deck.html');
    const aliasDir = join(workspace.cwd, 'alias-decks');
    await symlink(
      workspace.cwd,
      aliasDir,
      process.platform === 'win32' ? 'junction' : 'dir'
    );
    const aliasDeck = join(aliasDir, 'basic.deck.html');
    const persistedAt = '2026-10-25T00:00:00.000Z';
    // A busy host answers health with a 5xx, so the caller-spelling lookup
    // finds nothing and the alias scan cannot prove an editor either.
    const host = await scriptedHost(['unknown']);

    try {
      // The live host is registered under a different spelling, exactly where
      // an earlier `open` could have recorded it.
      const raw = await writeStaleSession(workspace, aliasDeck, {
        pid: host.pid,
        port: host.port
      });
      const credentialPath = await writeStoredCredential(workspace, deckPath, {
        token: 'stale-token',
        port: host.port,
        createdAt: persistedAt,
        updatedAt: persistedAt
      });
      const credentialBefore = await readFile(credentialPath, 'utf8');

      const stop = await runCliProcess(['stop', 'basic.deck.html'], {
        cwd: workspace.cwd,
        env: cliEnvironment(workspace)
      });

      // `open` refuses while this host is registered but unverified, so advice
      // to start one is wrong. A retry is the way out: `stop --all` cannot
      // verify an `unknown` entry either and leaves it running.
      expect(stop.code).toBe(1);
      expect(stop.stderr).toContain(
        'A registered editor for this deck could not be verified'
      );
      expect(stop.stderr).toContain(
        'Retry "htmlppt stop <file>" when it responds.'
      );
      expect(stop.stderr).not.toContain('htmlppt stop --all');
      expect(stop.stderr).not.toContain('basic.deck.html');
      expect(stop.stderr).not.toContain('Start one with');
      expect(stop.stderr).not.toContain('Stopped editor');
      expect(await readFile(sessionFilePath(workspace, aliasDeck), 'utf8')).toBe(
        raw
      );
      expect(await readFile(credentialPath, 'utf8')).toBe(credentialBefore);
      expect(() => process.kill(host.pid, 0)).not.toThrow();
    } finally {
      host.kill();
    }
  });

  it('stops every live editor with --all', async () => {
    const workspace = await createCliWorkspace();
    const directories = ['one', 'two'];
    const opens: CliProcess[] = [];
    const deckPaths: string[] = [];
    const urls: URL[] = [];
    const credentialPaths: string[] = [];
    const before: { token: string; port: number; createdAt: string }[] = [];
    for (const name of directories) {
      const directory = join(workspace.cwd, name);
      await mkdir(directory, { recursive: true });
      const deckPath = await copyFixture('basic.deck.html', directory);
      deckPaths.push(deckPath);
      credentialPaths.push(await credentialFilePath(workspace, deckPath));
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
      for (const [index, credentialPath] of credentialPaths.entries()) {
        const recorded = JSON.parse(
          await readFile(credentialPath, 'utf8')
        ) as { token: string; port: number; createdAt: string };
        expect(recorded.token).toBe(urls[index]?.searchParams.get('token'));
        before.push(recorded);
      }

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
          await readFile(credentialPaths[index]!, 'utf8')
        ) as { token: string; port: number; createdAt: string };
        expect(credential.port).toBe(Number(urls[index]!.port));
        expect(typeof credential.token).toBe('string');
        expect(credential.token.length).toBeGreaterThan(0);
        expect(credential.token).not.toBe(urls[index]!.searchParams.get('token'));
        expect(credential.token).not.toBe(before[index]!.token);
        expect(credential.createdAt).toBe(before[index]!.createdAt);
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

  it('replaces a live host that no longer serves the editor', async () => {
    const workspace = await createCliWorkspace();
    await copyFixture('basic.deck.html', workspace.cwd);
    const deckPath = join(workspace.cwd, 'basic.deck.html');
    const persistedAt = '2026-10-25T00:00:00.000Z';
    const host = await brokenShellHost();
    const sessionFile = sessionFilePath(workspace, deckPath);
    let open: CliProcess | undefined;

    try {
      await writeStaleSession(workspace, deckPath, {
        pid: host.pid,
        port: host.port
      });
      const credentialPath = await writeStoredCredential(workspace, deckPath, {
        token: 'stale-token',
        port: host.port,
        createdAt: persistedAt,
        updatedAt: persistedAt
      });
      // Positive control: the registered host is alive and answers health for
      // this deck, so only the broken editor shell separates it from a reuse.
      expect(() => process.kill(host.pid, 0)).not.toThrow();

      open = new CliProcess(['open', 'basic.deck.html', '--no-browser'], {
        cwd: workspace.cwd,
        env: cliEnvironment(workspace)
      });
      const match = await open.waitForOutput(/HTMLPPT_URL=(\S+)\r?\n/);
      const url = new URL(match[1]);

      await vi.waitFor(
        () =>
          expect(open?.stderr).toContain(
            'does not serve the editor (stale build)'
          ),
        { timeout: 10_000 }
      );
      // The warning names the deck the caller asked to open, so a user can
      // tell which host is being retired.
      expect(open.stderr).toContain(
        'The editor registered for basic.deck.html is running but does not serve the editor (stale build).'
      );
      // `open` owns its stdout contract: one URL for the new host and no
      // `stop` confirmation line from the internal eviction.
      expect(open.stdout.match(/HTMLPPT_URL=/g)).toHaveLength(1);
      expect(open.stdout).not.toContain('Stopped editor');
      // The replacement keeps the deck's sticky address but starts a new host
      // with the credential the stop rotated.
      expect(url.port).toBe(String(host.port));
      expect(url.searchParams.get('token')).not.toBe('stale-token');
      expect(() => process.kill(host.pid, 0)).toThrow();
      expect(await sessionCount(workspace)).toBe(1);
      const entry = JSON.parse(await readFile(sessionFile, 'utf8')) as {
        path: string;
        pid: number;
        port: number;
        token: string;
      };
      expect(entry).toMatchObject({
        path: deckPath,
        pid: open.child.pid,
        port: host.port,
        token: url.searchParams.get('token')
      });
      // The new process and the store agree on the rotated identity; evicting
      // before reading the credential is what makes that true.
      expect(
        JSON.parse(await readFile(credentialPath, 'utf8'))
      ).toMatchObject({
        token: url.searchParams.get('token'),
        port: host.port,
        createdAt: persistedAt
      });

      const page = await fetch(
        `http://127.0.0.1:${host.port}/d/basic.deck.html`,
        {
          headers: {
            cookie: `htmlppt_token=${url.searchParams.get('token')}`
          }
        }
      );
      expect(page.status).toBe(200);
      await page.body?.cancel().catch(() => undefined);

      const stop = await runCliProcess(['stop', 'basic.deck.html'], {
        cwd: workspace.cwd,
        env: cliEnvironment(workspace)
      });
      expect(stop.code).toBe(0);
      expect(stop.stdout).toContain('Stopped editor');
      await open.waitForExit(10_000);
      await expect(readFile(sessionFile, 'utf8')).rejects.toMatchObject({
        code: 'ENOENT'
      });
      const rotated = JSON.parse(await readFile(credentialPath, 'utf8')) as {
        token: string;
        port: number;
        createdAt: string;
      };
      expect(rotated.port).toBe(host.port);
      expect(rotated.token).not.toBe(url.searchParams.get('token'));
      expect(rotated.createdAt).toBe(persistedAt);
    } finally {
      open?.kill();
      host.kill();
    }
  });

  it('reuses a host that recovers on the retry probe', async () => {
    const workspace = await createCliWorkspace();
    await copyFixture('basic.deck.html', workspace.cwd);
    const deckPath = join(workspace.cwd, 'basic.deck.html');
    // Two stale-build verdicts reach the retry; health recovers on the third.
    const host = await scriptedHost(['stale-build', 'stale-build', 'healthy']);
    let open: CliProcess | undefined;

    try {
      const raw = await writeStaleSession(workspace, deckPath, {
        pid: host.pid,
        port: host.port
      });
      open = new CliProcess(['open', 'basic.deck.html', '--no-browser'], {
        cwd: workspace.cwd,
        env: cliEnvironment(workspace)
      });
      const match = await open.waitForOutput(/HTMLPPT_URL=(\S+)\r?\n/);
      const code = await open.waitForExit(10_000);

      expect(code).toBe(0);
      // The retry proved the registered host serves the editor, so its stored
      // identity is reused instead of being replaced or refused.
      const url = new URL(match[1]);
      expect(url.port).toBe(String(host.port));
      expect(url.searchParams.get('token')).toBe('stale-token');
      expect(open.stdout.match(/HTMLPPT_URL=/g)).toHaveLength(1);
      expect(open.stderr).not.toContain('does not serve the editor');
      expect(() => process.kill(host.pid, 0)).not.toThrow();
      expect(await readFile(sessionFilePath(workspace, deckPath), 'utf8')).toBe(
        raw
      );
      expect(await sessionCount(workspace)).toBe(1);
    } finally {
      open?.kill();
      host.kill();
    }
  });

  it('probes a busy direct host twice without scanning aliases', async () => {
    const workspace = await createCliWorkspace();
    await copyFixture('basic.deck.html', workspace.cwd);
    const deckPath = join(workspace.cwd, 'basic.deck.html');
    const host = await scriptedHost(['unknown', 'unknown', 'unknown']);
    let open: CliProcess | undefined;

    try {
      await writeStaleSession(workspace, deckPath, {
        pid: host.pid,
        port: host.port
      });
      open = new CliProcess(['open', 'basic.deck.html', '--no-browser'], {
        cwd: workspace.cwd,
        env: cliEnvironment(workspace)
      });
      expect(await open.waitForExit(10_000)).toBe(1);

      // The caller's spelling has a direct entry, so the alias scan would only
      // re-probe the same busy host. One probe comes from findLiveSession and
      // one from the direct lookup in open.
      const probes = await fetch(`http://127.0.0.1:${host.port}/probes`);
      expect(await probes.json()).toEqual({ count: 2 });
    } finally {
      open?.kill();
      host.kill();
    }
  });

  it('refuses to replace a host that fails the retry health probe', async () => {
    const workspace = await createCliWorkspace();
    await copyFixture('basic.deck.html', workspace.cwd);
    const deckPath = join(workspace.cwd, 'basic.deck.html');
    // The retry answers health with a 5xx, so the broken shell is no longer
    // proven and the process must not be signalled.
    const host = await scriptedHost(['stale-build', 'stale-build', 'unknown']);
    let open: CliProcess | undefined;

    try {
      const raw = await writeStaleSession(workspace, deckPath, {
        pid: host.pid,
        port: host.port
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
      expect(open.stdout).not.toContain('HTMLPPT_URL=');
      // Positive control: the entry names a live pid, so the refusal is what
      // kept it, not a dead-process prune.
      expect(() => process.kill(host.pid, 0)).not.toThrow();
      expect(await readFile(sessionFilePath(workspace, deckPath), 'utf8')).toBe(
        raw
      );
      expect(await sessionCount(workspace)).toBe(1);
    } finally {
      open?.kill();
      host.kill();
    }
  });

  it('refuses to replace a host whose retry is rejected as unauthorized', async () => {
    const workspace = await createCliWorkspace();
    await copyFixture('basic.deck.html', workspace.cwd);
    const deckPath = join(workspace.cwd, 'basic.deck.html');
    // The retry answers health with a 401, so the process no longer proves it
    // owns this deck and must not be signalled.
    const host = await scriptedHost(['stale-build', 'stale-build', 'unhealthy']);
    let open: CliProcess | undefined;

    try {
      const raw = await writeStaleSession(workspace, deckPath, {
        pid: host.pid,
        port: host.port
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
      expect(open.stdout).not.toContain('HTMLPPT_URL=');
      // Positive control: the entry names a live pid, so the refusal is what
      // kept it, not a dead-process prune.
      expect(() => process.kill(host.pid, 0)).not.toThrow();
      expect(await readFile(sessionFilePath(workspace, deckPath), 'utf8')).toBe(
        raw
      );
      expect(await sessionCount(workspace)).toBe(1);
      // The refusal used the 401 leg: one probe from findLiveSession and one
      // from the direct lookup precede the retry.
      const probes = await fetch(`http://127.0.0.1:${host.port}/probes`);
      expect(await probes.json()).toEqual({ count: 3 });
    } finally {
      open?.kill();
      host.kill();
    }
  });

  it('replaces a stale-build host registered under an alias spelling', async () => {
    const workspace = await createCliWorkspace();
    await copyFixture('basic.deck.html', workspace.cwd);
    const deckPath = join(workspace.cwd, 'basic.deck.html');
    const aliasDir = join(workspace.cwd, 'alias-decks');
    await symlink(
      workspace.cwd,
      aliasDir,
      process.platform === 'win32' ? 'junction' : 'dir'
    );
    const aliasDeck = join(aliasDir, 'basic.deck.html');
    const persistedAt = '2026-10-25T00:00:00.000Z';
    const host = await brokenShellHost();
    let open: CliProcess | undefined;

    try {
      // The stale host is keyed by the alias spelling, exactly where an earlier
      // `open` could have recorded it.
      await writeStaleSession(workspace, aliasDeck, {
        pid: host.pid,
        port: host.port
      });
      const credentialPath = await writeStoredCredential(workspace, deckPath, {
        token: 'stale-token',
        port: host.port,
        createdAt: persistedAt,
        updatedAt: persistedAt
      });
      expect(() => process.kill(host.pid, 0)).not.toThrow();

      open = new CliProcess(['open', 'basic.deck.html', '--no-browser'], {
        cwd: workspace.cwd,
        env: cliEnvironment(workspace)
      });
      const match = await open.waitForOutput(/HTMLPPT_URL=(\S+)\r?\n/);
      const url = new URL(match[1]);

      await vi.waitFor(
        () =>
          expect(open?.stderr).toContain(
            'does not serve the editor (stale build)'
          ),
        { timeout: 10_000 }
      );
      expect(url.port).toBe(String(host.port));
      expect(url.searchParams.get('token')).not.toBe('stale-token');
      expect(() => process.kill(host.pid, 0)).toThrow();
      // The alias entry is replaced, not left behind next to the new one.
      await expect(
        readFile(sessionFilePath(workspace, aliasDeck), 'utf8')
      ).rejects.toMatchObject({ code: 'ENOENT' });
      expect(await sessionCount(workspace)).toBe(1);
      expect(
        JSON.parse(
          await readFile(sessionFilePath(workspace, deckPath), 'utf8')
        )
      ).toMatchObject({
        path: deckPath,
        pid: open.child.pid,
        port: host.port,
        token: url.searchParams.get('token')
      });
      expect(JSON.parse(await readFile(credentialPath, 'utf8'))).toMatchObject({
        token: url.searchParams.get('token'),
        port: host.port,
        createdAt: persistedAt
      });

      const stop = await runCliProcess(['stop', 'basic.deck.html'], {
        cwd: workspace.cwd,
        env: cliEnvironment(workspace)
      });
      expect(stop.code).toBe(0);
      expect(stop.stdout).toContain('Stopped editor');
      await open.waitForExit(10_000);
      const rotated = JSON.parse(await readFile(credentialPath, 'utf8')) as {
        token: string;
        port: number;
      };
      expect(rotated.port).toBe(host.port);
      expect(rotated.token).not.toBe(url.searchParams.get('token'));
    } finally {
      open?.kill();
      host.kill();
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
    const stalePort = await closedPort();
    const persistedAt = '2026-10-25T00:00:00.000Z';
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
        port: stalePort
      });
      await writeStoredCredential(workspace, staleDeck, {
        token: 'stale-token',
        port: stalePort,
        createdAt: persistedAt,
        updatedAt: persistedAt
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
      // The stale entry is cleaned without stopSession, so this branch owes
      // the deck the same rotation a normal stop performs.
      const rotated = JSON.parse(
        await readFile(await credentialFilePath(workspace, staleDeck), 'utf8')
      ) as { token: string; port: number; createdAt: string };
      expect(rotated.port).toBe(stalePort);
      expect(typeof rotated.token).toBe('string');
      expect(rotated.token.length).toBeGreaterThan(0);
      expect(rotated.token).not.toBe('stale-token');
      expect(rotated.createdAt).toBe(persistedAt);
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

  it('rotates the credential of a dead-pid entry cleaned by --all', async () => {
    const workspace = await createCliWorkspace();
    await copyFixture('basic.deck.html', workspace.cwd);
    const deckPath = join(workspace.cwd, 'basic.deck.html');
    const port = await closedPort();
    const persistedAt = '2026-10-25T00:00:00.000Z';
    await writeStaleSession(workspace, deckPath, {
      pid: await exitedPid(),
      port
    });
    const credentialPath = await credentialFilePath(workspace, deckPath);
    await writeStoredCredential(workspace, deckPath, {
      token: 'stale-token',
      port,
      createdAt: persistedAt,
      updatedAt: persistedAt
    });

    const result = await runCliProcess(['stop', '--all'], {
      cwd: workspace.cwd,
      env: cliEnvironment(workspace)
    });

    expect(result.code).toBe(0);
    expect(result.stdout).toContain('Removed 1 stale editor session(s).');
    // Cleaning a dead entry must not surface a rotation warning.
    expect(result.stderr).not.toContain('Could not rotate the credential');
    const rotated = JSON.parse(await readFile(credentialPath, 'utf8')) as {
      token: string;
      port: number;
      createdAt: string;
    };
    expect(rotated.port).toBe(port);
    expect(typeof rotated.token).toBe('string');
    expect(rotated.token.length).toBeGreaterThan(0);
    expect(rotated.token).not.toBe('stale-token');
    expect(rotated.createdAt).toBe(persistedAt);
  });

  it('rotates a dead credential in a mixed --all run', async () => {
    const workspace = await createCliWorkspace();
    const liveDir = join(workspace.cwd, 'live');
    const deadDir = join(workspace.cwd, 'dead');
    await mkdir(liveDir, { recursive: true });
    await mkdir(deadDir, { recursive: true });
    const liveDeck = await copyFixture('basic.deck.html', liveDir);
    const deadDeck = await copyFixture('basic.deck.html', deadDir);
    const deadPort = await closedPort();
    const persistedAt = '2026-10-25T00:00:00.000Z';
    const open = new CliProcess(
      ['open', join('live', 'basic.deck.html'), '--no-browser'],
      { cwd: workspace.cwd, env: cliEnvironment(workspace) }
    );
    let stop: CliProcess | undefined;

    try {
      const match = await open.waitForOutput(/HTMLPPT_URL=(\S+)\r?\n/);
      const liveUrl = new URL(match[1]);
      const liveCredentialPath = await credentialFilePath(workspace, liveDeck);
      const liveBefore = JSON.parse(
        await readFile(liveCredentialPath, 'utf8')
      ) as { token: string; port: number };

      // Seed the dead entry after open: `open` scans the registry and would
      // prune a dead entry before `stop --all` could snapshot it.
      await writeStaleSession(workspace, deadDeck, {
        pid: await exitedPid(),
        port: deadPort
      });
      await writeStoredCredential(workspace, deadDeck, {
        token: 'stale-token',
        port: deadPort,
        createdAt: persistedAt,
        updatedAt: persistedAt
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
      expect(await sessionCount(workspace)).toBe(0);

      // The dead entry is pruned by listSessions before the loop, but its
      // credential must not survive the host that owned it.
      const dead = JSON.parse(
        await readFile(await credentialFilePath(workspace, deadDeck), 'utf8')
      ) as { token: string; port: number; createdAt: string };
      expect(dead.token).not.toBe('stale-token');
      expect(dead.port).toBe(deadPort);
      expect(dead.createdAt).toBe(persistedAt);
      const live = JSON.parse(
        await readFile(liveCredentialPath, 'utf8')
      ) as { token: string; port: number };
      expect(live.token).not.toBe(liveBefore.token);
      expect(live.port).toBe(Number(liveUrl.port));
    } finally {
      open.kill();
      stop?.kill();
    }
  });

  it('warns but still counts a dead-pid cleanup when rotation fails', async () => {
    const workspace = await createCliWorkspace();
    await copyFixture('basic.deck.html', workspace.cwd);
    const deckPath = join(workspace.cwd, 'basic.deck.html');
    await writeStaleSession(workspace, deckPath, {
      pid: await exitedPid(),
      port: await closedPort()
    });
    // A directory at the credential path fails the rotation and its cleanup.
    const credentialPath = await credentialFilePath(workspace, deckPath);
    await mkdir(credentialPath, { recursive: true });

    try {
      const result = await runCliProcess(['stop', '--all'], {
        cwd: workspace.cwd,
        env: cliEnvironment(workspace)
      });

      expect(result.code).toBe(0);
      expect(result.stdout).toContain('Removed 1 stale editor session(s).');
      expect(result.stderr).toContain('Could not rotate the credential');
      expect(result.stderr).toContain('could not be removed');
    } finally {
      await rm(credentialPath, { recursive: true, force: true });
    }
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
