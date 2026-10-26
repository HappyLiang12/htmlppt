import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { createServer as createHttpServer } from 'node:http';
import { createServer } from 'node:net';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createDeckHtml, MAX_IMAGE_BYTES, validateDeck } from '@htmlppt/core';
import { parseDeckHtml } from '@htmlppt/core/node';
import {
  readSession,
  sessionKey,
  sessionsDirectory,
  startHost,
  writeSession
} from '@htmlppt/host';
import { RUNTIME_SOURCE } from '@htmlppt/runtime';
import { copyFixture, makeTempDir } from '@htmlppt/test-utils';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import {
  getDefaultEnvironment,
  StdioClientTransport
} from '@modelcontextprotocol/sdk/client/stdio.js';
import { ErrorCode } from '@modelcontextprotocol/sdk/types.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { openEventStream, type SseStream } from './sse.js';

const repoRoot = fileURLToPath(new URL('../../..', import.meta.url));
const packageRoot = join(repoRoot, 'packages', 'mcp');
const binPath = join(packageRoot, 'dist', 'bin.js');
const cliBinPath = join(repoRoot, 'packages', 'cli', 'dist', 'bin.js');
const tsupCli = createRequire(import.meta.url).resolve(
  'tsup/dist/cli-default.js'
);

const EXPECTED_TOOLS = [
  'add_element',
  'add_image',
  'add_slide',
  'add_table',
  'create_deck',
  'delete_slide',
  'duplicate_slide',
  'export_deck',
  'get_deck_contract',
  'get_element',
  'get_outline',
  'move_slide',
  'open_editor',
  'read_slide',
  'remove_element',
  'set_element_html',
  'set_notes',
  'set_slide_background',
  'set_slide_order',
  'set_style',
  'set_text',
  'set_transition',
  'update_chart',
  'update_slide_html',
  'validate_deck'
];

const RESOURCE_URIS = [
  'htmlppt://contract',
  'htmlppt://authoring',
  'htmlppt://example'
];

const toolsSnapshotPath = fileURLToPath(
  new URL('./tools.snapshot.json', import.meta.url)
);
const skillToolsDocPath = fileURLToPath(
  new URL('../../../skills/htmlppt/references/mcp-tools.md', import.meta.url)
);

interface SurfaceState {
  relativePath: string;
  deckPath: string;
  primarySlideId: string;
  secondarySlideId: string;
  newSlideId: string;
  extraSlideId: string;
  exportedPath: string;
  editorPid?: number;
}

interface ToolCase {
  name: string;
  args: (state: SurfaceState) => Record<string, unknown>;
  verify: (state: SurfaceState, payload: Record<string, unknown>) => Promise<void>;
}

interface InvalidArgumentCase {
  name: string;
  invalidArgs: unknown;
}

function surfaceState(relativePath: string): SurfaceState {
  return {
    relativePath,
    deckPath: join(dir, relativePath),
    primarySlideId: '',
    secondarySlideId: '',
    newSlideId: '',
    extraSlideId: '',
    exportedPath: ''
  };
}

function requireSlideId(payload: Record<string, unknown>): string {
  if (typeof payload.slideId !== 'string' || payload.slideId.length === 0) {
    throw new Error(`Expected a slideId, received ${JSON.stringify(payload)}.`);
  }
  return payload.slideId;
}

async function readDeckDocument(state: SurfaceState): Promise<Document> {
  return parseDeckHtml(await readFile(state.deckPath, 'utf8'));
}

async function readDeckAt(filePath: string): Promise<Document> {
  return parseDeckHtml(await readFile(filePath, 'utf8'));
}

function slideIds(document: Document): Array<string | null> {
  return Array.from(document.querySelectorAll('[data-slide-id]')).map((slide) =>
    slide.getAttribute('data-slide-id')
  );
}

const TINY_PNG_DATA_URL =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=';

const TINY_SVG = '<svg xmlns="http://www.w3.org/2000/svg" width="8" height="8"><rect width="8" height="8" fill="#4f7cff"/></svg>';

function chartFigure(id: string, width = 640, height = 360): string {
  return `<figure data-ppt-el="${id}" data-ppt-chart='{"type":"bar","labels":["A","B","C"],"series":[{"name":"Series 1","values":[1,2,3]}]}' style="position: absolute; left: 100px; top: 100px; width: ${width}px; height: ${height}px;"><figcaption>Chart</figcaption></figure>`;
}

/** Builds a one-or-more-slide template deck whose first slide has a chart. */
function deckHtmlWithChart(
  title: string,
  slides: number,
  chartId: string,
  chartWidth = 640,
  chartHeight = 360
): string {
  const anchor = `<h1 data-ppt-el="e1">${title}</h1>\n      </div>`;
  const html = createDeckHtml({ title, slides });
  if (!html.includes(anchor)) {
    throw new Error('The generated deck template changed shape.');
  }
  return html.replace(
    anchor,
    `${anchor}\n    ${chartFigure(chartId, chartWidth, chartHeight)}`
  );
}

const READ_TOOL_CASES: ToolCase[] = [
  {
    name: 'get_deck_contract',
    args: () => ({}),
    verify: async (_state, payload) => {
      expect(String(payload.contract)).toContain('htmldeck/v1');
      expect(String(payload.authoring)).toContain('htmlppt');
    }
  },
  {
    name: 'validate_deck',
    args: (state) => ({ path: state.relativePath }),
    verify: async (_state, payload) => {
      expect(payload).toMatchObject({ valid: true, errors: [] });
      expect(Array.isArray(payload.warnings)).toBe(true);
    }
  },
  {
    name: 'get_outline',
    args: (state) => ({ path: state.relativePath }),
    verify: async (state, payload) => {
      const outline = payload.outline as {
        slideCount?: unknown;
        slides?: Array<{ id?: unknown }>;
      };
      expect(outline.slideCount).toBe(2);
      expect(outline.slides?.map((slide) => slide.id)).toEqual(['s1', 's2']);
      expect(payload).toMatchObject({ path: state.deckPath });
    }
  },
  {
    name: 'read_slide',
    args: (state) => ({ path: state.relativePath, slideId: 's1' }),
    verify: async (_state, payload) => {
      expect(payload.slide).toMatchObject({
        id: 's1',
        width: 1600,
        height: 900
      });
      expect(String((payload.slide as { html?: unknown }).html)).toContain(
        'Surface read'
      );
    }
  },
  {
    name: 'get_element',
    args: (state) => ({
      path: state.relativePath,
      slideId: 's1',
      target: { elementId: 'e1' }
    }),
    verify: async (_state, payload) => {
      expect(String(payload.html)).toContain('data-ppt-el="e1"');
      expect(payload.style).toBeNull();
    }
  }
];

