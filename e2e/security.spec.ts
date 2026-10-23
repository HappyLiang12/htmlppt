import { randomUUID } from 'node:crypto';
import { realpathSync } from 'node:fs';
import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile
} from 'node:fs/promises';
import {
  createServer,
  request as httpRequest,
  type IncomingHttpHeaders
} from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import {
  getDefaultEnvironment,
  StdioClientTransport
} from '@modelcontextprotocol/sdk/client/stdio.js';
import { expect, test, type Page } from '@playwright/test';
import { execa } from 'execa';
import { PNG } from 'pngjs';
import { startCliHost } from './helpers';

const repoRoot = fileURLToPath(new URL('..', import.meta.url));
const cliPath = join(repoRoot, 'packages/cli/dist/bin.js');
const mcpBinPath = join(repoRoot, 'packages/mcp/dist/bin.js');
const CANVAS_FRAME = 'iframe[title="投影片預覽"]';
const PLAY_FRAME = '[data-testid="play-frame"]';
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const TINY_PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=';

const SECURITY_DECK = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>Security deck</title>
<style>.slide { width: 320px; height: 180px; background: #ffffff; }</style>
</head>
<body>
<main data-ppt-deck>
<section class="slide" data-slide-id="s1" data-width="320" data-height="180" style="width:320px;height:180px">
<h1 data-ppt-el="e1">Security deck</h1>
</section>
<section class="slide" data-slide-id="s2" data-width="320" data-height="180" style="width:320px;height:180px">
<h2 data-ppt-el="e2">Second security slide</h2>
</section>
</main>
</body>
</html>
`;

const ISOLATION_DECK = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>Isolation deck</title>
<style>.slide { width: 800px; height: 600px; }</style>
</head>
<body>
<main data-ppt-deck>
<section class="slide" data-slide-id="s1" data-width="800" data-height="600" style="width:800px;height:600px">
<h1 data-ppt-el="e1">Isolation check</h1>
<script>window.__deckRan=1</script>
<img src="missing-isolation-image.png" onerror="window.__deckRan=2" alt="">
</section>
<section class="slide" data-slide-id="s2" data-width="800" data-height="600" style="width:800px;height:600px">
<h1 data-ppt-el="e2">Second isolation slide</h1>
</section>
</main>
</body>
</html>
`;

const LINK_DECK = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>Link security deck</title>
<style>.slide { width: 800px; height: 600px; }</style>
</head>
<body>
<main data-ppt-deck>
<section class="slide" data-slide-id="s1" data-width="800" data-height="600" style="width:800px;height:600px">
<h1 data-ppt-el="title" style="position:absolute;left:100px;top:100px;width:600px;height:120px;font-size:48px">Secure link</h1>
</section>
</main>
</body>
</html>
`;

const MCP_DECK = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>MCP security deck</title>
<style>.slide { width: 320px; height: 180px; }</style>
</head>
<body>
<main data-ppt-deck>
<section class="slide" data-slide-id="s1" data-width="320" data-height="180" style="width:320px;height:180px">
<h1 data-ppt-el="e1">MCP security deck</h1>
</section>
<section class="slide" data-slide-id="s2" data-width="320" data-height="180" style="width:320px;height:180px">
<h2 data-ppt-el="e2">Second MCP slide</h2>
</section>
</main>
</body>
</html>
`;

type StartedHost = Awaited<ReturnType<typeof startCliHost>>;

interface RawResponse {
  status: number;
  headers: IncomingHttpHeaders;
  body: string;
}

interface McpToolResult {
  content?: Array<{ type?: string; text?: string }>;
  isError?: boolean;
}

interface McpToolCall {
  result: McpToolResult;
  payload: Record<string, unknown>;
}

interface SseEvent {
  event: string;
  data: unknown;
}

interface SseCursor {
  next(timeoutMs?: number): Promise<SseEvent>;
  close(): Promise<void>;
}

function hostOrigin(url: string): string {
  return new URL(url).origin;
}

function hostToken(url: string): string {
  const token = new URL(url).searchParams.get('token');
  if (!token) throw new Error(`Host URL has no session token: ${url}`);
  return token;
}

function bearer(token: string): Record<string, string> {
  return { authorization: `Bearer ${token}` };
}

/**
 * Starts the real CLI host, temporarily applying environment overrides only
 * while the child process is spawned. The child inherits them; this test
 * process is restored immediately afterwards.
 */
async function startHostWithEnvironment(
  cwd: string,
  file: string,
  environment: Record<string, string>
): Promise<StartedHost> {
  const previous = new Map<string, string | undefined>();
  for (const [key, value] of Object.entries(environment)) {
    previous.set(key, process.env[key]);
    process.env[key] = value;
  }
  try {
    return await startCliHost(cliPath, cwd, file);
  } finally {
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

function canonicalPath(file: string): string {
  const resolved = resolve(file);
  try {
    return realpathSync.native(resolved);
  } catch {
    return resolved;
  }
}

function isInside(root: string, candidate: string): boolean {
  const relativePath = relative(canonicalPath(root), canonicalPath(candidate));
  return (
    relativePath === '' ||
    (!relativePath.startsWith('..') && !isAbsolute(relativePath))
  );
}

/** Sends a path verbatim so WHATWG URL parsing cannot pre-normalize traversal. */
function rawGet(
  origin: string,
  rawPath: string,
  cookie?: string
): Promise<RawResponse> {
  const originUrl = new URL(origin);
  return new Promise((resolvePromise, reject) => {
    const request = httpRequest(
      {
        hostname: originUrl.hostname,
        port: originUrl.port,
        path: rawPath,
        method: 'GET',
        headers: cookie ? { cookie } : undefined,
        timeout: 10_000
      },
      (response) => {
        const chunks: Buffer[] = [];
        response.on('data', (chunk: Buffer) => chunks.push(chunk));
        response.on('end', () =>
          resolvePromise({
            status: response.statusCode ?? 0,
            headers: response.headers,
            body: Buffer.concat(chunks).toString('utf8')
          })
        );
      }
    );
    request.on('timeout', () =>
      request.destroy(new Error(`Raw request timed out: ${rawPath}`))
    );
    request.on('error', reject);
    request.end();
  });
}

async function expectMissing(file: string): Promise<void> {
  await expect(access(file)).rejects.toMatchObject({ code: 'ENOENT' });
}

/**
 * Collects the marker from every same-origin browsing context, starting at
 * the editor shell. A sandbox without allow-scripts must leave each frame's
 * global untouched.
 */
async function deckMarkers(page: Page): Promise<Array<{ frame: string; value: unknown }>> {
  return await page.evaluate(() => {
    interface FrameScope {
      location: { href: string };
      frames: { length: number; [index: number]: FrameScope };
      __deckRan?: unknown;
    }
    const found: Array<{ frame: string; value: unknown }> = [];
    const visit = (scope: FrameScope): void => {
      try {
        if (scope.__deckRan !== undefined) {
          found.push({ frame: scope.location.href, value: scope.__deckRan });
        }
        for (let index = 0; index < scope.frames.length; index += 1) {
          const child = scope.frames[index];
          if (child) visit(child);
        }
      } catch {
        // Non-same-origin frames cannot host a readable marker; the sandbox
        // attributes are asserted separately.
      }
    };
    visit(globalThis as unknown as FrameScope);
    return found;
  });
}

function toolPayload(result: McpToolResult): Record<string, unknown> {
  const text = result.content?.find(
    (item) => item.type === 'text' && typeof item.text === 'string'
  )?.text;
  if (!text) throw new Error('The MCP tool returned no text content.');
  const parsed: unknown = JSON.parse(text);
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error(`The MCP tool payload is not an object: ${text}`);
  }
  return parsed as Record<string, unknown>;
}

async function mcpCall(
  client: Client,
  name: string,
  args: Record<string, unknown>
): Promise<McpToolCall> {
  const result = (await client.callTool({
    name,
    arguments: args
  })) as unknown as McpToolResult;
  return { result, payload: toolPayload(result) };
}

async function connectMcp(
  cwd: string,
  environment: Record<string, string>
): Promise<Client> {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [mcpBinPath],
    cwd,
    env: { ...getDefaultEnvironment(), ...environment },
    stderr: 'pipe'
  });
  const client = new Client({ name: 'htmlppt-security-e2e', version: '0.0.0' });
  try {
    await client.connect(transport);
    return client;
  } catch (error) {
    await client.close().catch(() => undefined);
    throw error;
  }
}

