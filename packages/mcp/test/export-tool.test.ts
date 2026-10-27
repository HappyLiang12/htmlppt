import { randomUUID } from 'node:crypto';
import { realpathSync } from 'node:fs';
import { mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { readDeckFile } from '@htmlppt/core/node';
import { startHost, writeSession } from '@htmlppt/host';
import { makeTempDir } from '@htmlppt/test-utils';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createMcpServer } from '../src/server.js';

const DECK_HTML = `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><title>Export tool</title></head>
<body>
<main data-ppt-deck>
  <section class="slide" data-slide-id="s1" data-width="320" data-height="180">
    <h1 data-ppt-el="e1">One</h1>
  </section>
  <section class="slide" data-slide-id="s2" data-width="320" data-height="180">
    <h2 data-ppt-el="e2">Two</h2>
  </section>
</main>
</body>
</html>
`;

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function canonicalPath(file: string): string {
  try {
    return realpathSync.native(file);
  } catch {
    return file;
  }
}

function folded(file: string): string {
  return process.platform === 'win32' || process.platform === 'darwin'
    ? file.toLowerCase()
    : file;
}

function canonicalList(files: string[]): string[] {
  return files.map((file) => folded(canonicalPath(file)));
}

function samePath(actual: string, expected: string): boolean {
  return folded(canonicalPath(actual)) === folded(canonicalPath(expected));
}

interface ToolResult {
  isError?: boolean;
  content?: { type: string; text?: string }[];
}

interface Context {
  dir: string;
  deckDir: string;
  deckPath: string;
  client: Client;
  close: () => Promise<void>;
}

interface SetupOptions {
  deckDir?: string;
  cwd?: string;
}

let context: Context | undefined;
let previousHome: string | undefined;
let previousMode: string | undefined;
let previousChromium: string | undefined;

async function setup(options: SetupOptions = {}): Promise<Context> {
  const dir = await makeTempDir('htmlppt-mcp-export-');
  const deckDir = options.deckDir ? path.join(dir, options.deckDir) : dir;
  await mkdir(deckDir, { recursive: true });
  const deckPath = path.join(deckDir, 'deck.html');
  await writeFile(deckPath, DECK_HTML, 'utf8');
  const serverCwd = options.cwd ? path.join(dir, options.cwd) : dir;
  await mkdir(serverCwd, { recursive: true });
  try {
    const server = createMcpServer({ cwd: serverCwd });
    const client = new Client({ name: 'export-test', version: '0.0.0' });
    const [clientTransport, serverTransport] =
      InMemoryTransport.createLinkedPair();
    await Promise.all([
      client.connect(clientTransport),
      server.connect(serverTransport)
    ]);
    const created: Context = {
      dir,
      deckDir,
      deckPath,
      client,
      close: async () => {
        await client.close().catch(() => undefined);
        await server.close().catch(() => undefined);
      }
    };
    context = created;
    return created;
  } catch (error) {
    await rm(dir, { recursive: true, force: true });
    throw error;
  }
}

function payload(result: ToolResult): Record<string, unknown> {
  const text = result.content?.[0]?.text;
  if (typeof text !== 'string') {
    throw new Error('The tool returned no text payload.');
  }
  return JSON.parse(text) as Record<string, unknown>;
}

function expectSuccess(result: ToolResult): void {
  expect(
    result.isError,
    result.content?.[0]?.text ?? 'The tool returned no error text.'
  ).toBeUndefined();
}

beforeEach(() => {
  previousHome = process.env.HTMLPPT_HOME;
  previousMode = process.env.HTMLPPT_MCP_MODE;
  previousChromium = process.env.HTMLPPT_CHROMIUM;
  delete process.env.HTMLPPT_MCP_MODE;
});

afterEach(async () => {
  const ctx = context;
  context = undefined;
  try {
    await ctx?.close();
  } finally {
    if (previousHome === undefined) delete process.env.HTMLPPT_HOME;
    else process.env.HTMLPPT_HOME = previousHome;
    if (previousMode === undefined) delete process.env.HTMLPPT_MCP_MODE;
    else process.env.HTMLPPT_MCP_MODE = previousMode;
    if (previousChromium === undefined) delete process.env.HTMLPPT_CHROMIUM;
    else process.env.HTMLPPT_CHROMIUM = previousChromium;
    if (ctx) {
      await rm(ctx.dir, { recursive: true, force: true });
    }
  }
});