const MUTATION_TOOL_CASES: ToolCase[] = [
  {
    name: 'create_deck',
    args: (state) => ({
      path: state.relativePath,
      html: deckHtmlWithChart('Surface mutations', 2, 'surface-chart')
    }),
    verify: async (state, payload) => {
      expect(payload).toMatchObject({
        path: state.deckPath,
        created: true
      });
      expect(typeof payload.revision).toBe('string');
      expect(await readFile(state.deckPath, 'utf8')).toContain(
        'Surface mutations'
      );
      state.primarySlideId = 's1';
      state.secondarySlideId = 's2';
    }
  },
  {
    name: 'add_slide',
    args: (state) => ({
      path: state.relativePath,
      html: '<h2 data-ppt-el="added">Added slide</h2>',
      notes: 'Added notes',
      transition: 'fade'
    }),
    verify: async (state, payload) => {
      state.newSlideId = requireSlideId(payload);
      const document = await readDeckDocument(state);
      const slide = document.querySelector(
        `[data-slide-id="${state.newSlideId}"]`
      );
      expect(slide?.getAttribute('data-ppt-transition')).toBe('fade');
      expect(slide?.textContent).toContain('Added slide');
      expect(slide?.textContent).toContain('Added notes');
    }
  },
  {
    name: 'update_slide_html',
    args: (state) => ({
      path: state.relativePath,
      slideId: state.newSlideId,
      html: '<p data-ppt-el="updated">Updated body</p>'
    }),
    verify: async (state) => {
      const document = await readDeckDocument(state);
      const slide = document.querySelector(
        `[data-slide-id="${state.newSlideId}"]`
      );
      expect(slide?.textContent).toContain('Updated body');
      expect(slide?.querySelector('[data-ppt-el="updated"]')).not.toBeNull();
    }
  },
  {
    name: 'duplicate_slide',
    args: (state) => ({
      path: state.relativePath,
      slideId: state.newSlideId
    }),
    verify: async (state, payload) => {
      state.extraSlideId = requireSlideId(payload);
      expect(state.extraSlideId).not.toBe(state.newSlideId);
      const document = await readDeckDocument(state);
      expect(slideIds(document)).toHaveLength(4);
      expect(slideIds(document)).toContain(state.extraSlideId);
    }
  },
  {
    name: 'move_slide',
    args: (state) => ({
      path: state.relativePath,
      slideId: state.extraSlideId,
      toIndex: 0
    }),
    verify: async (state) => {
      const document = await readDeckDocument(state);
      expect(slideIds(document)[0]).toBe(state.extraSlideId);
    }
  },
  {
    name: 'delete_slide',
    args: (state) => ({
      path: state.relativePath,
      slideId: state.extraSlideId
    }),
    verify: async (state) => {
      const document = await readDeckDocument(state);
      expect(slideIds(document)).not.toContain(state.extraSlideId);
      expect(slideIds(document)).toHaveLength(3);
    }
  },
  {
    name: 'set_notes',
    args: (state) => ({
      path: state.relativePath,
      slideId: state.newSlideId,
      notes: 'Deck talk track'
    }),
    verify: async (state) => {
      const document = await readDeckDocument(state);
      const notes = document.querySelector(
        `[data-slide-id="${state.newSlideId}"] [data-ppt-notes]`
      );
      expect(notes?.textContent).toBe('Deck talk track');
    }
  },
  {
    name: 'set_transition',
    args: (state) => ({
      path: state.relativePath,
      slideId: state.newSlideId,
      transition: 'slide'
    }),
    verify: async (state) => {
      const document = await readDeckDocument(state);
      const slide = document.querySelector(
        `[data-slide-id="${state.newSlideId}"]`
      );
      expect(slide?.getAttribute('data-ppt-transition')).toBe('slide');
    }
  },
  {
    name: 'set_slide_background',
    args: (state) => ({
      path: state.relativePath,
      slideId: state.newSlideId,
      background: { color: '#123456' }
    }),
    verify: async (state) => {
      const document = await readDeckDocument(state);
      const slide = document.querySelector(
        `[data-slide-id="${state.newSlideId}"]`
      );
      expect(slide?.getAttribute('style')).toContain('#123456');
    }
  },
  {
    name: 'add_element',
    args: (state) => ({
      path: state.relativePath,
      slideId: state.newSlideId,
      html: '<p data-ppt-el="surface-el">Element</p>'
    }),
    verify: async (state, payload) => {
      expect(payload.elementId).toBe('surface-el');
      const document = await readDeckDocument(state);
      expect(
        document.querySelector(
          `[data-slide-id="${state.newSlideId}"] [data-ppt-el="surface-el"]`
        )
      ).not.toBeNull();
    }
  },
  {
    name: 'add_image',
    args: (state) => ({
      path: state.relativePath,
      slideId: state.newSlideId,
      source: TINY_PNG_DATA_URL,
      width: 320
    }),
    verify: async (state, payload) => {
      expect(typeof payload.elementId).toBe('string');
      const document = await readDeckDocument(state);
      const image = document.querySelector(
        `[data-slide-id="${state.newSlideId}"] img[data-ppt-el="${String(payload.elementId)}"]`
      ) as HTMLImageElement | null;
      expect(image?.getAttribute('src')).toBe(TINY_PNG_DATA_URL);
      expect(image?.style.left).toBe('100px');
      expect(image?.style.top).toBe('100px');
      expect(image?.style.width).toBe('320px');
      expect(image?.style.height).toBe('180px');
    }
  },
  {
    name: 'add_table',
    args: (state) => ({
      path: state.relativePath,
      slideId: state.newSlideId,
      rows: 2,
      columns: 3
    }),
    verify: async (state, payload) => {
      expect(typeof payload.elementId).toBe('string');
      const document = await readDeckDocument(state);
      const table = document.querySelector(
        `[data-slide-id="${state.newSlideId}"] table[data-ppt-el="${String(payload.elementId)}"]`
      ) as HTMLTableElement | null;
      expect(table?.style.left).toBe('100px');
      expect(table?.style.top).toBe('100px');
      expect(table?.style.width).toBe('960px');
      expect(table?.querySelectorAll('tr')).toHaveLength(2);
      expect(table?.querySelectorAll('tr')[0]?.querySelectorAll('th')).toHaveLength(3);
      expect(table?.querySelectorAll('tr')[1]?.querySelectorAll('td')).toHaveLength(3);
    }
  },
  {
    name: 'update_chart',
    args: (state) => ({
      path: state.relativePath,
      slideId: state.primarySlideId,
      target: { elementId: 'surface-chart' },
      chart: {
        type: 'line',
        title: 'Surface trend',
        labels: ['A', 'B', 'C'],
        series: [{ name: 'Series 1', values: [3, 2, 1] }]
      }
    }),
    verify: async (state, payload) => {
      expect(payload).toMatchObject({ width: 640, height: 360 });
      const document = await readDeckDocument(state);
      const figure = document.querySelector(
        '[data-slide-id="s1"] figure[data-ppt-el="surface-chart"]'
      );
      const data = JSON.parse(
        figure?.getAttribute('data-ppt-chart') ?? '{}'
      ) as { type?: unknown; series?: Array<{ values?: unknown }> };
      expect(data.type).toBe('line');
      expect(data.series?.[0]?.values).toEqual([3, 2, 1]);
      expect(figure?.querySelector('svg')).not.toBeNull();
    }
  },
  {
    name: 'set_element_html',
    args: (state) => ({
      path: state.relativePath,
      slideId: state.newSlideId,
      target: { elementId: 'surface-el' },
      html: '<strong>Strong content</strong>'
    }),
    verify: async (state) => {
      const document = await readDeckDocument(state);
      expect(
        document.querySelector('[data-ppt-el="surface-el"]')?.textContent
      ).toBe('Strong content');
    }
  },
  {
    name: 'set_text',
    args: (state) => ({
      path: state.relativePath,
      slideId: state.newSlideId,
      target: { elementId: 'surface-el' },
      text: 'Plain <text>'
    }),
    verify: async (state) => {
      const html = await readFile(state.deckPath, 'utf8');
      expect(html).toContain('Plain &lt;text&gt;');
      expect(html).not.toContain('<text>');
    }
  },
  {
    name: 'set_style',
    args: (state) => ({
      path: state.relativePath,
      slideId: state.newSlideId,
      target: { elementId: 'surface-el' },
      styles: { color: 'red', 'font-size': '20px' }
    }),
    verify: async (state) => {
      const document = await readDeckDocument(state);
      const style = document
        .querySelector('[data-ppt-el="surface-el"]')
        ?.getAttribute('style');
      expect(style).toContain('color:red');
      expect(style).toContain('font-size:20px');
    }
  },
  {
    name: 'remove_element',
    args: (state) => ({
      path: state.relativePath,
      slideId: state.newSlideId,
      target: { elementId: 'surface-el' }
    }),
    verify: async (state) => {
      const html = await readFile(state.deckPath, 'utf8');
      expect(html).not.toContain('surface-el');
    }
  },
  {
    name: 'set_slide_order',
    args: (state) => ({
      path: state.relativePath,
      slideIds: [
        state.newSlideId,
        state.primarySlideId,
        state.secondarySlideId
      ]
    }),
    verify: async (state) => {
      const document = await readDeckDocument(state);
      expect(slideIds(document)).toEqual([
        state.newSlideId,
        state.primarySlideId,
        state.secondarySlideId
      ]);
    }
  },
  {
    name: 'export_deck',
    args: (state) => ({ path: state.relativePath, format: 'html' }),
    verify: async (state, payload) => {
      state.exportedPath = join(
        dir,
        'surface-mutations.deck.export.html'
      );
      expect(payload).toMatchObject({
        path: state.deckPath,
        format: 'html',
        outputPath: state.exportedPath
      });
      const exported = await readFile(state.exportedPath, 'utf8');
      expect(exported).toContain('<!-- Edited with htmlppt.');
      expect(validateDeck(parseDeckHtml(exported)).valid).toBe(true);
    }
  },
  {
    name: 'open_editor',
    args: (state) => ({ path: state.relativePath, open: false }),
    verify: async (state, payload) => {
      const url = new URL(String(payload.url));
      expect(url.hostname).toBe('127.0.0.1');
      const token = url.searchParams.get('token');
      if (!token) {
        throw new Error('open_editor returned a URL without a token.');
      }
      const health = await fetch(`${url.origin}/api/health`, {
        headers: { authorization: `Bearer ${token}` },
        signal: AbortSignal.timeout(5_000)
      });
      expect(health.status).toBe(200);
      expect(((await health.json()) as { ok?: unknown }).ok).toBe(true);
      const session = await readSession(
        join(sessionsDirectory(), `${sessionKey(state.deckPath)}.json`)
      );
      expect(session).toMatchObject({
        path: state.deckPath,
        port: Number(url.port),
        token
      });
      state.editorPid = session?.pid;
    }
  }
];

