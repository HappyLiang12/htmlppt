import { createHash, randomUUID } from 'node:crypto';
import { realpathSync } from 'node:fs';
import {
  mkdir,
  readFile,
  readdir,
  rm,
  stat,
  symlink,
  writeFile
} from 'node:fs/promises';
import path from 'node:path';
import { makeTempDir } from '@htmlppt/test-utils';
import { afterEach, describe, expect, it } from 'vitest';
import { startHost } from '../src/server.js';

const DECK_HTML = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <title>Export fixture</title>
  <style>
    body { margin: 0; }
    .slide { width: 320px; height: 180px; background: #fff; }
  </style>
</head>
<body>
  <main data-ppt-deck>
    <section class="slide" data-slide-id="s1" data-width="320" data-height="180">
      <h1>One</h1>
    </section>
    <section class="slide" data-slide-id="s2" data-width="320" data-height="180">
      <h2>Two</h2>
    </section>
  </main>
</body>
</html>
`;

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

interface Context {
  dir: string;
  deckPath: string;
  deckName: string;
  token: string;
  host: Awaited<ReturnType<typeof startHost>>;
  base: string;
  revision: string;
}

function hash(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function canonicalPath(file: string): string {
  const resolved = path.resolve(file);
  try {
    return realpathSync.native(resolved);
  } catch {
    return resolved;
  }
}

function samePath(actual: string, expected: string): boolean {
  const left = canonicalPath(actual);
  const right = canonicalPath(expected);
  return process.platform === 'win32'
    ? left.toLowerCase() === right.toLowerCase()
    : left === right;
}

function postExport(
  ctx: Context,
  body: unknown,
  options: { token?: string | null; origin?: string } = {}
): Promise<Response> {
  const headers: Record<string, string> = {
    'content-type': 'application/json'
  };
  if (options.token !== null) {
    headers.authorization = `Bearer ${options.token ?? ctx.token}`;
  }
  if (options.origin) {
    headers.origin = options.origin;
  }
  return fetch(`${ctx.base}/api/export`, {
    method: 'POST',
    headers,
    body: JSON.stringify(body)
  });
}

async function readJson(response: Response): Promise<Record<string, unknown>> {
  return (await response.json()) as Record<string, unknown>;
}

let context: Context | undefined;

async function setup(): Promise<Context> {
  const dir = await makeTempDir('htmlppt-host-export-');
  let host: Awaited<ReturnType<typeof startHost>> | undefined;
  try {
    const editorDir = path.join(dir, 'editor');
    await mkdir(editorDir);
    await writeFile(
      path.join(editorDir, 'index.html'),
      '<!doctype html><title>Editor</title>',
      'utf8'
    );
    const deckName = 'fixture.html';
    const deckPath = path.join(dir, deckName);
    await writeFile(deckPath, DECK_HTML, 'utf8');
    const token = randomUUID();
    host = await startHost({ filePath: deckPath, token, editorDir, port: 0 });
    const base = new URL(host.url).origin;
    const response = await fetch(`${base}/api/deck`, {
      headers: { authorization: `Bearer ${token}` }
    });
    if (!response.ok) {
      throw new Error(`Failed to read the deck: ${response.status}`);
    }
    const deck = (await response.json()) as { revision: string };
    context = {
      dir,
      deckPath,
      deckName,
      token,
      host,
      base,
      revision: deck.revision
    };
    return context;
  } catch (error) {
    await host?.close();
    await rm(dir, { recursive: true, force: true });
    throw error;
  }
}

afterEach(async () => {
  const ctx = context;
  context = undefined;
  if (!ctx) {
    return;
  }
  try {
    await ctx.host.close();
  } finally {
    await rm(ctx.dir, { recursive: true, force: true });
  }
});

async function expectDeckUnchanged(ctx: Context): Promise<void> {
  expect(hash(await readFile(ctx.deckPath, 'utf8'))).toBe(hash(DECK_HTML));
  const response = await fetch(`${ctx.base}/api/deck`, {
    headers: { authorization: `Bearer ${ctx.token}` }
  });
  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({ revision: ctx.revision });
}

describe('host export endpoint', () => {
  it(
    'exports standalone HTML next to the deck without touching the source',
    async () => {
      const ctx = await setup();

      const response = await postExport(ctx, { format: 'html' });
      expect(response.status).toBe(200);
      const files = (await readJson(response)).files as string[];
      expect(files).toHaveLength(1);
      const expected = path.join(ctx.dir, 'fixture.export.html');
      expect(samePath(files[0], expected)).toBe(true);

      const exported = await readFile(expected, 'utf8');
      expect(exported).toContain(
        '<!-- Edited with htmlppt. Format: htmldeck/v1. -->'
      );
      expect(exported).toContain('data-ppt-deck');
      expect(exported).toContain('data-slide-id="s2"');
      expect(exported).not.toContain('data-ppt-editing');
      await expectDeckUnchanged(ctx);
    },
    30_000
  );

  it(
    'exports a PDF next to the deck by default and leaves the source untouched',
    async () => {
      const ctx = await setup();

      const response = await postExport(ctx, { format: 'pdf' });
      expect(response.status).toBe(200);
      const body = await readJson(response);
      const files = body.files as string[];
      expect(files).toHaveLength(1);
      expect(samePath(files[0], path.join(ctx.dir, 'fixture.pdf'))).toBe(true);

      const data = await readFile(files[0]);
      expect(data.subarray(0, 5).toString('latin1')).toBe('%PDF-');
      expect((await stat(files[0])).size).toBeGreaterThan(1_000);
      await expectDeckUnchanged(ctx);
    },
    30_000
  );

  it(
    'exports one PNG per slide with default names',
    async () => {
      const ctx = await setup();

      const response = await postExport(ctx, { format: 'png' });
      expect(response.status).toBe(200);
      const files = (await readJson(response)).files as string[];
      expect(files).toHaveLength(2);
      expect(files.map(file => path.basename(file))).toEqual([
        'fixture-s1.png',
        'fixture-s2.png'
      ]);
      for (const file of files) {
        expect(samePath(path.dirname(file), ctx.dir)).toBe(true);
        expect((await readFile(file)).subarray(0, 8)).toEqual(PNG_SIGNATURE);
      }
      await expectDeckUnchanged(ctx);
    },
    30_000
  );

  it(
    'creates and writes into a confined outDir',
    async () => {
      const ctx = await setup();

      const response = await postExport(ctx, {
        format: 'pdf',
        outDir: 'exports/nested'
      });
      expect(response.status).toBe(200);
      const files = (await readJson(response)).files as string[];
      expect(files).toHaveLength(1);
      const expected = path.join(ctx.dir, 'exports', 'nested', 'fixture.pdf');
      expect(samePath(files[0], expected)).toBe(true);
      expect((await stat(expected)).isFile()).toBe(true);
      await expectDeckUnchanged(ctx);
    },
    30_000
  );

  it(
    'runs two concurrent PNG exports to the same outDir without conflicts',
    async () => {
      const ctx = await setup();

      const responses = await Promise.all([
        postExport(ctx, { format: 'png', outDir: 'exports' }),
        postExport(ctx, { format: 'png', outDir: 'exports' })
      ]);
      expect(responses.map((response) => response.status)).toEqual([200, 200]);

      for (const response of responses) {
        const files = (await readJson(response)).files as string[];
        expect(files).toHaveLength(2);
        for (const file of files) {
          expect(samePath(path.dirname(file), path.join(ctx.dir, 'exports'))).toBe(true);
          const data = await readFile(file);
          expect(data.length).toBeGreaterThan(0);
          expect(data.subarray(0, 8)).toEqual(PNG_SIGNATURE);
        }
      }
      await expectDeckUnchanged(ctx);
    },
    60_000
  );

  it.skipIf(process.platform === 'win32')(
    'rejects a symlinked outDir that escapes the deck directory',
    async () => {
      // Windows symlink creation needs privileges that CI does not grant; the
      // POSIX job exercises the realpath containment path instead.
      const ctx = await setup();
      const outside = path.join(ctx.dir, '..', `htmlppt-outside-${randomUUID()}`);
      await mkdir(outside);
      await symlink(outside, path.join(ctx.dir, 'link'), 'dir');
      try {
        for (const outDir of ['link', 'link/nested']) {
          const response = await postExport(ctx, { format: 'png', outDir });
          expect(response.status).toBe(400);
          expect(await readJson(response)).toMatchObject({
            error: 'invalid outDir'
          });
        }
        expect(await readdir(outside)).toEqual([]);
      } finally {
        await rm(outside, { recursive: true, force: true });
      }
    }
  );

  it('rejects outDir values that escape the deck directory', async () => {
    const ctx = await setup();
    const suffix = path.basename(ctx.dir);
    const relativeEscape = `../../escape-${suffix}`;
    const absoluteEscape = path.resolve(ctx.dir, '..', `outside-${suffix}`);

    for (const outDir of ['..', relativeEscape, absoluteEscape]) {
      const response = await postExport(ctx, { format: 'pdf', outDir });
      expect(response.status).toBe(400);
      expect(await readJson(response)).toMatchObject({ error: 'invalid outDir' });
    }

    await expect(stat(path.resolve(ctx.dir, relativeEscape))).rejects.toThrow();
    await expect(stat(absoluteEscape)).rejects.toThrow();
  });

  it('rejects a query-string token on the export route', async () => {
    const ctx = await setup();

    const response = await fetch(
      `${ctx.base}/api/export?token=${encodeURIComponent(ctx.token)}`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ format: 'png' })
      }
    );

    expect(response.status).toBe(401);
    expect(await readJson(response)).toEqual({ error: 'unauthorized' });
    await expect(
      stat(path.join(ctx.dir, 'fixture-s1.png'))
    ).rejects.toThrow();
  });

  it('rejects an export body over 64 KiB before rendering', async () => {
    const ctx = await setup();

    const response = await postExport(ctx, {
      format: 'png',
      padding: 'x'.repeat(65 * 1024)
    });

    expect(response.status).toBe(413);
    const body = await readJson(response);
    expect(body.error).toBe('payload-too-large');
    expect(String(body.message)).toMatch(/64 KiB/);
    await expect(
      stat(path.join(ctx.dir, 'fixture-s1.png'))
    ).rejects.toThrow();
    await expectDeckUnchanged(ctx);
  });

  it('requires the session token, the host origin, and a supported format', async () => {
    const ctx = await setup();

    const missingToken = await postExport(
      ctx,
      { format: 'pdf' },
      { token: null }
    );
    expect(missingToken.status).toBe(401);

    const wrongToken = await postExport(
      ctx,
      { format: 'pdf' },
      { token: 'not-the-token' }
    );
    expect(wrongToken.status).toBe(401);

    const foreignOrigin = await postExport(
      ctx,
      { format: 'pdf' },
      { origin: 'http://evil.example' }
    );
    expect(foreignOrigin.status).toBe(403);

    for (const format of ['jpg', undefined, 42]) {
      const response = await postExport(ctx, { format });
      expect(response.status).toBe(400);
      expect(await readJson(response)).toMatchObject({
        error: 'unsupported format'
      });
    }

    const badOutDir = await postExport(ctx, { format: 'pdf', outDir: 42 });
    expect(badOutDir.status).toBe(400);
    expect(await readJson(badOutDir)).toMatchObject({ error: 'invalid outDir' });

    await expectDeckUnchanged(ctx);
  });

  it(
    'reports an unavailable renderer with actionable instructions',
    async () => {
      const ctx = await setup();
      const previous = process.env.HTMLPPT_CHROMIUM;
      process.env.HTMLPPT_CHROMIUM = path.join(ctx.dir, 'missing-browser.exe');
      try {
        const response = await postExport(ctx, { format: 'pdf' });
        expect(response.status).toBe(501);
        const body = await readJson(response);
        expect(body.error).toBe('renderer-unavailable');
        expect(String(body.message)).toMatch(/HTMLPPT_CHROMIUM/);
        expect(String(body.hint)).toMatch(/install/i);
      } finally {
        if (previous === undefined) {
          delete process.env.HTMLPPT_CHROMIUM;
        } else {
          process.env.HTMLPPT_CHROMIUM = previous;
        }
      }
      await expect(stat(path.join(ctx.dir, 'fixture.pdf'))).rejects.toThrow();
      await expectDeckUnchanged(ctx);
    },
    30_000
  );
});