async function openSse(url: string): Promise<SseCursor> {
  const controller = new AbortController();
  const response = await fetch(url, { signal: controller.signal });
  expect(response.status).toBe(200);
  expect(response.headers.get('content-type')).toContain('text/event-stream');
  const body = response.body;
  if (!body) throw new Error('The SSE response has no body.');
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  const next = async (timeoutMs = 5_000): Promise<SseEvent> => {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const boundary = buffer.indexOf('\n\n');
      if (boundary !== -1) {
        const block = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);
        if (block.startsWith(':') || block.trim().length === 0) continue;
        const event = /^event: (.+)$/m.exec(block)?.[1] ?? 'message';
        const raw = block
          .split('\n')
          .filter((line) => line.startsWith('data:'))
          .map((line) => line.slice(5).trimStart())
          .join('\n');
        return {
          event,
          data: raw.length > 0 ? (JSON.parse(raw) as unknown) : null
        };
      }
      const remaining = deadline - Date.now();
      if (remaining <= 0) {
        throw new Error('Timed out waiting for an SSE event.');
      }
      let timer: NodeJS.Timeout | undefined;
      const timeout = new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new Error('Timed out waiting for an SSE event.')),
          remaining
        );
        timer.unref();
      });
      try {
        const chunk = await Promise.race([reader.read(), timeout]);
        if (chunk.done) {
          throw new Error('The SSE stream closed before the expected event.');
        }
        buffer += decoder.decode(chunk.value, { stream: true });
      } finally {
        if (timer) clearTimeout(timer);
      }
    }
  };

  return {
    next,
    async close() {
      await reader.cancel().catch(() => undefined);
      controller.abort();
    }
  };
}