const INVALID_ARGUMENT_CASES: InvalidArgumentCase[] = [
  { name: 'get_deck_contract', invalidArgs: { unexpected: true } },
  { name: 'validate_deck', invalidArgs: {} },
  { name: 'get_outline', invalidArgs: { path: 7 } },
  { name: 'read_slide', invalidArgs: { path: 'deck.html', slideId: 7 } },
  { name: 'get_element', invalidArgs: { path: 'deck.html', slideId: 's1' } },
  { name: 'create_deck', invalidArgs: { path: '' } },
  { name: 'add_slide', invalidArgs: { path: 'deck.html', afterSlideId: 5 } },
  {
    name: 'update_slide_html',
    invalidArgs: { path: 'deck.html', slideId: 's1' }
  },
  { name: 'duplicate_slide', invalidArgs: { path: 'deck.html', slideId: '' } },
  { name: 'delete_slide', invalidArgs: { path: 'deck.html' } },
  {
    name: 'move_slide',
    invalidArgs: { path: 'deck.html', slideId: 's1', toIndex: -1 }
  },
  {
    name: 'set_notes',
    invalidArgs: { path: 'deck.html', slideId: 's1', notes: 5 }
  },
  {
    name: 'set_transition',
    invalidArgs: { path: 'deck.html', slideId: 's1', transition: 'wipe' }
  },
  {
    name: 'set_slide_background',
    invalidArgs: { path: 'deck.html', slideId: 's1', background: { color: 5 } }
  },
  {
    name: 'add_element',
    invalidArgs: { path: 'deck.html', slideId: 's1', html: 5 }
  },
  {
    name: 'add_image',
    invalidArgs: { path: 'deck.html', slideId: 's1' }
  },
  {
    name: 'add_table',
    invalidArgs: {
      path: 'deck.html',
      slideId: 's1',
      rows: 1.5,
      columns: 2
    }
  },
  {
    name: 'update_chart',
    invalidArgs: {
      path: 'deck.html',
      slideId: 's1',
      target: { elementId: 'e1' }
    }
  },
  {
    name: 'set_element_html',
    invalidArgs: {
      path: 'deck.html',
      slideId: 's1',
      target: { elementId: 'e1' }
    }
  },
  {
    name: 'set_text',
    invalidArgs: {
      path: 'deck.html',
      slideId: 's1',
      target: { elementId: 'e1' }
    }
  },
  {
    name: 'set_style',
    invalidArgs: {
      path: 'deck.html',
      slideId: 's1',
      target: { elementId: 'e1' },
      styles: 'red'
    }
  },
  {
    name: 'remove_element',
    invalidArgs: { path: 'deck.html', slideId: 's1' }
  },
  { name: 'set_slide_order', invalidArgs: { path: 'deck.html', slideIds: [] } },
  { name: 'open_editor', invalidArgs: { path: 'deck.html', port: 70_000 } },
  { name: 'export_deck', invalidArgs: { path: 'deck.html', format: 'jpg' } }
];

let dir: string;
let home: string;
let editorDir: string;
let previousHome: string | undefined;
let client: Client;
let transport: StdioClientTransport;

interface BuildStep {
  workspace: string;
  args: string[];
}

// Running the tsup CLI through process.execPath avoids spawning npm.cmd with
// shell: true, which Node deprecates (DEP0190).
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
  // open_editor starts a host through the built CLI.
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
    child.on('error', reject);
    child.on('close', (code) => {
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

interface ToolResult {
  content?: Array<{ type: string; text?: string }>;
  isError?: boolean;
}

function resultPayload(result: ToolResult): Record<string, unknown> {
  const text = result.content?.find(
    (item) => item.type === 'text' && typeof item.text === 'string'
  );
  if (!text?.text) {
    throw new Error('The tool returned no text content.');
  }
  const parsed: unknown = JSON.parse(text.text);
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error('The tool result is not a JSON object.');
  }
  return parsed as Record<string, unknown>;
}

function resourceText(
  contents: Array<{ text?: string; blob?: string }>,
  uri: string
): string {
  const content = contents[0];
  if (!content || typeof content.text !== 'string') {
    throw new Error(`Resource ${uri} did not return text content.`);
  }
  return content.text;
}

async function callTool(
  name: string,
  args: Record<string, unknown>
): Promise<{ result: ToolResult; payload: Record<string, unknown> }> {
  const result = (await client.callTool({ name, arguments: args })) as ToolResult;
  return { result, payload: resultPayload(result) };
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

interface FakeHost {
  port: number;
  close: () => Promise<void>;
}

/**
 * Answers the token-authenticated health check for any deck but fails the
 * editor shell, like a host whose build disappeared after it started.
 */
async function brokenShellHost(): Promise<FakeHost> {
  const server = createHttpServer((request, response) => {
    if ((request.url ?? '/').startsWith('/api/health')) {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ ok: true }));
      return;
    }
    response.writeHead(500, { 'content-type': 'text/plain' });
    response.end('editor build missing');
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') {
    throw new Error('The fake host did not expose a TCP port.');
  }
  return {
    port: address.port,
    close: async () => {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  };
}

/**
 * Locks the observed SDK contract: argument-schema failures are rejected with
 * the InvalidParams code before the handler runs, but the SDK delivers that
 * rejection as an isError text result, not as the structured domain payload.
 */
async function expectInvalidArguments(
  name: string,
  args: unknown
): Promise<void> {
  const result = (await client.callTool({
    name,
    arguments: args as Record<string, unknown>
  })) as ToolResult;
  expect(result.isError, `${name} accepted invalid arguments.`).toBe(true);
  const text = result.content?.[0]?.text ?? '';
  expect(text).toContain(`MCP error ${ErrorCode.InvalidParams}`);
  expect(text).toContain(`Invalid arguments for tool ${name}`);
  expect(() => resultPayload(result)).toThrow();
}

interface ProcessResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

/**
 * Bounds only the wait for response headers. Clearing the timer afterwards
 * leaves the SSE body readable for the rest of the test.
 */
async function fetchEventStream(
  url: string,
  timeoutMs = 5_000
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  timer.unref();
  try {
    return await fetch(url, { signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

function runProcess(
  command: string,
  args: string[],
  options: { cwd: string; env: NodeJS.ProcessEnv; timeoutMs?: number }
): Promise<ProcessResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env,
      stdio: ['ignore', 'pipe', 'pipe']
    });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill();
      reject(
        new Error(
          `Process ${command} ${args.join(' ')} did not exit in time.\nstdout:\n${stdout}\nstderr:\n${stderr}`
        )
      );
    }, options.timeoutMs ?? 20_000);
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk: string) => {
      stderr += chunk;
    });
    child.once('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once('close', (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
  });
}

beforeAll(async () => {
  await buildWorkspace();
  dir = await makeTempDir('htmlppt-mcp-stdio-');
  home = join(dir, 'home');
  await mkdir(home, { recursive: true });
  editorDir = join(dir, 'editor');
  await mkdir(editorDir, { recursive: true });
  await writeFile(
    join(editorDir, 'index.html'),
    '<!doctype html><title>Editor</title><div id="root">editor-shell</div>',
    'utf8'
  );
  previousHome = process.env.HTMLPPT_HOME;
  process.env.HTMLPPT_HOME = home;
  transport = new StdioClientTransport({
    command: process.execPath,
    args: [binPath],
    cwd: dir,
    env: {
      ...getDefaultEnvironment(),
      HTMLPPT_HOME: home,
      HTMLPPT_EDITOR_DIR: editorDir
    },
    stderr: 'pipe'
  });
  client = new Client({ name: 'htmlppt-stdio-test', version: '0.0.0' });
  await client.connect(transport);
}, 180_000);

afterAll(async () => {
  try {
    await client?.close();
  } finally {
    if (previousHome === undefined) {
      delete process.env.HTMLPPT_HOME;
    } else {
      process.env.HTMLPPT_HOME = previousHome;
    }
    if (dir) {
      await rm(dir, { recursive: true, force: true });
    }
  }
});

