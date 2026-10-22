import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateDeck } from '@htmlppt/core';
import { parseDeckHtml } from '@htmlppt/core/node';
import {
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
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { openEventStream, type SseStream } from './sse.js';

const repoRoot = fileURLToPath(new URL('../../..', import.meta.url));
const packageRoot = join(repoRoot, 'packages', 'mcp');
const binPath = join(packageRoot, 'dist', 'bin.js');
const tsupCli = createRequire(import.meta.url).resolve(
  'tsup/dist/cli-default.js'
);

const EXPECTED_TOOLS = [
  'add_element',
  'add_slide',
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
  'update_slide_html',
  'validate_deck'
];

const RESOURCE_URIS = [
  'htmlppt://contract',
  'htmlppt://authoring',
  'htmlppt://example'
];

let dir: string;
let home: string;
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
  { workspace: 'mcp', args: [] }
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

beforeAll(async () => {
  await buildWorkspace();
  dir = await makeTempDir('htmlppt-mcp-stdio-');
  home = join(dir, 'home');
  await mkdir(home, { recursive: true });
  previousHome = process.env.HTMLPPT_HOME;
  process.env.HTMLPPT_HOME = home;
  transport = new StdioClientTransport({
    command: process.execPath,
    args: [binPath],
    cwd: dir,
    env: {
      ...getDefaultEnvironment(),
      HTMLPPT_HOME: home
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
  it('completes the initialize handshake and lists every tool', async () => {
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
    expect(properties?.format).toMatchObject({ const: 'html' });
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
    const editorDir = join(dir, 'hosted-editor');
    await mkdir(editorDir, { recursive: true });
    await writeFile(
      join(editorDir, 'index.html'),
      '<!doctype html><title>Editor</title><div id="root">editor-shell</div>',
      'utf8'
    );
    const token = randomUUID();
    const host = await startHost({
      filePath: deckPath,
      token,
      editorDir,
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

      const eventsResponse = await fetch(
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
        data: { revision, source: 'mcp' }
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
});