test(
  'editor page rejects missing and wrong tokens and accepts the printed URL',
  { tag: '@feature:live-sync' },
  async ({ page }) => {
    const directory = await mkdtemp(join(tmpdir(), 'htmlppt-security-auth-'));
    let host: StartedHost | undefined;
    try {
      await writeFile(join(directory, 'security.html'), SECURITY_DECK, 'utf8');
      host = await startCliHost(cliPath, directory, 'security.html');
      const origin = hostOrigin(host.url);

      const anonymous = await fetch(`${origin}/`);
      expect(anonymous.status).toBe(401);
      const anonymousBody = await anonymous.text();
      expect(anonymousBody.toLowerCase()).toContain('unauthorized');
      expect(anonymousBody).not.toContain('canvas-preview');

      const wrong = await fetch(`${origin}/?token=${encodeURIComponent('wrong-token')}`);
      expect(wrong.status).toBe(401);
      const wrongBody = await wrong.text();
      expect(wrongBody.toLowerCase()).toContain('unauthorized');
      expect(wrongBody).not.toContain('canvas-preview');

      await page.goto(host.url);
      await expect(page.getByTestId('toolbar')).toBeVisible();
      await expect(page.getByTestId('canvas-preview')).toBeVisible();
      const frame = page.frameLocator(CANVAS_FRAME);
      await expect(frame.locator('h1')).toContainText('Security deck');
      await expect(page.getByTestId('save-status')).toHaveText('已同步');
    } finally {
      await host?.stop();
      await rm(directory, { recursive: true, force: true });
    }
  }
);

test(
  'health requires a bearer token and reports the live revision',
  { tag: '@feature:live-sync' },
  async () => {
    const directory = await mkdtemp(join(tmpdir(), 'htmlppt-security-health-'));
    let host: StartedHost | undefined;
    try {
      const deckPath = join(directory, 'security.html');
      await writeFile(deckPath, SECURITY_DECK, 'utf8');
      host = await startCliHost(cliPath, directory, 'security.html');
      const origin = hostOrigin(host.url);
      const token = hostToken(host.url);

      const anonymous = await fetch(`${origin}/api/health`);
      expect(anonymous.status).toBe(401);
      expect(await anonymous.json()).toEqual({ error: 'unauthorized' });

      const wrong = await fetch(`${origin}/api/health`, {
        headers: bearer('definitely-not-the-token')
      });
      expect(wrong.status).toBe(401);
      expect(await wrong.json()).toEqual({ error: 'unauthorized' });

      const authorized = await fetch(`${origin}/api/health`, {
        headers: bearer(token)
      });
      expect(authorized.status).toBe(200);
      const payload = (await authorized.json()) as {
        ok?: unknown;
        revision?: unknown;
        filePath?: unknown;
      };
      expect(payload).toMatchObject({ ok: true, filePath: deckPath });
      expect(payload.revision).toMatch(/^[a-f0-9]{64}$/);
    } finally {
      await host?.stop();
      await rm(directory, { recursive: true, force: true });
    }
  }
);

test(
  'the event stream accepts only the correct query token',
  { tag: '@feature:live-sync' },
  async () => {
    const directory = await mkdtemp(join(tmpdir(), 'htmlppt-security-sse-'));
    let host: StartedHost | undefined;
    try {
      await writeFile(join(directory, 'security.html'), SECURITY_DECK, 'utf8');
      host = await startCliHost(cliPath, directory, 'security.html');
      const origin = hostOrigin(host.url);
      const token = hostToken(host.url);

      const wrong = await fetch(
        `${origin}/api/events?token=${encodeURIComponent('wrong-token')}`
      );
      expect(wrong.status).toBe(401);
      expect(await wrong.json()).toEqual({ error: 'unauthorized' });

      // openSse asserts 200 plus the text/event-stream content type.
      const sse = await openSse(
        `${origin}/api/events?token=${encodeURIComponent(token)}`
      );
      try {
        expect((await sse.next()).event).toBe('hello');
      } finally {
        await sse.close();
      }
    } finally {
      await host?.stop();
      await rm(directory, { recursive: true, force: true });
    }
  }
);