describe('export_deck tool', () => {
  it(
    'exports PDF directly when no editor session exists',
    async () => {
      const ctx = await setup();

      const result = (await ctx.client.callTool({
        name: 'export_deck',
        arguments: {
          path: 'deck.html',
          format: 'pdf',
          outDir: 'out'
        }
      })) as ToolResult;

      expectSuccess(result);
      const body = payload(result);
      expect(body).toMatchObject({ format: 'pdf' });
      const files = body.files as string[];
      expect(canonicalList(files)).toEqual(
        canonicalList([path.join(ctx.dir, 'out', 'deck.pdf')])
      );
      expect(
        (await readFile(files[0]!)).subarray(0, 5).toString('latin1')
      ).toBe('%PDF-');
      expect(await readFile(ctx.deckPath, 'utf8')).toBe(DECK_HTML);
    },
    30_000
  );

  it(
    'exports one PNG per slide directly',
    async () => {
      const ctx = await setup();

      const result = (await ctx.client.callTool({
        name: 'export_deck',
        arguments: { path: 'deck.html', format: 'png' }
      })) as ToolResult;

      expectSuccess(result);
      const files = payload(result).files as string[];
      expect(canonicalList(files)).toEqual(
        canonicalList([
          path.join(ctx.dir, 'deck-s1.png'),
          path.join(ctx.dir, 'deck-s2.png')
        ])
      );
      for (const file of files) {
        expect((await readFile(file)).subarray(0, 8)).toEqual(PNG_SIGNATURE);
      }
      expect(await readFile(ctx.deckPath, 'utf8')).toBe(DECK_HTML);
    },
    30_000
  );

  it('rejects an unsupported format at the schema boundary', async () => {
    const ctx = await setup();

    const result = (await ctx.client.callTool({
      name: 'export_deck',
      arguments: { path: 'deck.html', format: 'jpg' }
    })) as ToolResult;

    expect(result.isError).toBe(true);
    const text = result.content?.[0]?.text ?? '';
    expect(text).toContain('MCP error -32602');
    expect(text).toContain('Invalid arguments for tool export_deck');
  });

  it('rejects outDir escapes for html and pdf before writing', async () => {
    const ctx = await setup({ deckDir: 'decks' });
    const outside = path.join(ctx.dir, 'outside');

    const attempts = [
      { format: 'html', outDir: '..' },
      { format: 'pdf', outDir: '..' },
      { format: 'html', outDir: outside },
      { format: 'pdf', outDir: outside }
    ];
    for (const attempt of attempts) {
      const result = (await ctx.client.callTool({
        name: 'export_deck',
        arguments: { path: ctx.deckPath, ...attempt }
      })) as ToolResult;

      expect(
        result.isError,
        `${attempt.format} ${attempt.outDir} was not rejected.`
      ).toBe(true);
      const body = payload(result);
      expect(body).toMatchObject({
        code: 'invalid-out-dir',
        path: ctx.deckPath
      });
      expect(String(body.message)).toContain('deck directory');
      expect(String(body.message)).not.toContain('Bearer');
    }

    expect(await readFile(ctx.deckPath, 'utf8')).toBe(DECK_HTML);
    expect(await readdir(ctx.deckDir)).toEqual(['deck.html']);
    expect(await readdir(ctx.dir)).toEqual(['decks']);
  });

  it('refuses to export over a source deck with a colliding name', async () => {
    const ctx = await setup();
    const pdfDeck = path.join(ctx.dir, 'deck.pdf');
    await writeFile(pdfDeck, DECK_HTML, 'utf8');

    const result = (await ctx.client.callTool({
      name: 'export_deck',
      arguments: { path: pdfDeck, format: 'pdf' }
    })) as ToolResult;

    expect(result.isError, 'pdf overwrote deck.pdf.').toBe(true);
    expect(payload(result)).toMatchObject({ code: 'source-overwrite' });
    expect(await readFile(pdfDeck, 'utf8')).toBe(DECK_HTML);
  });

  it('resolves a relative outDir against the deck directory, not the cwd', async () => {
    const ctx = await setup({ deckDir: 'decks', cwd: 'client' });

    const result = (await ctx.client.callTool({
      name: 'export_deck',
      arguments: {
        path: ctx.deckPath,
        format: 'html',
        outDir: 'exports'
      }
    })) as ToolResult;

    expectSuccess(result);
    const outputPath = path.join(ctx.deckDir, 'exports', 'deck.export.html');
    expect(payload(result)).toMatchObject({
      path: ctx.deckPath,
      format: 'html'
    });
    expect(samePath(String(payload(result).outputPath), outputPath)).toBe(true);
    expect(await readFile(outputPath, 'utf8')).toContain(
      '<!-- Edited with htmlppt.'
    );
    await expect(
      readFile(path.join(ctx.dir, 'client', 'exports', 'deck.export.html'))
    ).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('accepts a nested outDir inside the deck directory', async () => {
    const ctx = await setup({ deckDir: 'decks', cwd: 'client' });

    const result = (await ctx.client.callTool({
      name: 'export_deck',
      arguments: {
        path: ctx.deckPath,
        format: 'html',
        outDir: path.join('exports', 'nested', 'deep')
      }
    })) as ToolResult;

    expectSuccess(result);
    const outputPath = path.join(
      ctx.deckDir,
      'exports',
      'nested',
      'deep',
      'deck.export.html'
    );
    expect(samePath(String(payload(result).outputPath), outputPath)).toBe(true);
    expect(await readFile(outputPath, 'utf8')).toContain(
      '<!-- Edited with htmlppt.'
    );
  });

  it(
    'reports an unavailable renderer with instructions',
    async () => {
      const ctx = await setup();
      process.env.HTMLPPT_CHROMIUM = path.join(
        ctx.dir,
        'missing-browser.exe'
      );

      const result = (await ctx.client.callTool({
        name: 'export_deck',
        arguments: { path: 'deck.html', format: 'pdf' }
      })) as ToolResult;

      expect(result.isError).toBe(true);
      const body = payload(result);
      expect(body.code).toBe('renderer-unavailable');
      expect(String(body.message)).toContain('HTMLPPT_CHROMIUM');
    },
    30_000
  );

  it(
    'confines outDir to the deck directory in host mode when cwd differs',
    async () => {
      const ctx = await setup({ deckDir: 'decks', cwd: 'client' });
      const home = path.join(ctx.dir, 'home');
      process.env.HTMLPPT_HOME = home;
      await mkdir(home, { recursive: true });
      const editorDir = path.join(ctx.dir, 'editor');
      await mkdir(editorDir, { recursive: true });
      await writeFile(
        path.join(editorDir, 'index.html'),
        '<!doctype html><title>Editor</title><div id="root"></div>',
        'utf8'
      );
      const token = randomUUID();
      const host = await startHost({
        filePath: ctx.deckPath,
        token,
        editorDir,
        port: 0
      });
      const base = new URL(host.url).origin;
      try {
        await writeSession({
          path: ctx.deckPath,
          port: host.port,
          token,
          pid: process.pid,
          startedAt: new Date().toISOString(),
          revision: (await readDeckFile(ctx.deckPath)).hash
        });

        // The MCP process cwd is not the deck directory; escapes are rejected
        // before the host is contacted.
        const outside = path.join(ctx.dir, 'host-outside');
        for (const outDir of ['..', outside]) {
          const rejected = (await ctx.client.callTool({
            name: 'export_deck',
            arguments: { path: ctx.deckPath, format: 'pdf', outDir }
          })) as ToolResult;
          expect(rejected.isError).toBe(true);
          expect(payload(rejected)).toMatchObject({
            code: 'invalid-out-dir',
            path: ctx.deckPath
          });
        }

        const result = (await ctx.client.callTool({
          name: 'export_deck',
          arguments: {
            path: ctx.deckPath,
            format: 'pdf',
            outDir: 'host-renders'
          }
        })) as ToolResult;
        expectSuccess(result);
        const files = payload(result).files as string[];
        expect(canonicalList(files)).toEqual(
          canonicalList([path.join(ctx.deckDir, 'host-renders', 'deck.pdf')])
        );
        expect(
          (await readFile(files[0]!)).subarray(0, 5).toString('latin1')
        ).toBe('%PDF-');

        // An absolute path inside the deck directory is accepted and is
        // re-validated by the host.
        const absoluteOutDir = path.join(ctx.deckDir, 'host-absolute');
        const absolute = (await ctx.client.callTool({
          name: 'export_deck',
          arguments: {
            path: ctx.deckPath,
            format: 'pdf',
            outDir: absoluteOutDir
          }
        })) as ToolResult;
        expectSuccess(absolute);
        expect(canonicalList(payload(absolute).files as string[])).toEqual(
          canonicalList([path.join(absoluteOutDir, 'deck.pdf')])
        );

        // HTML stays confined even though it is written without the host.
        const html = (await ctx.client.callTool({
          name: 'export_deck',
          arguments: {
            path: ctx.deckPath,
            format: 'html',
            outDir: 'host-html'
          }
        })) as ToolResult;
        expectSuccess(html);
        expect(
          samePath(
            String(payload(html).outputPath),
            path.join(ctx.deckDir, 'host-html', 'deck.export.html')
          )
        ).toBe(true);

        // Host failures surface without the bearer token or host URL.
        process.env.HTMLPPT_CHROMIUM = path.join(
          ctx.dir,
          'missing-browser.exe'
        );
        const failed = (await ctx.client.callTool({
          name: 'export_deck',
          arguments: {
            path: ctx.deckPath,
            format: 'pdf',
            outDir: 'host-error'
          }
        })) as ToolResult;
        expect(failed.isError).toBe(true);
        const failedBody = payload(failed);
        expect(failedBody.code).toBe('renderer-unavailable');
        expect(String(failedBody.message)).not.toContain(token);
        expect(String(failedBody.message)).not.toContain(base);
        expect(String(failedBody.message)).not.toContain('Bearer');
      } finally {
        await host.close();
      }
    },
    60_000
  );
});
