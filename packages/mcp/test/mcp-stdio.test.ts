import { spawn } from 'node:child_process';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateDeck } from '@htmlppt/core';
import { parseDeckHtml } from '@htmlppt/core/node';
import { makeTempDir } from '@htmlppt/test-utils';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import {
  getDefaultEnvironment,
  StdioClientTransport
} from '@modelcontextprotocol/sdk/client/stdio.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const repoRoot = fileURLToPath(new URL('../../..', import.meta.url));
const packageRoot = join(repoRoot, 'packages', 'mcp');
const binPath = join(packageRoot, 'dist', 'bin.js');

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
let client: Client;
let transport: StdioClientTransport;

function runNpm(args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.platform === 'win32' ? 'npm.cmd' : 'npm', args, {
      cwd: repoRoot,
      stdio: ['ignore', 'pipe', 'pipe'],
      shell: process.platform === 'win32'
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
          `npm ${args.join(' ')} failed with exit code ${code}:\n${output}`
        )
      );
    });
  });
}

async function buildWorkspace(): Promise<void> {
  for (const workspace of [
    '@htmlppt/runtime',
    '@htmlppt/core',
    '@htmlppt/host',
    '@htmlppt/mcp'
  ]) {
    await runNpm(['run', 'build', '-w', workspace]);
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
    const savedSlides = Array.from(savedDocument.querySelectorAll('[data-slide-id]'));
    expect(savedSlides).toHaveLength(3);
    for (const slide of savedSlides) {
      expect(slide.getAttribute('data-slide-id')?.trim()).toBeTruthy();
    }

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
});