test(
  'export requires a bearer token and query tokens are SSE-only',
  { tag: '@feature:export-pdf-png' },
  async () => {
    test.setTimeout(120_000);
    const directory = await mkdtemp(join(tmpdir(), 'htmlppt-security-export-auth-'));
    let host: StartedHost | undefined;
    try {
      await writeFile(join(directory, 'security.html'), SECURITY_DECK, 'utf8');
      host = await startCliHost(cliPath, directory, 'security.html');
      const origin = hostOrigin(host.url);
      const token = hostToken(host.url);

      const anonymous = await fetch(`${origin}/api/export`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ format: 'png' })
      });
      expect(anonymous.status).toBe(401);
      expect(await anonymous.json()).toEqual({ error: 'unauthorized' });

      const wrong = await fetch(`${origin}/api/export`, {
        method: 'POST',
        headers: {
          ...bearer('definitely-not-the-token'),
          'content-type': 'application/json'
        },
        body: JSON.stringify({ format: 'png' })
      });
      expect(wrong.status).toBe(401);
      expect(await wrong.json()).toEqual({ error: 'unauthorized' });

      // A query token must never authorize a state-changing API call; only
      // GET /api/events may use it because EventSource cannot send headers.
      const queryOnly = await fetch(
        `${origin}/api/export?token=${encodeURIComponent(token)}`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ format: 'png' })
        }
      );
      expect(queryOnly.status).toBe(401);
      expect(await queryOnly.json()).toEqual({ error: 'unauthorized' });

      const exported = await fetch(`${origin}/api/export`, {
        method: 'POST',
        headers: {
          ...bearer(token),
          'content-type': 'application/json'
        },
        body: JSON.stringify({ format: 'png' })
      });
      expect(exported.status).toBe(200);
      const payload = (await exported.json()) as { files?: unknown };
      expect(Array.isArray(payload.files)).toBe(true);
      const files = payload.files as string[];
      expect(files).toHaveLength(2);
      for (const file of files) {
        expect(isInside(directory, file)).toBe(true);
        const image = PNG.sync.read(await readFile(file));
        expect([image.width, image.height]).toEqual([640, 360]);
      }
    } finally {
      await host?.stop();
      await rm(directory, { recursive: true, force: true });
    }
  }
);

test(
  'API requests reject a foreign origin and accept the host origin',
  { tag: '@feature:live-sync' },
  async () => {
    const directory = await mkdtemp(join(tmpdir(), 'htmlppt-security-origin-'));
    let host: StartedHost | undefined;
    try {
      await writeFile(join(directory, 'security.html'), SECURITY_DECK, 'utf8');
      host = await startCliHost(cliPath, directory, 'security.html');
      const origin = hostOrigin(host.url);
      const token = hostToken(host.url);

      const foreign = await fetch(`${origin}/api/health`, {
        headers: { ...bearer(token), origin: 'http://evil.example' }
      });
      expect(foreign.status).toBe(403);
      expect(await foreign.json()).toEqual({ error: 'forbidden origin' });

      const same = await fetch(`${origin}/api/health`, {
        headers: { ...bearer(token), origin }
      });
      expect(same.status).toBe(200);
      expect(await same.json()).toMatchObject({ ok: true });
    } finally {
      await host?.stop();
      await rm(directory, { recursive: true, force: true });
    }
  }
);