describe('htmlppt MCP stdio server', () => {
  it('completes the initialize handshake and lists every tool @feature:mcp', async () => {
    const { tools } = await client.listTools();

    expect(tools.map((tool) => tool.name).sort()).toEqual(EXPECTED_TOOLS);
    for (const tool of tools) {
      expect(tool.description?.trim().length).toBeGreaterThan(0);
      expect(tool.inputSchema.type).toBe('object');
    }
    const names = new Set(tools.map((tool) => tool.name));
    expect(names.has('open_editor')).toBe(true);
    expect(names.has('export_deck')).toBe(true);

    const exportTool = tools.find((tool) => tool.name === 'export_deck');
    const properties = exportTool?.inputSchema.properties as
      | Record<string, Record<string, unknown>>
      | undefined;
    expect(properties?.format).toMatchObject({
      enum: ['html', 'pdf', 'png'],
      default: 'html'
    });
  });

  it('lists and serves the contract, authoring, and example resources', async () => {
    const { resources } = await client.listResources();
    expect(resources.map((resource) => resource.uri).sort()).toEqual(
      [...RESOURCE_URIS].sort()
    );
    for (const resource of resources) {
      expect(resource.name.length).toBeGreaterThan(0);
    }

    const contract = await client.readResource({ uri: 'htmlppt://contract' });
    const contractText = resourceText(contract.contents, 'htmlppt://contract');
    expect(contractText).toContain('data-slide-id');
    expect(contractText).toContain('data-ppt-el');

    const authoring = await client.readResource({ uri: 'htmlppt://authoring' });
    const authoringText = resourceText(authoring.contents, 'htmlppt://authoring');
    expect(authoringText).toContain('htmlppt');

    const example = await client.readResource({ uri: 'htmlppt://example' });
    const exampleText = resourceText(example.contents, 'htmlppt://example');
    expect(exampleText).toContain('data-ppt-runtime="1"');
    expect(exampleText).toContain('data-ppt-chart');
    // The example ships the real presentation runtime, not an empty marker.
    expect(exampleText).toContain(RUNTIME_SOURCE.trim());
    expect(exampleText).not.toContain('<script data-ppt-runtime="1"></script>');
    const exampleValidation = validateDeck(parseDeckHtml(exampleText));
    expect(exampleValidation.valid).toBe(true);
  });

  it('creates, validates, edits, and reads a deck without editor artifacts', async () => {
    const deckPath = join(dir, 'flow.deck.html');

    const created = await callTool('create_deck', {
      path: 'flow.deck.html',
      title: 'MCP flow',
      slides: 2
    });
    expect(created.result.isError).toBeFalsy();
    expect(created.payload).toMatchObject({
      path: deckPath,
      created: true
    });
    expect(typeof created.payload.revision).toBe('string');

    const validated = await callTool('validate_deck', { path: 'flow.deck.html' });
    expect(validated.payload).toMatchObject({
      path: deckPath,
      valid: true,
      errors: []
    });

    const added = await callTool('add_slide', {
      path: 'flow.deck.html',
      html: '<h2 data-ppt-el="e-added">Added slide</h2>',
      transition: 'fade'
    });
    expect(added.result.isError).toBeFalsy();
    const slideId = added.payload.slideId;
    expect(typeof slideId).toBe('string');
    expect(added.payload.revision).not.toBe(created.payload.revision);

    const edited = await callTool('set_text', {
      path: 'flow.deck.html',
      slideId,
      target: { elementId: 'e-added' },
      text: 'Edited by MCP'
    });
    expect(edited.result.isError).toBeFalsy();

    const read = await callTool('read_slide', {
      path: 'flow.deck.html',
      slideId
    });
    expect(read.result.isError).toBeFalsy();
    expect(read.payload.slide).toMatchObject({
      id: slideId,
      transition: 'fade',
      width: 1600,
      height: 900
    });
    expect((read.payload.slide as { html: string }).html).toContain(
      'Edited by MCP'
    );

    const outline = await callTool('get_outline', { path: 'flow.deck.html' });
    expect((outline.payload.outline as { slideCount: number }).slideCount).toBe(3);

    const element = await callTool('get_element', {
      path: 'flow.deck.html',
      slideId,
      target: { elementId: 'e-added' }
    });
    expect(element.payload).toMatchObject({
      path: deckPath,
      html: '<h2 data-ppt-el="e-added">Edited by MCP</h2>',
      style: null
    });

    const saved = await readFile(deckPath, 'utf8');
    expect(saved).toContain('Edited by MCP');
    expect(saved).not.toContain('data-ppt-editing');
    expect(saved).not.toContain('data-ppt-frame-slide');
    const savedDocument = parseDeckHtml(saved);
    expect(validateDeck(savedDocument).valid).toBe(true);
    const savedIds = Array.from(
      savedDocument.querySelectorAll('[data-slide-id]')
    ).map((slide) => slide.getAttribute('data-slide-id'));
    expect(savedIds).toEqual(['s1', 's2', 's3']);
    expect(new Set(savedIds).size).toBe(savedIds.length);

    const exported = await callTool('export_deck', {
      path: 'flow.deck.html',
      format: 'html'
    });
    expect(exported.result.isError).toBeFalsy();
    const exportPath = join(dir, 'flow.deck.export.html');
    expect(exported.payload).toMatchObject({
      path: deckPath,
      format: 'html',
      outputPath: exportPath
    });
    const exportedHtml = await readFile(exportPath, 'utf8');
    expect(exportedHtml).toContain('<!-- Edited with htmlppt.');
    expect(exportedHtml).toContain('Edited by MCP');
    const exportedDocument = parseDeckHtml(exportedHtml);
    const exportValidation = validateDeck(exportedDocument);
    expect(exportValidation.errors).toEqual([]);
    expect(exportValidation.valid).toBe(true);
    expect(
      exportedDocument.querySelectorAll('[data-slide-id]')
    ).toHaveLength(3);
  });

  it('adds an image and a table, then updates a chart through direct stdio', async () => {
    const relativePath = 'objects.deck.html';
    const deckPath = join(dir, relativePath);
    const created = await callTool('create_deck', {
      path: relativePath,
      html: deckHtmlWithChart('MCP objects', 1, 'chart')
    });
    expect(created.result.isError).toBeFalsy();

    const image = await callTool('add_image', {
      path: relativePath,
      slideId: 's1',
      source: TINY_PNG_DATA_URL,
      width: 320,
      target: { elementId: 'chart' }
    });
    expect(image.result.isError).toBeFalsy();
    expect(image.payload).toMatchObject({ path: deckPath });
    expect(typeof image.payload.revision).toBe('string');
    expect(typeof image.payload.elementId).toBe('string');

    let document = await readDeckAt(deckPath);
    const imageElement = document.querySelector(
      `img[data-ppt-el="${String(image.payload.elementId)}"]`
    ) as HTMLImageElement | null;
    expect(imageElement?.getAttribute('src')).toBe(TINY_PNG_DATA_URL);
    expect(imageElement?.style.position).toBe('absolute');
    expect(imageElement?.style.left).toBe('100px');
    expect(imageElement?.style.top).toBe('100px');
    expect(imageElement?.style.width).toBe('320px');
    expect(imageElement?.style.height).toBe('180px');
    expect(imageElement?.style.objectFit).toBe('fill');
    // The chart was the direct-child anchor; the image follows it.
    expect(document.querySelector('figure[data-ppt-el="chart"]')?.nextElementSibling)
      .toBe(imageElement);
    expect(await readFile(deckPath, 'utf8')).toContain(
      'data:image/png;base64,'
    );

    // Remote URLs are validated and stored verbatim, never fetched. The
    // default geometry is 480x270 and follows the 16:9 ratio.
    const remoteSource = 'https://example.invalid/remote-image.png';
    const remote = await callTool('add_image', {
      path: relativePath,
      slideId: 's1',
      source: remoteSource
    });
    expect(remote.result.isError).toBeFalsy();
    document = await readDeckAt(deckPath);
    const remoteImage = document.querySelector(
      `img[data-ppt-el="${String(remote.payload.elementId)}"]`
    ) as HTMLImageElement | null;
    expect(remoteImage?.getAttribute('src')).toBe(remoteSource);
    expect(remoteImage?.style.width).toBe('480px');
    expect(remoteImage?.style.height).toBe('270px');

    const table = await callTool('add_table', {
      path: relativePath,
      slideId: 's1',
      rows: 2,
      columns: 3,
      target: { elementId: String(image.payload.elementId) }
    });
    expect(table.result.isError).toBeFalsy();
    expect(table.payload).toMatchObject({ path: deckPath });
    expect(typeof table.payload.elementId).toBe('string');

    document = await readDeckAt(deckPath);
    const tableElement = document.querySelector(
      `table[data-ppt-el="${String(table.payload.elementId)}"]`
    ) as HTMLTableElement | null;
    expect(tableElement?.tagName).toBe('TABLE');
    expect(tableElement?.style.left).toBe('100px');
    expect(tableElement?.style.top).toBe('100px');
    expect(tableElement?.style.width).toBe('960px');
    const rows = Array.from(tableElement?.querySelectorAll('tr') ?? []);
    expect(rows).toHaveLength(2);
    expect(rows[0]?.querySelectorAll('th')).toHaveLength(3);
    expect(rows[1]?.querySelectorAll('td')).toHaveLength(3);
    expect(rows[0]?.querySelector('th')?.getAttribute('scope')).toBe('col');
    const anchorImage = document.querySelector(
      `img[data-ppt-el="${String(image.payload.elementId)}"]`
    );
    expect(anchorImage?.nextElementSibling).toBe(tableElement);

    const chart = await callTool('update_chart', {
      path: relativePath,
      slideId: 's1',
      target: { elementId: 'chart' },
      chart: JSON.stringify({
        type: 'line',
        title: 'Trend',
        labels: ['A', 'B', 'C'],
        series: [
          { name: 'Actual', values: [3, 2, 1] },
          { name: 'Plan', values: [1, 2, 3] }
        ],
        legend: true
      })
    });
    expect(chart.result.isError).toBeFalsy();
    expect(chart.payload).toMatchObject({ path: deckPath, width: 640, height: 360 });
    expect(typeof chart.payload.revision).toBe('string');

    document = await readDeckAt(deckPath);
    const figure = document.querySelector('figure[data-ppt-el="chart"]');
    const data = JSON.parse(
      figure?.getAttribute('data-ppt-chart') ?? '{}'
    ) as {
      type?: unknown;
      title?: unknown;
      labels?: unknown;
      series?: Array<{ values?: unknown }>;
      legend?: unknown;
    };
    expect(data).toMatchObject({
      type: 'line',
      title: 'Trend',
      labels: ['A', 'B', 'C'],
      legend: true
    });
    expect(data.series?.map((series) => series.values)).toEqual([
      [3, 2, 1],
      [1, 2, 3]
    ]);
    const svg = figure?.querySelector('svg');
    expect(svg?.getAttribute('viewBox')).toBe('0 0 640 360');
    expect(svg?.querySelectorAll('polyline')).toHaveLength(2);
    expect(validateDeck(document).valid).toBe(true);
  });

  it('embeds a local image path as a data URL without modifying the file', async () => {
    const relativePath = 'local-image.deck.html';
    const deckPath = join(dir, relativePath);
    const created = await callTool('create_deck', {
      path: relativePath,
      title: 'Local image',
      slides: 1
    });
    expect(created.result.isError).toBeFalsy();

    const imagePath = join(dir, 'pixel.svg');
    await writeFile(imagePath, TINY_SVG, 'utf8');
    const originalBytes = await readFile(imagePath);

    const added = await callTool('add_image', {
      path: relativePath,
      slideId: 's1',
      source: 'pixel.svg',
      width: 240
    });
    expect(added.result.isError).toBeFalsy();

    const document = await readDeckAt(deckPath);
    const image = document.querySelector(
      `img[data-ppt-el="${String(added.payload.elementId)}"]`
    ) as HTMLImageElement | null;
    const source = image?.getAttribute('src') ?? '';
    expect(source).toMatch(/^data:image\/svg\+xml;base64,/);
    expect(
      Buffer.from(source.split(',')[1] ?? '', 'base64').toString('utf8')
    ).toBe(TINY_SVG);
    expect(image?.style.width).toBe('240px');
    expect(image?.style.height).toBe('135px');
    expect(await readFile(imagePath)).toEqual(originalBytes);
  });

  it('rejects oversized and unsupported local images without writing', async () => {
    const relativePath = 'bad-image.deck.html';
    const deckPath = join(dir, relativePath);
    const created = await callTool('create_deck', {
      path: relativePath,
      title: 'Bad image',
      slides: 1
    });
    expect(created.result.isError).toBeFalsy();
    const before = await readFile(deckPath);
    const outlineBefore = await callTool('get_outline', { path: relativePath });
    const revisionBefore = outlineBefore.payload.revision;

    const oversizedPath = join(dir, 'oversized.png');
    await writeFile(oversizedPath, Buffer.alloc(MAX_IMAGE_BYTES + 1));
    const oversized = await callTool('add_image', {
      path: relativePath,
      slideId: 's1',
      source: 'oversized.png'
    });
    expect(oversized.result.isError).toBe(true);
    expect(oversized.payload).toMatchObject({
      code: 'invalid-image',
      path: deckPath
    });
    expect(String(oversized.payload.message)).toContain('8 MB');
    expect(String(oversized.payload.message)).toContain(
      'Resize or compress'
    );

    await writeFile(join(dir, 'unsupported.bmp'), Buffer.from('not an image'));
    const unsupported = await callTool('add_image', {
      path: relativePath,
      slideId: 's1',
      source: 'unsupported.bmp'
    });
    expect(unsupported.result.isError).toBe(true);
    expect(unsupported.payload).toMatchObject({
      code: 'invalid-image',
      path: deckPath
    });
    expect(String(unsupported.payload.message)).toContain(
      'Unsupported image file type'
    );
    expect(String(unsupported.payload.message)).toContain('PNG, JPEG');

    expect(await readFile(deckPath)).toEqual(before);
    const outlineAfter = await callTool('get_outline', { path: relativePath });
    expect(outlineAfter.payload.revision).toBe(revisionBefore);
  });

  it('reports local image open, stat, and read failures as invalid-image', async () => {
    const relativePath = 'image-failures.deck.html';
    const deckPath = join(dir, relativePath);
    const created = await callTool('create_deck', {
      path: relativePath,
      title: 'Image failures',
      slides: 1
    });
    expect(created.result.isError).toBeFalsy();
    const before = await readFile(deckPath);
    const revisionBefore = (
      await callTool('get_outline', { path: relativePath })
    ).payload.revision;

    // A directory with an image extension is opened and fstat'ed but rejected
    // as a non-regular file. The old stat-then-readFile sequence also had a
    // path where a successful stat was followed by a failing read; this proves
    // the descriptor-based path keeps every failure inside invalid-image.
    await mkdir(join(dir, 'directory.png'));
    const directory = await callTool('add_image', {
      path: relativePath,
      slideId: 's1',
      source: 'directory.png'
    });
    expect(directory.result.isError).toBe(true);
    expect(directory.payload).toMatchObject({
      code: 'invalid-image',
      path: deckPath
    });
    expect(String(directory.payload.message)).toContain('directory.png');
    expect(String(directory.payload.message)).toContain('not a file');
    expect(String(directory.payload.message)).not.toContain('file-unreadable');

    // A file that disappears is an image error naming the image path, not a
    // deck file-not-found error.
    const deletedPath = join(dir, 'deleted.png');
    await writeFile(deletedPath, TINY_SVG, 'utf8');
    await rm(deletedPath);
    const deleted = await callTool('add_image', {
      path: relativePath,
      slideId: 's1',
      source: 'deleted.png'
    });
    expect(deleted.result.isError).toBe(true);
    expect(deleted.payload).toMatchObject({
      code: 'invalid-image',
      path: deckPath
    });
    expect(String(deleted.payload.message)).toContain('Image file not found');
    expect(String(deleted.payload.message)).toContain('deleted.png');

    await writeFile(join(dir, 'empty.png'), Buffer.alloc(0));
    const empty = await callTool('add_image', {
      path: relativePath,
      slideId: 's1',
      source: 'empty.png'
    });
    expect(empty.result.isError).toBe(true);
    expect(empty.payload).toMatchObject({
      code: 'invalid-image',
      path: deckPath
    });
    expect(String(empty.payload.message)).toContain('is empty');

    expect(await readFile(deckPath)).toEqual(before);
    const outlineAfter = await callTool('get_outline', { path: relativePath });
    expect(outlineAfter.payload.revision).toBe(revisionBefore);
  });

  it('rejects UNC, protocol-relative, and drive-relative image sources', async () => {
    const relativePath = 'image-sources.deck.html';
    const deckPath = join(dir, relativePath);
    const created = await callTool('create_deck', {
      path: relativePath,
      title: 'Image sources',
      slides: 1
    });
    expect(created.result.isError).toBeFalsy();
    const before = await readFile(deckPath);
    const revisionBefore = (
      await callTool('get_outline', { path: relativePath })
    ).payload.revision;

    // Neither form is a local file. URL validation rejects them before any
    // filesystem access, so a Windows UNC share is never contacted.
    for (const source of ['//server/share/pixel.png', '\\\\server\\share\\pixel.png']) {
      const result = await callTool('add_image', {
        path: relativePath,
        slideId: 's1',
        source
      });
      expect(result.result.isError).toBe(true);
      expect(result.payload).toMatchObject({
        code: 'invalid-image',
        path: deckPath
      });
      expect(String(result.payload.message)).toContain('absolute http(s) URL');
    }

    // A single-letter drive prefix is a local path, not a `c:` URL.
    const driveRelative = `C:htmlppt-missing-${randomUUID()}.png`;
    const drive = await callTool('add_image', {
      path: relativePath,
      slideId: 's1',
      source: driveRelative
    });
    expect(drive.result.isError).toBe(true);
    expect(drive.payload).toMatchObject({
      code: 'invalid-image',
      path: deckPath
    });
    expect(String(drive.payload.message)).toContain('Image file not found');
    expect(String(drive.payload.message)).not.toContain(
      'Image URLs must use http:'
    );

    // Missing and empty-string sources are schema failures; whitespace reaches
    // the handler and is an invalid-image domain error.
    await expectInvalidArguments('add_image', {
      path: relativePath,
      slideId: 's1',
      source: ''
    });
    const blank = await callTool('add_image', {
      path: relativePath,
      slideId: 's1',
      source: '   '
    });
    expect(blank.result.isError).toBe(true);
    expect(blank.payload).toMatchObject({
      code: 'invalid-image',
      path: deckPath
    });
    expect(String(blank.payload.message)).toContain('Choose an image');

    // A sub-pixel width used to pass `positive()` and then fail in core with
    // invalid-insert; the schema now rejects it before the handler runs.
    await expectInvalidArguments('add_image', {
      path: relativePath,
      slideId: 's1',
      source: TINY_PNG_DATA_URL,
      width: 0.5
    });

    expect(await readFile(deckPath)).toEqual(before);
    const outlineAfter = await callTool('get_outline', { path: relativePath });
    expect(outlineAfter.payload.revision).toBe(revisionBefore);
  });

  it('preserves a 640x140 chart figure when updating chart data', async () => {
    const relativePath = 'short-chart.deck.html';
    const deckPath = join(dir, relativePath);
    const created = await callTool('create_deck', {
      path: relativePath,
      html: deckHtmlWithChart('Short chart', 1, 'short-chart', 640, 140)
    });
    expect(created.result.isError).toBeFalsy();

    const updated = await callTool('update_chart', {
      path: relativePath,
      slideId: 's1',
      target: { elementId: 'short-chart' },
      chart: {
        type: 'line',
        title: 'Short trend',
        labels: ['A', 'B'],
        series: [{ name: 'Series 1', values: [1, 2] }]
      }
    });
    expect(updated.result.isError).toBeFalsy();
    expect(updated.payload).toMatchObject({
      path: deckPath,
      width: 640,
      height: 140
    });

    const document = await readDeckAt(deckPath);
    const figure = document.querySelector('figure[data-ppt-el="short-chart"]');
    expect(figure?.querySelector('svg')?.getAttribute('viewBox')).toBe(
      '0 0 640 140'
    );
    expect(validateDeck(document).valid).toBe(true);
  });

  it('returns structured table and chart errors without writing', async () => {
    const relativePath = 'bad-objects.deck.html';
    const deckPath = join(dir, relativePath);
    const created = await callTool('create_deck', {
      path: relativePath,
      html: deckHtmlWithChart('Bad objects', 1, 'chart')
    });
    expect(created.result.isError).toBeFalsy();
    const before = await readFile(deckPath);
    const outlineBefore = await callTool('get_outline', { path: relativePath });
    const revisionBefore = outlineBefore.payload.revision;

    for (const args of [
      { rows: 0, columns: 2 },
      { rows: 2, columns: 51 },
      { rows: 2, columns: 0 }
    ]) {
      const table = await callTool('add_table', {
        path: relativePath,
        slideId: 's1',
        ...args
      });
      expect(table.result.isError).toBe(true);
      expect(table.payload).toMatchObject({
        code: 'invalid-table',
        path: deckPath
      });
      expect(String(table.payload.message).trim().length).toBeGreaterThan(0);
    }

    for (const chart of [
      '{"type":"bar",',
      '{"type":"bar","labels":["A","B"],"series":[{"name":"S","values":[1]}]}',
      '{"type":"scatter","labels":["A"],"series":[{"name":"S","values":[1]}]}'
    ]) {
      const updated = await callTool('update_chart', {
        path: relativePath,
        slideId: 's1',
        target: { elementId: 'chart' },
        chart
      });
      expect(updated.result.isError).toBe(true);
      expect(updated.payload).toMatchObject({
        code: 'invalid-chart',
        path: deckPath
      });
      expect(String(updated.payload.message)).toMatch(
        /chart|JSON|labels|values/i
      );
    }

    const nonChart = await callTool('update_chart', {
      path: relativePath,
      slideId: 's1',
      target: { elementId: 'e1' },
      chart: {
        type: 'bar',
        labels: ['A'],
        series: [{ name: 'S', values: [1] }]
      }
    });
    expect(nonChart.result.isError).toBe(true);
    expect(nonChart.payload).toMatchObject({
      code: 'not-a-chart',
      path: deckPath
    });

    // e1 is nested inside the template's slide-inner wrapper, not a direct
    // child of the slide, so it is not a valid insertion anchor.
    const nestedAnchor = await callTool('add_image', {
      path: relativePath,
      slideId: 's1',
      source: TINY_PNG_DATA_URL,
      target: { elementId: 'e1' }
    });
    expect(nestedAnchor.result.isError).toBe(true);
    expect(nestedAnchor.payload).toMatchObject({
      code: 'target-invalid',
      path: deckPath
    });

    expect(await readFile(deckPath)).toEqual(before);
    const outlineAfter = await callTool('get_outline', { path: relativePath });
    expect(outlineAfter.payload.revision).toBe(revisionBefore);
  });


  it('reports a conflict after an external write and leaves the file unchanged', async () => {
    const deckPath = join(dir, 'conflict.deck.html');
    const created = await callTool('create_deck', {
      path: 'conflict.deck.html',
      title: 'MCP conflict',
      slides: 1
    });
    expect(created.result.isError).toBeFalsy();

    const read = await callTool('get_outline', {
      path: 'conflict.deck.html'
    });
    expect(read.result.isError).toBeFalsy();

    const external = (await readFile(deckPath, 'utf8')).replace(
      'MCP conflict',
      'External edit'
    );
    await writeFile(deckPath, external, 'utf8');
    const externalBytes = await readFile(deckPath);

    const edited = await callTool('set_text', {
      path: 'conflict.deck.html',
      slideId: 's1',
      target: { elementId: 'e1' },
      text: 'MCP must not win'
    });
    expect(edited.result.isError).toBe(true);
    expect(edited.payload).toMatchObject({
      code: 'conflict',
      path: deckPath
    });
    expect(String(edited.payload.message)).toContain('Re-read');
    expect(await readFile(deckPath)).toEqual(externalBytes);
  });

  it('refuses to overwrite an existing deck through create_deck', async () => {
    const deckPath = join(dir, 'twice.deck.html');
    const first = await callTool('create_deck', {
      path: 'twice.deck.html',
      title: 'First deck',
      slides: 1
    });
    expect(first.result.isError).toBeFalsy();
    const original = await readFile(deckPath, 'utf8');

    const second = await callTool('create_deck', {
      path: 'twice.deck.html',
      title: 'Second deck',
      slides: 1
    });
    expect(second.result.isError).toBe(true);
    expect(second.payload).toMatchObject({
      code: 'file-exists',
      path: deckPath
    });
    expect(await readFile(deckPath, 'utf8')).toBe(original);
    const leftovers = (await readdir(dir)).filter((name) =>
      name.endsWith('.htmlppt.tmp')
    );
    expect(leftovers).toEqual([]);
  });

  it('attaches to a live host session, reports mcp revisions, then falls back', async () => {
    const hostedDir = join(dir, 'hosted');
    await mkdir(hostedDir, { recursive: true });
    const deckPath = await copyFixture('basic.deck.html', hostedDir);
    const hostedEditorDir = join(dir, 'hosted-editor');
    await mkdir(hostedEditorDir, { recursive: true });
    await writeFile(
      join(hostedEditorDir, 'index.html'),
      '<!doctype html><title>Editor</title><div id="root">editor-shell</div>',
      'utf8'
    );
    const token = randomUUID();
    const host = await startHost({
      filePath: deckPath,
      token,
      editorDir: hostedEditorDir,
      port: 0
    });
    const base = new URL(host.url).origin;
    const authorization = { authorization: `Bearer ${token}` };
    let events: SseStream | undefined;
    try {
      const health = await fetch(`${base}/api/health`, {
        headers: authorization
      });
      expect(health.status).toBe(200);
      const initial = (await health.json()) as { revision: string };
      await writeSession({
        path: deckPath,
        port: host.port,
        token,
        pid: process.pid,
        startedAt: new Date().toISOString(),
        revision: initial.revision
      });

      const eventsResponse = await fetchEventStream(
        `${base}/api/events?token=${encodeURIComponent(token)}`
      );
      expect(eventsResponse.status).toBe(200);
      events = openEventStream(eventsResponse);
      expect((await events.next()).event).toBe('hello');

      const relativePath = join('hosted', 'basic.deck.html');
      const edited = await callTool('set_text', {
        path: relativePath,
        slideId: 's1',
        target: { elementId: 'e1' },
        text: 'Edited through the live host'
      });
      expect(edited.result.isError).toBeFalsy();
      const revision = edited.payload.revision;
      expect(typeof revision).toBe('string');
      expect(revision).not.toBe(initial.revision);

      expect(await readFile(deckPath, 'utf8')).toContain(
        'Edited through the live host'
      );
      const deckResponse = await fetch(`${base}/api/deck`, {
        headers: authorization
      });
      expect(await deckResponse.json()).toMatchObject({ revision });
      expect(await events.next()).toEqual({
        event: 'revision',
        data: { revision, source: 'mcp', filePath: deckPath }
      });

      await events.close();
      events = undefined;
      await host.close();

      const again = await callTool('set_text', {
        path: relativePath,
        slideId: 's2',
        target: { elementId: 'e3' },
        text: 'Written after the host stopped'
      });
      expect(again.result.isError).toBeFalsy();
      expect(again.payload.revision).not.toBe(revision);
      expect(await readFile(deckPath, 'utf8')).toContain(
        'Written after the host stopped'
      );
      await expect(
        readFile(
          join(sessionsDirectory(), `${sessionKey(deckPath)}.json`),
          'utf8'
        )
      ).rejects.toMatchObject({ code: 'ENOENT' });
    } finally {
      await events?.close();
      await host.close();
    }
  });

  it('applies asset, table, and chart tools through a live host', async () => {
    const hostedDir = join(dir, 'hosted-tools');
    await mkdir(hostedDir, { recursive: true });
    const deckPath = join(hostedDir, 'hosted-tools.deck.html');
    const relativePath = join('hosted-tools', 'hosted-tools.deck.html');
    const created = await callTool('create_deck', {
      path: relativePath,
      html: deckHtmlWithChart('Hosted tools', 1, 'chart')
    });
    expect(created.result.isError).toBeFalsy();

    const imagePath = join(hostedDir, 'hosted.svg');
    await writeFile(imagePath, TINY_SVG, 'utf8');

    const hostedEditorDir = join(dir, 'hosted-tools-editor');
    await mkdir(hostedEditorDir, { recursive: true });
    await writeFile(
      join(hostedEditorDir, 'index.html'),
      '<!doctype html><title>Editor</title><div id="root">editor-shell</div>',
      'utf8'
    );
    const token = randomUUID();
    const host = await startHost({
      filePath: deckPath,
      token,
      editorDir: hostedEditorDir,
      port: 0
    });
    const base = new URL(host.url).origin;
    const authorization = { authorization: `Bearer ${token}` };
    let events: SseStream | undefined;
    try {
      const health = await fetch(`${base}/api/health`, {
        headers: authorization
      });
      expect(health.status).toBe(200);
      const initial = (await health.json()) as { revision: string };
      await writeSession({
        path: deckPath,
        port: host.port,
        token,
        pid: process.pid,
        startedAt: new Date().toISOString(),
        revision: initial.revision
      });

      const eventsResponse = await fetchEventStream(
        `${base}/api/events?token=${encodeURIComponent(token)}`
      );
      expect(eventsResponse.status).toBe(200);
      events = openEventStream(eventsResponse);
      expect((await events.next()).event).toBe('hello');

      const calls: Array<{ name: string; args: Record<string, unknown> }> = [
        {
          name: 'add_image',
          args: {
            path: relativePath,
            slideId: 's1',
            source: join('hosted-tools', 'hosted.svg'),
            width: 240
          }
        },
        {
          name: 'add_table',
          args: {
            path: relativePath,
            slideId: 's1',
            rows: 2,
            columns: 2
          }
        },
        {
          name: 'update_chart',
          args: {
            path: relativePath,
            slideId: 's1',
            target: { elementId: 'chart' },
            chart: {
              type: 'pie',
              title: 'Hosted update',
              labels: ['Yes', 'No'],
              series: [{ name: 'Votes', values: [7, 3] }]
            }
          }
        }
      ];

      for (const call of calls) {
        const { result, payload } = await callTool(call.name, call.args);
        expect(
          result.isError,
          `${call.name} failed: ${JSON.stringify(payload)}`
        ).toBeFalsy();
        const revision = payload.revision;
        expect(typeof revision).toBe('string');

        const deckResponse = await fetch(`${base}/api/deck`, {
          headers: authorization
        });
        expect(deckResponse.status).toBe(200);
        expect(await deckResponse.json()).toMatchObject({ revision });
        expect(await events.next()).toEqual({
          event: 'revision',
          data: { revision, source: 'mcp', filePath: deckPath }
        });
      }

      const html = await readFile(deckPath, 'utf8');
      expect(html).toContain('data:image/svg+xml;base64,');
      expect(html).not.toContain('hosted.svg');
      const document = parseDeckHtml(html);
      const image = document.querySelector('img');
      expect(image?.getAttribute('src')).toMatch(
        /^data:image\/svg\+xml;base64,/
      );
      expect(image?.style.width).toBe('240px');
      expect(document.querySelectorAll('table tr')).toHaveLength(2);
      const figure = document.querySelector(
        'figure[data-ppt-el="chart"]'
      );
      const data = JSON.parse(
        figure?.getAttribute('data-ppt-chart') ?? '{}'
      ) as { type?: unknown; title?: unknown };
      expect(data).toMatchObject({ type: 'pie', title: 'Hosted update' });
      expect(figure?.querySelector('svg')).not.toBeNull();
      expect(validateDeck(document).valid).toBe(true);
    } finally {
      await events?.close();
      await host.close();
    }
  });

  it('returns object-tool failures and a revision conflict through a live host', async () => {
    const hostedDir = join(dir, 'hosted-errors');
    await mkdir(hostedDir, { recursive: true });
    const deckPath = join(hostedDir, 'hosted-errors.deck.html');
    const relativePath = join('hosted-errors', 'hosted-errors.deck.html');
    const created = await callTool('create_deck', {
      path: relativePath,
      html: deckHtmlWithChart('Hosted errors', 1, 'chart')
    });
    expect(created.result.isError).toBeFalsy();

    const hostedEditorDir = join(dir, 'hosted-errors-editor');
    await mkdir(hostedEditorDir, { recursive: true });
    await writeFile(
      join(hostedEditorDir, 'index.html'),
      '<!doctype html><title>Editor</title><div id="root">editor-shell</div>',
      'utf8'
    );
    const token = randomUUID();
    const host = await startHost({
      filePath: deckPath,
      token,
      editorDir: hostedEditorDir,
      port: 0
    });
    const base = new URL(host.url).origin;
    const authorization = { authorization: `Bearer ${token}` };
    let events: SseStream | undefined;
    try {
      const health = await fetch(`${base}/api/health`, {
        headers: authorization
      });
      expect(health.status).toBe(200);
      const initial = (await health.json()) as { revision: string };
      await writeSession({
        path: deckPath,
        port: host.port,
        token,
        pid: process.pid,
        startedAt: new Date().toISOString(),
        revision: initial.revision
      });

      const eventsResponse = await fetchEventStream(
        `${base}/api/events?token=${encodeURIComponent(token)}`
      );
      expect(eventsResponse.status).toBe(200);
      events = openEventStream(eventsResponse);
      expect((await events.next()).event).toBe('hello');

      const before = await readFile(deckPath);
      const initialRevision = initial.revision;

      // Domain failures inside the mutation run before the host PUT, so each
      // must return its structured code and leave both the file and the host
      // revision untouched.
      const failures = [
        {
          name: 'add_image',
          args: {
            path: relativePath,
            slideId: 's1',
            source: join('hosted-errors', 'missing.png')
          },
          code: 'invalid-image'
        },
        {
          name: 'add_table',
          args: { path: relativePath, slideId: 's1', rows: 0, columns: 2 },
          code: 'invalid-table'
        },
        {
          name: 'update_chart',
          args: {
            path: relativePath,
            slideId: 's1',
            target: { elementId: 'chart' },
            chart: '{"type":"bar",'
          },
          code: 'invalid-chart'
        }
      ];
      for (const failure of failures) {
        const { result, payload } = await callTool(
          failure.name,
          failure.args
        );
        expect(
          result.isError,
          `${failure.name} unexpectedly succeeded: ${JSON.stringify(payload)}`
        ).toBe(true);
        expect(payload).toMatchObject({
          code: failure.code,
          path: deckPath
        });
        expect(String(payload.message).trim().length).toBeGreaterThan(0);
        const deckResponse = await fetch(`${base}/api/deck`, {
          headers: authorization
        });
        expect(await deckResponse.json()).toMatchObject({
          revision: initialRevision
        });
      }
      expect(await readFile(deckPath)).toEqual(before);

      const table = await callTool('add_table', {
        path: relativePath,
        slideId: 's1',
        rows: 2,
        columns: 2
      });
      expect(table.result.isError).toBeFalsy();
      const tableRevision = table.payload.revision;
      expect(typeof tableRevision).toBe('string');
      expect(await events.next()).toEqual({
        event: 'revision',
        data: {
          revision: tableRevision,
          source: 'mcp',
          filePath: deckPath
        }
      });

      // Changing the deck outside the MCP server invalidates the revision it
      // cached after add_table; the next object mutation must report conflict.
      const external = (await readFile(deckPath, 'utf8')).replace(
        'Hosted errors',
        'External host edit'
      );
      await writeFile(deckPath, external, 'utf8');
      const externalBytes = await readFile(deckPath);

      const conflict = await callTool('add_image', {
        path: relativePath,
        slideId: 's1',
        source: TINY_PNG_DATA_URL
      });
      expect(conflict.result.isError).toBe(true);
      expect(conflict.payload).toMatchObject({
        code: 'conflict',
        path: deckPath
      });
      expect(String(conflict.payload.message)).toContain('Re-read');
      expect(typeof conflict.payload.currentRevision).toBe('string');
      expect(await readFile(deckPath)).toEqual(externalBytes);
    } finally {
      await events?.close();
      await host.close();
    }
  });

  it('opens an editor through the CLI and stop cleans up the session', async () => {
    const openDir = join(dir, 'open-editor');
    await mkdir(openDir, { recursive: true });
    const deckPath = await copyFixture('basic.deck.html', openDir);
    const relativePath = join('open-editor', 'basic.deck.html');
    const sessionFilePath = join(
      sessionsDirectory(),
      `${sessionKey(deckPath)}.json`
    );
    let pid: number | undefined;

    try {
      const opened = await callTool('open_editor', {
        path: relativePath,
        open: false
      });

      expect(opened.result.isError).toBeFalsy();
      expect(opened.payload.path).toBe(deckPath);
      const url = new URL(String(opened.payload.url));
      expect(url.protocol).toBe('http:');
      expect(url.hostname).toBe('127.0.0.1');
      expect(url.port).not.toBe('');
      const token = url.searchParams.get('token');
      if (!token) {
        throw new Error('open_editor returned a URL without a token.');
      }

      const health = await fetch(`${url.origin}/api/health`, {
        headers: { authorization: `Bearer ${token}` },
        signal: AbortSignal.timeout(5_000)
      });
      expect(health.status).toBe(200);
      const healthPayload = (await health.json()) as {
        ok?: unknown;
        revision?: unknown;
      };
      expect(healthPayload.ok).toBe(true);
      expect(healthPayload.revision).toMatch(/^[a-f0-9]{64}$/);

      const session = await readSession(sessionFilePath);
      if (!session) {
        throw new Error('open_editor did not write a session entry.');
      }
      expect(session).toMatchObject({
        path: deckPath,
        port: Number(url.port),
        token,
        revision: healthPayload.revision
      });
      expect(session.pid).not.toBe(process.pid);
      pid = session.pid;

      const stopped = await runProcess(
        process.execPath,
        [cliBinPath, 'stop', deckPath],
        {
          cwd: dir,
          env: { ...getDefaultEnvironment(), HTMLPPT_HOME: home }
        }
      );
      expect(stopped.code).toBe(0);
      expect(stopped.stdout).toContain('Stopped editor');
      await expect(readFile(sessionFilePath, 'utf8')).rejects.toMatchObject({
        code: 'ENOENT'
      });
      expect(() => process.kill(session.pid, 0)).toThrow();
    } finally {
      if (pid === undefined) {
        pid = (await readSession(sessionFilePath))?.pid;
      }
      if (pid !== undefined) {
        try {
          process.kill(pid, 'SIGTERM');
        } catch {
          // The stop command already terminated the host.
        }
      }
    }
  });

  it('fails open_editor instead of trusting a live host whose editor shell is broken', async () => {
    const brokenDir = join(dir, 'broken-open');
    await mkdir(brokenDir, { recursive: true });
    const deckPath = await copyFixture('basic.deck.html', brokenDir);
    const relativePath = join('broken-open', 'basic.deck.html');
    const sessionFilePath = join(
      sessionsDirectory(),
      `${sessionKey(deckPath)}.json`
    );
    const fakeHost = await brokenShellHost();
    try {
      const entry = {
        path: deckPath,
        port: fakeHost.port,
        token: 'stale-token',
        pid: process.pid,
        startedAt: new Date().toISOString(),
        revision: 'a'.repeat(64)
      };
      await writeSession(entry);

      const opened = await callTool('open_editor', {
        path: relativePath,
        open: false
      });

      // The CLI refuses to start a second host because the kept entry still
      // has a live pid. Health answering is not proof the URL opens an editor.
      expect(opened.result.isError).toBe(true);
      expect(opened.payload).toMatchObject({
        code: 'editor-failed',
        path: deckPath
      });
      expect(String(opened.payload.message)).toContain('code 1');
      expect(opened.payload.url).toBeUndefined();
      // The kept entry is the recovery handle for `stop`.
      expect(await readSession(sessionFilePath)).toEqual(entry);
      expect(() => process.kill(process.pid, 0)).not.toThrow();
    } finally {
      await fakeHost.close();
    }
  });

  it('ignores a stale live-PID session and returns the newly started host', async () => {
    const staleDir = join(dir, 'stale-open');
    await mkdir(staleDir, { recursive: true });
    const deckPath = await copyFixture('basic.deck.html', staleDir);
    const relativePath = join('stale-open', 'basic.deck.html');
    const sessionFilePath = join(
      sessionsDirectory(),
      `${sessionKey(deckPath)}.json`
    );
    const stalePort = await closedPort();
    await writeSession({
      path: deckPath,
      port: stalePort,
      token: randomUUID(),
      pid: process.pid,
      startedAt: new Date().toISOString(),
      revision: 'a'.repeat(64)
    });
    let pid: number | undefined;

    try {
      const opened = await callTool('open_editor', {
        path: relativePath,
        open: false
      });

      expect(opened.result.isError).toBeFalsy();
      const url = new URL(String(opened.payload.url));
      expect(Number(url.port)).not.toBe(stalePort);
      const token = url.searchParams.get('token');
      if (!token) {
        throw new Error('open_editor returned a URL without a token.');
      }
      const health = await fetch(`${url.origin}/api/health`, {
        headers: { authorization: `Bearer ${token}` },
        signal: AbortSignal.timeout(5_000)
      });
      expect(health.status).toBe(200);

      // The dead registry entry was replaced by the new host.
      const session = await readSession(sessionFilePath);
      if (!session) {
        throw new Error('open_editor did not replace the stale session entry.');
      }
      expect(session).toMatchObject({
        path: deckPath,
        port: Number(url.port),
        token
      });
      expect(session.pid).not.toBe(process.pid);
      pid = session.pid;
    } finally {
      if (pid === undefined) {
        pid = (await readSession(sessionFilePath))?.pid;
      }
      // A broken implementation can leave the stale entry behind; that entry
      // points at this test process, which must never be signalled.
      if (pid !== undefined && pid !== process.pid) {
        try {
          process.kill(pid, 'SIGTERM');
        } catch {
          // The host already stopped.
        }
      }
    }
  });

  it('covers every read-only tool with a happy path and invalid arguments', async () => {
    const relativePath = 'surface-read.deck.html';
    const created = await callTool('create_deck', {
      path: relativePath,
      title: 'Surface read',
      slides: 2
    });
    expect(created.result.isError).toBeFalsy();

    const state = surfaceState(relativePath);
    for (const testCase of READ_TOOL_CASES) {
      const { result, payload } = await callTool(
        testCase.name,
        testCase.args(state)
      );
      expect(
        result.isError,
        `${testCase.name} failed: ${JSON.stringify(payload)}`
      ).toBeFalsy();
      await testCase.verify(state, payload);
    }

    for (const testCase of INVALID_ARGUMENT_CASES) {
      await expectInvalidArguments(testCase.name, testCase.invalidArgs);
    }
  });

  it('covers every mutation tool with durable effects', async () => {
    const relativePath = 'surface-mutations.deck.html';
    const state = surfaceState(relativePath);

    try {
      for (const testCase of MUTATION_TOOL_CASES) {
        const { result, payload } = await callTool(
          testCase.name,
          testCase.args(state)
        );
        expect(
          result.isError,
          `${testCase.name} failed: ${JSON.stringify(payload)}`
        ).toBeFalsy();
        await testCase.verify(state, payload);
      }
    } finally {
      if (state.editorPid !== undefined) {
        const stopped = await runProcess(
          process.execPath,
          [cliBinPath, 'stop', state.deckPath],
          {
            cwd: dir,
            env: { ...getDefaultEnvironment(), HTMLPPT_HOME: home }
          }
        );
        expect(stopped.code).toBe(0);
      }
    }
  });

  it('keeps the tool tables in sync with the registered surface', async () => {
    const covered = [...READ_TOOL_CASES, ...MUTATION_TOOL_CASES]
      .map((testCase) => testCase.name)
      .sort();
    expect(covered).toEqual(EXPECTED_TOOLS);
    expect(INVALID_ARGUMENT_CASES.map((testCase) => testCase.name).sort()).toEqual(
      EXPECTED_TOOLS
    );
  });

  it('matches the reviewed tools/list schema snapshot', async () => {
    const { tools } = await client.listTools();
    const normalized = tools
      .map((tool) => ({
        name: tool.name,
        description: tool.description ?? '',
        inputSchema: tool.inputSchema
      }))
      .sort((left, right) =>
        left.name < right.name ? -1 : left.name > right.name ? 1 : 0
      );

    const snapshot: unknown = JSON.parse(
      await readFile(toolsSnapshotPath, 'utf8')
    );
    expect(normalized).toEqual(snapshot);
  });

  it('documents exactly the registered tool names', async () => {
    const { tools } = await client.listTools();
    const markdown = await readFile(skillToolsDocPath, 'utf8');
    const documented = Array.from(
      markdown.matchAll(/^### `([a-z][a-z0-9_]*)`$/gm),
      (match) => match[1]
    ).sort();

    expect(documented).toEqual(tools.map((tool) => tool.name).sort());
  });

  it('distinguishes schema failures from domain failures', async () => {
    const deckPath = await copyFixture('basic.deck.html', dir);

    // Observed SDK behavior: the InvalidParams code is wrapped in an isError
    // text result before the handler runs, so there is no structured payload.
    const schema = (await client.callTool({
      name: 'set_text',
      arguments: {
        path: deckPath,
        slideId: 's1',
        target: { elementId: 'e1' }
      }
    })) as ToolResult;
    expect(schema.isError).toBe(true);
    const schemaText = schema.content?.[0]?.text ?? '';
    expect(schemaText).toContain(`MCP error ${ErrorCode.InvalidParams}`);
    expect(schemaText).toContain('Invalid arguments for tool set_text');
    expect(() => resultPayload(schema)).toThrow();

    const domain = await callTool('read_slide', {
      path: deckPath,
      slideId: 'missing-slide'
    });
    expect(domain.result.isError).toBe(true);
    expect(domain.payload).toMatchObject({
      code: 'slide-not-found',
      path: deckPath
    });
  });
});
