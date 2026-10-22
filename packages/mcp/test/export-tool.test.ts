import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
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

interface ToolResult {
  isError?: boolean;
  content?: { type: string; text?: string }[];
}

interface Context {
  dir: string;
  deckPath: string;
  client: Client;
  close: () => Promise<void>;
}

let context: Context | undefined;
let previousHome: string | undefined;
let previousMode: string | undefined;
let previousChromium: string | undefined;

async function setup(): Promise<Context> {
  const dir = await makeTempDir('htmlppt-mcp-export-');
  const deckPath = path.join(dir, 'deck.html');
  await writeFile(deckPath, DECK_HTML, 'utf8');
  try {
    const server = createMcpServer({ cwd: dir });
    const client = new Client({ name: 'export-test', version: '0.0.0' });
    const [clientTransport, serverTransport] =
      InMemoryTransport.createLinkedPair();
    await Promise.all([
      client.connect(clientTransport),
      server.connect(serverTransport)
    ]);
    const created: Context = {
      dir,
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

      expect(result.isError).toBeUndefined();
      const body = payload(result);
      expect(body).toMatchObject({ format: 'pdf' });
      const files = body.files as string[];
      expect(files).toEqual([path.join(ctx.dir, 'out', 'deck.pdf')]);
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

      expect(result.isError).toBeUndefined();
      const files = payload(result).files as string[];
      expect(files).toEqual([
        path.join(ctx.dir, 'deck-s1.png'),
        path.join(ctx.dir, 'deck-s2.png')
      ]);
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
    'uses the live host for exports and keeps its outDir confinement',
    async () => {
      const ctx = await setup();
      const home = path.join(ctx.dir, 'home');
      process.env.HTMLPPT_HOME = home;
      await mkdir(home, { recursive: true });
      const editorDir = path.join(ctx.dir, 'editor');
      await mkdir(editorDir, { recursive: true });
      await writeFile(
        path.join(editorDir, 'index.html'),
        '<!doctype html><title>Editor</title>',
        'utf8'
      );
      const token = randomUUID();
      const host = await startHost({
        filePath: ctx.deckPath,
        token,
        editorDir,
        port: 0
      });
      try {
        await writeSession({
          path: ctx.deckPath,
          port: host.port,
          token,
          pid: process.pid,
          startedAt: new Date().toISOString(),
          revision: (await readDeckFile(ctx.deckPath)).hash
        });

        const outside = path.join(ctx.dir, '..', `outside-${randomUUID()}`);
        const rejected = (await ctx.client.callTool({
          name: 'export_deck',
          arguments: {
            path: 'deck.html',
            format: 'pdf',
            outDir: outside
          }
        })) as ToolResult;
        expect(rejected.isError).toBe(true);
        const rejectedBody = payload(rejected);
        expect(rejectedBody.code).toBe('export-failed');
        expect(String(rejectedBody.message)).toContain(
          'inside the deck directory'
        );

        const result = (await ctx.client.callTool({
          name: 'export_deck',
          arguments: {
            path: 'deck.html',
            format: 'pdf',
            outDir: 'host-renders'
          }
        })) as ToolResult;
        expect(result.isError).toBeUndefined();
        const files = payload(result).files as string[];
        expect(files).toEqual([path.join(ctx.dir, 'host-renders', 'deck.pdf')]);
        expect(
          (await readFile(files[0]!)).subarray(0, 5).toString('latin1')
        ).toBe('%PDF-');
      } finally {
        await host.close();
      }
    },
    30_000
  );
});