test(
  'static requests cannot traverse outside the editor root or serve deck siblings',
  { tag: '@feature:live-sync' },
  async () => {
    const directory = await mkdtemp(join(tmpdir(), 'htmlppt-security-static-'));
    const editorDirectory = join(directory, 'editor');
    let host: StartedHost | undefined;
    try {
      await mkdir(editorDirectory, { recursive: true });
      const nonce = randomUUID();
      const editorMarker = `EDITOR-SHELL-${nonce}`;
      const secretMarker = `TOP-SECRET-${nonce}`;
      const deckMarker = `TRAVERSAL-DECK-${nonce}`;
      await writeFile(
        join(editorDirectory, 'index.html'),
        `<!doctype html><html><head><meta charset="utf-8"><title>Security editor</title></head><body><div id="root">${editorMarker}</div></body></html>`,
        'utf8'
      );
      // The secret sits in the editor root's parent, which is also the deck
      // directory, so every traversal below would expose it if unguarded.
      await writeFile(join(directory, 'secret.txt'), secretMarker, 'utf8');
      await writeFile(
        join(directory, 'security.html'),
        SECURITY_DECK.replace('Security deck', deckMarker),
        'utf8'
      );

      host = await startHostWithEnvironment(directory, 'security.html', {
        HTMLPPT_EDITOR_DIR: editorDirectory
      });
      const origin = hostOrigin(host.url);
      const token = hostToken(host.url);
      const query = `?token=${encodeURIComponent(token)}`;

      const shell = await rawGet(origin, `/${query}`);
      expect(shell.status).toBe(302);
      expect(shell.headers.location).toBe('/d/security.html');
      const cookie = shell.headers['set-cookie']?.[0]?.split(';')[0] ?? '';
      const pageShell = await rawGet(origin, '/d/security.html', cookie);
      expect(pageShell.status).toBe(200);
      expect(pageShell.body).toContain(editorMarker);

      const sibling = await rawGet(origin, `/secret.txt${query}`);
      expect([403, 404]).toContain(sibling.status);
      expect(sibling.body).not.toContain(secretMarker);

      const attempts = [
        '/%2e%2e/secret.txt',
        '/%2e%2e/%2e%2e/secret.txt',
        '/..%2f..%2fsecret.txt',
        '/..%5c..%5csecret.txt',
        '/%2e%2e%5csecret.txt',
        '/..\\..\\secret.txt',
        '/%2e%2e/security.html',
        '/..%2fsecurity.html',
        '/assets/%2e%2e/%2e%2e/secret.txt'
      ];
      for (const attempt of attempts) {
        const response = await rawGet(origin, `${attempt}${query}`);
        expect(response.status, attempt).toBeLessThan(500);
        expect(response.body, attempt).not.toContain(secretMarker);
        expect(response.body, attempt).not.toContain(deckMarker);
        expect(response.body, attempt).not.toMatch(/Index of|secret\.txt/i);
      }

      const directoryProbe = await rawGet(origin, `/%2e%2e/${query}`);
      expect(directoryProbe.status).toBeLessThan(500);
      expect(directoryProbe.body).not.toContain(secretMarker);
      expect(directoryProbe.body).not.toMatch(/Index of|secret\.txt/i);
    } finally {
      await host?.stop();
      await rm(directory, { recursive: true, force: true });
    }
  }
);

test(
  'host export confines outDir to the deck directory',
  { tag: '@feature:export-pdf-png' },
  async () => {
    test.setTimeout(120_000);
    const root = await mkdtemp(join(tmpdir(), 'htmlppt-security-outdir-'));
    const deckDirectory = join(root, 'deck');
    let host: StartedHost | undefined;
    try {
      await mkdir(deckDirectory, { recursive: true });
      await writeFile(join(deckDirectory, 'security.html'), SECURITY_DECK, 'utf8');
      host = await startCliHost(cliPath, deckDirectory, 'security.html');
      const origin = hostOrigin(host.url);
      const token = hostToken(host.url);
      const headers = {
        ...bearer(token),
        'content-type': 'application/json'
      };

      const before = (await readdir(root)).sort();

      const relativeEscape = await fetch(`${origin}/api/export`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ format: 'png', outDir: '..' })
      });
      expect(relativeEscape.status).toBe(400);
      expect(await relativeEscape.json()).toMatchObject({
        error: 'invalid outDir'
      });

      const outsideDirectory = join(root, 'outside-exports');
      const absoluteEscape = await fetch(`${origin}/api/export`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ format: 'png', outDir: outsideDirectory })
      });
      expect(absoluteEscape.status).toBe(400);
      expect(await absoluteEscape.json()).toMatchObject({
        error: 'invalid outDir'
      });
      await expectMissing(outsideDirectory);
      expect((await readdir(root)).sort()).toEqual(before);

      const confined = await fetch(`${origin}/api/export`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ format: 'png', outDir: 'exports' })
      });
      expect(confined.status).toBe(200);
      const payload = (await confined.json()) as { files?: unknown };
      expect(Array.isArray(payload.files)).toBe(true);
      const files = payload.files as string[];
      expect(files).toHaveLength(2);
      for (const file of files) {
        expect(isInside(join(deckDirectory, 'exports'), file)).toBe(true);
        expect((await readFile(file)).subarray(0, 8)).toEqual(PNG_SIGNATURE);
      }
    } finally {
      await host?.stop();
      await rm(root, { recursive: true, force: true });
    }
  }
);

