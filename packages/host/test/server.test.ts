import { randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { copyFixture, makeTempDir } from '@htmlppt/test-utils';
import { afterEach, describe, expect, it } from 'vitest';
import { startHost } from '../src/server.js';

interface Context {
  dir: string;
  deckPath: string;
  deckHtml: string;
  token: string;
  host: Awaited<ReturnType<typeof startHost>>;
  base: string;
  revision: string;
}

let context: Context | undefined;

async function setup(): Promise<Context> {
  const dir = await makeTempDir('htmlppt-host-');
  const editorDir = join(dir, 'editor');
  await mkdir(editorDir);
  await writeFile(
    join(editorDir, 'index.html'),
    '<!doctype html><title>Editor</title><div id="root">editor-shell</div>',
    'utf8'
  );
  const deckPath = await copyFixture('basic.deck.html', dir);
  const deckHtml = await readFile(deckPath, 'utf8');
  const token = randomUUID();
  const host = await startHost({ filePath: deckPath, token, editorDir, port: 0 });
  const base = new URL(host.url).origin;
  const deckResponse = await fetch(`${base}/api/deck`, {
    headers: { authorization: `Bearer ${token}` }
  });
  const deck = (await deckResponse.json()) as { revision: string };
  context = { dir, deckPath, deckHtml, token, host, base, revision: deck.revision };
  return context;
}

afterEach(async () => {
  await context?.host.close();
  context = undefined;
});

describe('host', () => {
  it('serves the editor and the deck', async () => {
    const ctx = await setup();

    const page = await fetch(ctx.host.url);
    expect(await page.text()).toContain('editor-shell');

    const response = await fetch(`${ctx.base}/api/deck`, {
      headers: { authorization: `Bearer ${ctx.token}` }
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      html: ctx.deckHtml,
      filePath: ctx.deckPath,
      revision: ctx.revision
    });
  });

  it('requires a token for the API', async () => {
    const ctx = await setup();

    const response = await fetch(`${ctx.base}/api/deck`);

    expect(response.status).toBe(401);
  });

  it('rejects a foreign origin', async () => {
    const ctx = await setup();

    const response = await fetch(`${ctx.base}/api/deck`, {
      headers: {
        authorization: `Bearer ${ctx.token}`,
        origin: 'http://evil.example'
      }
    });

    expect(response.status).toBe(403);
  });

  it('saves a valid deck atomically and returns a new revision', async () => {
    const ctx = await setup();
    const updated = ctx.deckHtml.replace('Basic deck', 'Updated deck');

    const response = await fetch(`${ctx.base}/api/deck`, {
      method: 'PUT',
      headers: {
        authorization: `Bearer ${ctx.token}`,
        'content-type': 'application/json'
      },
      body: JSON.stringify({ html: updated, baseRevision: ctx.revision })
    });

    expect(response.status).toBe(200);
    const body = (await response.json()) as { revision: string };
    expect(body.revision).not.toBe(ctx.revision);
    expect(await readFile(ctx.deckPath, 'utf8')).toBe(updated);
  });

  it('rejects an invalid deck and leaves the file unchanged', async () => {
    const ctx = await setup();
    const duplicate = `<!doctype html><html><head><title>Bad</title></head><body><section data-slide-id="same"></section><section data-slide-id="same"></section></body></html>`;

    const response = await fetch(`${ctx.base}/api/deck`, {
      method: 'PUT',
      headers: {
        authorization: `Bearer ${ctx.token}`,
        'content-type': 'application/json'
      },
      body: JSON.stringify({ html: duplicate, baseRevision: ctx.revision })
    });

    expect(response.status).toBe(400);
    expect(await readFile(ctx.deckPath, 'utf8')).toBe(ctx.deckHtml);
  });

  it('rejects a stale base revision', async () => {
    const ctx = await setup();

    const response = await fetch(`${ctx.base}/api/deck`, {
      method: 'PUT',
      headers: {
        authorization: `Bearer ${ctx.token}`,
        'content-type': 'application/json'
      },
      body: JSON.stringify({ html: ctx.deckHtml, baseRevision: 'stale' })
    });

    expect(response.status).toBe(409);
  });
});
