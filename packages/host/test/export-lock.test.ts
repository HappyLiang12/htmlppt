import { randomUUID } from 'node:crypto';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { makeTempDir } from '@htmlppt/test-utils';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { startHost } from '../src/server.js';

const rendererState = vi.hoisted(() => ({
  active: 0,
  maxActive: 0,
  failNext: false
}));

vi.mock('@htmlppt/renderer', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@htmlppt/renderer')>();
  return {
    ...actual,
    renderPdf: async (options: { outPath: string }) => {
      const { writeFile: write } = await import('node:fs/promises');
      await write(options.outPath, '%PDF-');
    },
    renderPngs: async (options: { outDir: string; basename: string }) => {
      const [{ writeFile: write }, nodePath] = await Promise.all([
        import('node:fs/promises'),
        import('node:path')
      ]);
      rendererState.active += 1;
      rendererState.maxActive = Math.max(
        rendererState.maxActive,
        rendererState.active
      );
      try {
        await new Promise((resolve) => setTimeout(resolve, 75));
        if (rendererState.failNext) {
          rendererState.failNext = false;
          throw new actual.RenderError('simulated render failure');
        }
        const files = ['s1', 's2'].map((slide) =>
          nodePath.join(options.outDir, `${options.basename}-${slide}.png`)
        );
        for (const file of files) {
          await write(file, Buffer.from('png'));
        }
        return files;
      } finally {
        rendererState.active -= 1;
      }
    }
  };
});

const DECK_HTML = `<!doctype html>
<html lang="en">
<head><title>Lock fixture</title></head>
<body>
  <main data-ppt-deck>
    <section data-slide-id="s1" data-width="320" data-height="180"><h1>One</h1></section>
    <section data-slide-id="s2" data-width="320" data-height="180"><h2>Two</h2></section>
  </main>
</body>
</html>
`;

interface Context {
  dir: string;
  token: string;
  base: string;
  host: Awaited<ReturnType<typeof startHost>>;
}

let context: Context | undefined;

async function setup(): Promise<Context> {
  const dir = await makeTempDir('htmlppt-host-lock-');
  const editorDir = path.join(dir, 'editor');
  await mkdir(editorDir);
  await writeFile(path.join(editorDir, 'index.html'), '<title>Editor</title>');
  const deckPath = path.join(dir, 'fixture.html');
  await writeFile(deckPath, DECK_HTML);
  const token = randomUUID();
  const host = await startHost({ filePath: deckPath, token, editorDir, port: 0 });
  context = { dir, token, base: new URL(host.url).origin, host };
  return context;
}

function postExport(ctx: Context): Promise<Response> {
  return fetch(`${ctx.base}/api/export`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${ctx.token}`,
      'content-type': 'application/json'
    },
    body: JSON.stringify({ format: 'png' })
  });
}

beforeEach(() => {
  rendererState.active = 0;
  rendererState.maxActive = 0;
  rendererState.failNext = false;
});

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

describe('host export serialization', () => {
  it('does not interleave concurrent export renders', async () => {
    const ctx = await setup();

    const responses = await Promise.all([postExport(ctx), postExport(ctx)]);

    expect(responses.map((response) => response.status)).toEqual([200, 200]);
    expect(rendererState.maxActive).toBe(1);
  });

  it('keeps accepting exports after one render fails', async () => {
    const ctx = await setup();
    rendererState.failNext = true;

    const failed = await postExport(ctx);
    expect(failed.status).toBe(500);
    expect(await failed.json()).toMatchObject({ error: 'render-failed' });

    const recovered = await postExport(ctx);
    expect(recovered.status).toBe(200);
    const files = ((await recovered.json()) as { files: string[] }).files;
    expect(files).toHaveLength(2);
    expect(rendererState.maxActive).toBe(1);
  });
});