test(
  'preview and play sandbox authored scripts and image handlers',
  { tag: '@feature:editor-core' },
  async ({ page }) => {
    test.setTimeout(120_000);
    const directory = await mkdtemp(join(tmpdir(), 'htmlppt-security-sandbox-'));
    let host: StartedHost | undefined;
    try {
      const deckPath = join(directory, 'isolation.html');
      await writeFile(deckPath, ISOLATION_DECK, 'utf8');
      host = await startCliHost(cliPath, directory, 'isolation.html');
      await page.goto(host.url);

      const frame = page.frameLocator(CANVAS_FRAME);
      await expect(frame.locator('h1')).toContainText('Isolation check');
      await expect(page.locator(CANVAS_FRAME)).toHaveAttribute(
        'sandbox',
        'allow-same-origin'
      );
      expect(await page.locator(CANVAS_FRAME).getAttribute('sandbox')).not.toContain(
        'allow-scripts'
      );
      await expect(frame.locator('img')).toHaveJSProperty('complete', true);
      expect(await deckMarkers(page)).toEqual([]);

      const saved = page.waitForResponse(
        (response) =>
          response.request().method() === 'PUT' &&
          new URL(response.url()).pathname === '/api/deck'
      );
      await frame.locator('h1').dblclick();
      await frame.locator('h1').fill('Isolation edited');
      await frame.locator('h1').press('Escape');
      expect((await saved).ok()).toBeTruthy();
      await expect(page.getByTestId('save-status')).toHaveText('已儲存');
      await expect(frame.locator('h1')).toHaveText('Isolation edited');
      expect(await deckMarkers(page)).toEqual([]);

      const savedHtml = await readFile(deckPath, 'utf8');
      expect(savedHtml).toContain('Isolation edited');
      expect(savedHtml).toContain('<script>window.__deckRan=1</script>');
      expect(savedHtml).toMatch(/onerror="window\.__deckRan=2"/);

      await execa(
        'node',
        [cliPath, 'export', 'isolation.html', '--format', 'html'],
        { cwd: directory }
      );
      const exportedHtml = await readFile(
        join(directory, 'isolation.export.html'),
        'utf8'
      );
      expect(exportedHtml).toContain('Isolation edited');
      expect(exportedHtml).toContain('<script>window.__deckRan=1</script>');
      expect(exportedHtml).toMatch(/onerror="window\.__deckRan=2"/);

      // The toolbar Play button enters play from the first slide, matching
      // F5 while avoiding focus that is still inside the edit iframe.
      await page.getByTestId('play').click();
      await expect(page.getByTestId('play-view')).toBeVisible();
      const play = page.frameLocator(PLAY_FRAME);
      await expect(play.locator('h1')).toHaveText('Isolation edited');
      await expect(page.getByTestId('play-frame')).toHaveAttribute(
        'sandbox',
        'allow-same-origin'
      );
      const playSandbox = await page
        .getByTestId('play-frame')
        .getAttribute('sandbox');
      expect(playSandbox).toBe('allow-same-origin');
      expect(playSandbox).not.toContain('allow-scripts');
      await expect(play.locator('img')).toHaveJSProperty('complete', true);
      await expect(play.locator('script')).toHaveCount(1);
      expect(await play.locator('script').textContent()).toContain(
        'window.__deckRan=1'
      );
      expect(await play.locator('img').getAttribute('onerror')).toBe(
        'window.__deckRan=2'
      );
      expect(await deckMarkers(page)).toEqual([]);
    } finally {
      await host?.stop();
      await rm(directory, { recursive: true, force: true });
    }
  }
);

