import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { makeTempDir } from '@htmlppt/test-utils';
import { describe, expect, it } from 'vitest';
import { runCli } from '../src/index.js';

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

  it('rejects unsupported export formats with a clear error', async () => {
    const cwd = await makeTempDir('htmlppt-cli-');
    await runCli(['new', 'deck.html'], { cwd, ...capture().io });
    const output = capture();

    const code = await runCli(['export', 'deck.html', '--format', 'pdf'], {
      cwd,
      ...output.io
    });

    expect(code).toBe(1);
    expect(output.stderr.join('\n')).toContain('Only html export is available');
  });

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