test(
  'CLI PNG export blocks file assets and scripts but still renders',
  { tag: '@feature:export-pdf-png' },
  async () => {
    test.setTimeout(120_000);
    const directory = await mkdtemp(join(tmpdir(), 'htmlppt-security-renderer-'));
    let hits = 0;
    const assetServer = createServer((request, response) => {
      if (request.url === '/script-ran') {
        hits += 1;
        response.writeHead(200, { 'content-type': 'image/png' });
        response.end(Buffer.from(TINY_PNG_BASE64, 'base64'));
        return;
      }
      response.writeHead(404);
      response.end('not found');
    });
    try {
      await new Promise<void>((resolvePromise, reject) => {
        assetServer.once('error', reject);
        assetServer.listen(0, '127.0.0.1', resolvePromise);
      });
      const address = assetServer.address() as AddressInfo;

      const imagePath = join(directory, 'pixel.png');
      const red = new PNG({ width: 32, height: 32 });
      for (let offset = 0; offset < red.data.length; offset += 4) {
        red.data[offset] = 255;
        red.data[offset + 1] = 0;
        red.data[offset + 2] = 0;
        red.data[offset + 3] = 255;
      }
      await writeFile(imagePath, PNG.sync.write(red));
      const source = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>Renderer isolation</title>
<style>.slide { width: 320px; height: 180px; background: #ffffff; }</style>
</head>
<body>
<main data-ppt-deck>
<section class="slide" data-slide-id="s1" data-width="320" data-height="180" style="width:320px;height:180px">
<h1 data-ppt-el="e1" style="position:absolute;left:80px;top:80px">Renderer isolation</h1>
<img data-ppt-el="e2" src="${pathToFileURL(imagePath).href}" style="position:absolute;left:0;top:0;width:32px;height:32px" alt="">
<script>new Image().src = "http://127.0.0.1:${address.port}/script-ran";</script>
</section>
</main>
</body>
</html>
`;
      const deckPath = join(directory, 'render-isolation.html');
      await writeFile(deckPath, source, 'utf8');

      const exported = await execa(
        'node',
        [cliPath, 'export', 'render-isolation.html', '--format', 'png'],
        { cwd: directory }
      );
      expect(exported.exitCode).toBe(0);
      expect(exported.stdout).toContain('Exported');

      const output = join(directory, 'render-isolation-s1.png');
      const bytes = await readFile(output);
      expect(bytes.subarray(0, 8)).toEqual(PNG_SIGNATURE);
      const image = PNG.sync.read(bytes);
      expect([image.width, image.height]).toEqual([640, 360]);
      // The local file is opaque red and sits at the slide origin. Chromium
      // still paints a broken-image icon at the box corner, so scan the whole
      // 64x64 device-pixel box and require that no red image pixel appears.
      const pixelAt = (x: number, y: number) => {
        const offset = (y * image.width + x) * 4;
        return [...image.data.subarray(offset, offset + 4)];
      };
      const redPixels: string[] = [];
      for (let y = 0; y < 64; y += 1) {
        for (let x = 0; x < 64; x += 1) {
          const [r, g, b] = pixelAt(x, y);
          if (r > 180 && g < 80 && b < 80) {
            redPixels.push(`${x},${y}`);
          }
        }
      }
      expect(redPixels).toEqual([]);
      expect(pixelAt(200, 20)).toEqual([255, 255, 255, 255]);

      // The script would have reached this loopback server if JavaScript had
      // run; the renderer disables scripts entirely.
      expect(hits).toBe(0);
      expect(await readFile(deckPath, 'utf8')).toBe(source);
    } finally {
      assetServer.closeAllConnections?.();
      await new Promise<void>((resolvePromise) => {
        assetServer.close(() => resolvePromise());
      });
      await rm(directory, { recursive: true, force: true });
    }
  }
);

test(
  'the link flow rejects javascript: URLs and never saves them',
  { tag: '@feature:rich-text' },
  async ({ page }) => {
    const directory = await mkdtemp(join(tmpdir(), 'htmlppt-security-link-'));
    let host: StartedHost | undefined;
    try {
      const deckPath = join(directory, 'link.html');
      await writeFile(deckPath, LINK_DECK, 'utf8');
      host = await startCliHost(cliPath, directory, 'link.html');
      await page.goto(host.url);

      const frame = page.frameLocator(CANVAS_FRAME);
      const heading = frame.locator('[data-ppt-el="title"]');
      await expect(heading).toHaveText('Secure link');
      await heading.dblclick();
      await expect(page.getByTestId('text-toolbar')).toBeVisible();
      await heading.evaluate((element) => {
        const text = element.firstChild;
        if (!text || text.nodeType !== 3) {
          throw new Error('The heading has no direct text node.');
        }
        const range = element.ownerDocument.createRange();
        range.setStart(text, 0);
        range.setEnd(text, 6);
        const selection = element.ownerDocument.getSelection();
        selection?.removeAllRanges();
        selection?.addRange(range);
      });

      page.once('dialog', (dialog) => dialog.accept('javascript:alert(1)'));
      await page.getByTestId('text-link').click();
      await expect(page.getByTestId('text-error')).toContainText(
        'Links must use http:, https:, mailto:, or a #fragment.'
      );
      await expect(heading.locator('a')).toHaveCount(0);

      await frame.locator('body').click({ position: { x: 5, y: 5 } });
      // Rejecting the link must not dirty the deck: the editor stays synced
      // and the file remains byte-identical.
      await expect(page.getByTestId('save-status')).toHaveText('已同步');

      const saved = await readFile(deckPath, 'utf8');
      expect(saved).toBe(LINK_DECK);
      expect(saved).not.toContain('javascript:');
      expect(saved).not.toMatch(/href=["']javascript:/i);
    } finally {
      await host?.stop();
      await rm(directory, { recursive: true, force: true });
    }
  }
);

test(
  'MCP stdio edits directly and rejects an export outside the deck',
  { tag: '@feature:mcp' },
  async () => {
    test.setTimeout(90_000);
    const root = await mkdtemp(join(tmpdir(), 'htmlppt-security-mcp-direct-'));
    const work = join(root, 'work');
    const home = join(root, 'home');
    let client: Client | undefined;
    try {
      await mkdir(work, { recursive: true });
      await mkdir(home, { recursive: true });
      const deckPath = join(work, 'deck.html');
      await writeFile(deckPath, MCP_DECK, 'utf8');

      client = await connectMcp(work, {
        HTMLPPT_HOME: home,
        HTMLPPT_MCP_MODE: 'direct'
      });

      const outline = await mcpCall(client, 'get_outline', { path: 'deck.html' });
      expect(outline.result.isError).toBeFalsy();
      expect(
        (outline.payload.outline as { slideCount?: unknown }).slideCount
      ).toBe(2);

      const edited = await mcpCall(client, 'set_text', {
        path: 'deck.html',
        slideId: 's1',
        target: { elementId: 'e1' },
        text: 'Edited directly by MCP'
      });
      expect(
        edited.result.isError,
        `set_text failed: ${JSON.stringify(edited.payload)}`
      ).toBeFalsy();
      expect(await readFile(deckPath, 'utf8')).toContain(
        'Edited directly by MCP'
      );

      const beforeRoot = (await readdir(root)).sort();
      const beforeWork = (await readdir(work)).sort();
      const escaped = await mcpCall(client, 'export_deck', {
        path: 'deck.html',
        format: 'html',
        outDir: '..'
      });
      expect(escaped.result.isError).toBe(true);
      expect(escaped.payload).toMatchObject({
        code: 'invalid-out-dir',
        path: deckPath
      });
      expect(String(escaped.payload.message)).toContain('deck directory');
      expect((await readdir(root)).sort()).toEqual(beforeRoot);
      expect((await readdir(work)).sort()).toEqual(beforeWork);
      await expectMissing(join(root, 'deck.export.html'));
      // Direct mode must not start or register a host.
      await expectMissing(join(home, 'sessions'));
      expect(await readFile(deckPath, 'utf8')).toContain(
        'Edited directly by MCP'
      );
    } finally {
      await client?.close().catch(() => undefined);
      await rm(root, { recursive: true, force: true });
    }
  }
);

test(
  'MCP host-attached mutations land through the host without leaking the token',
  { tag: '@feature:mcp' },
  async () => {
    test.setTimeout(90_000);
    const root = await mkdtemp(join(tmpdir(), 'htmlppt-security-mcp-host-'));
    const work = join(root, 'work');
    const home = join(root, 'home');
    let host: StartedHost | undefined;
    let client: Client | undefined;
    let sse: SseCursor | undefined;
    try {
      await mkdir(work, { recursive: true });
      await mkdir(home, { recursive: true });
      const deckPath = join(work, 'hosted.html');
      await writeFile(deckPath, MCP_DECK, 'utf8');

      host = await startHostWithEnvironment(work, 'hosted.html', {
        HTMLPPT_HOME: home
      });
      const origin = hostOrigin(host.url);
      const token = hostToken(host.url);

      sse = await openSse(
        `${origin}/api/events?token=${encodeURIComponent(token)}`
      );
      expect((await sse.next()).event).toBe('hello');

      client = await connectMcp(work, {
        HTMLPPT_HOME: home,
        // Empty (not "direct") lets findLiveSession select the live host.
        HTMLPPT_MCP_MODE: ''
      });

      const edited = await mcpCall(client, 'set_text', {
        path: 'hosted.html',
        slideId: 's1',
        target: { elementId: 'e1' },
        text: 'Edited through the host'
      });
      expect(
        edited.result.isError,
        `set_text failed: ${JSON.stringify(edited.payload)}`
      ).toBeFalsy();
      const revision = edited.payload.revision;
      expect(typeof revision).toBe('string');
      expect(await readFile(deckPath, 'utf8')).toContain(
        'Edited through the host'
      );

      const event = await sse.next();
      expect(event.event).toBe('revision');
      expect(event.data).toMatchObject({ revision, source: 'mcp' });

      const deckResponse = await fetch(`${origin}/api/deck`, {
        headers: bearer(token)
      });
      expect(deckResponse.status).toBe(200);
      expect(await deckResponse.json()).toMatchObject({ revision });

      const invalid = await mcpCall(client, 'set_text', {
        path: 'hosted.html',
        slideId: 'missing-slide',
        target: { elementId: 'e1' },
        text: 'Must not be written'
      });
      expect(invalid.result.isError).toBe(true);
      expect(invalid.payload).toMatchObject({ code: 'slide-not-found' });
      const serialized = JSON.stringify(invalid.result);
      expect(serialized).not.toContain(token);
      expect(serialized.toLowerCase()).not.toContain('authorization');
      expect(await readFile(deckPath, 'utf8')).not.toContain(
        'Must not be written'
      );
    } finally {
      await client?.close().catch(() => undefined);
      await sse?.close();
      await host?.stop();
      await rm(root, { recursive: true, force: true });
    }
  }
);
