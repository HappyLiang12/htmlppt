import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
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
  let host: Awaited<ReturnType<typeof startHost>> | undefined;
  try {
    const editorDir = join(dir, 'editor');
    await mkdir(editorDir);
    await writeFile(
      join(editorDir, 'index.html'),
      '<!doctype html><title>Editor</title><div id="root">editor-shell</div>',
      'utf8'
    );
    await writeFile(
      join(editorDir, 'app.js'),
      'console.log("editor shell");',
      'utf8'
    );
    const deckPath = await copyFixture('basic.deck.html', dir);
    const deckHtml = await readFile(deckPath, 'utf8');
    const token = randomUUID();
    host = await startHost({ filePath: deckPath, token, editorDir, port: 0 });
    const base = new URL(host.url).origin;
    const deckResponse = await fetch(`${base}/api/deck`, {
      headers: { authorization: `Bearer ${token}` }
    });
    if (!deckResponse.ok) {
      throw new Error(`Failed to read the deck: ${deckResponse.status}`);
    }
    const deck = (await deckResponse.json()) as { revision: string };
    context = { dir, deckPath, deckHtml, token, host, base, revision: deck.revision };
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

  it('accepts the bearer scheme case-insensitively', async () => {
    const ctx = await setup();

    const response = await fetch(`${ctx.base}/api/deck`, {
      headers: { authorization: `bearer ${ctx.token}` }
    });

    expect(response.status).toBe(200);
  });

  it('accepts the token as a query parameter', async () => {
    const ctx = await setup();

    const response = await fetch(
      `${ctx.base}/api/health?token=${encodeURIComponent(ctx.token)}`
    );

    expect(response.status).toBe(200);
  });

  it('reports health with the current revision', async () => {
    const ctx = await setup();

    const response = await fetch(`${ctx.base}/api/health`, {
      headers: { authorization: `Bearer ${ctx.token}` }
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true, revision: ctx.revision });
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

  it.each(['null', 'not a url'])(
    'rejects the origin value %j with 403',
    async (origin) => {
      const ctx = await setup();

      const response = await fetch(`${ctx.base}/api/deck`, {
        headers: {
          authorization: `Bearer ${ctx.token}`,
          origin
        }
      });

      expect(response.status).toBe(403);
      expect(await response.json()).toEqual({ error: 'forbidden origin' });
    }
  );

  it('allows a loopback same-origin request', async () => {
    const ctx = await setup();

    const response = await fetch(`${ctx.base}/api/deck`, {
      headers: {
        authorization: `Bearer ${ctx.token}`,
        origin: `http://127.0.0.1:${ctx.host.port}`
      }
    });

    expect(response.status).toBe(200);
  });

  it('serves static editor assets', async () => {
    const ctx = await setup();

    const response = await fetch(`${ctx.base}/app.js`);

    expect(response.status).toBe(200);
    expect(await response.text()).toBe('console.log("editor shell");');
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

  it('serializes concurrent saves with the same base revision', async () => {
    const ctx = await setup();
    const updated = ctx.deckHtml.replace('Basic deck', 'Concurrent deck');
    const save = () =>
      fetch(`${ctx.base}/api/deck`, {
        method: 'PUT',
        headers: {
          authorization: `Bearer ${ctx.token}`,
          'content-type': 'application/json'
        },
        body: JSON.stringify({ html: updated, baseRevision: ctx.revision })
      });

    const responses = await Promise.all([save(), save()]);
    const statuses = responses.map((response) => response.status).sort();
    expect(statuses).toEqual([200, 409]);
    expect(await readFile(ctx.deckPath, 'utf8')).toBe(updated);

    const saved = responses.find((response) => response.status === 200);
    if (!saved) {
      throw new Error('Expected one save to succeed.');
    }
    const { revision } = (await saved.json()) as { revision: string };

    const check = await fetch(`${ctx.base}/api/deck`, {
      headers: { authorization: `Bearer ${ctx.token}` }
    });
    expect(check.status).toBe(200);
    expect(await check.json()).toMatchObject({ html: updated, revision });
  });

  it('reads external file changes and rejects a stale save', async () => {
    const ctx = await setup();
    const externalHtml = ctx.deckHtml.replaceAll(
      'Basic deck',
      'External writer wins'
    );
    await writeFile(ctx.deckPath, externalHtml, 'utf8');

    const health = await fetch(`${ctx.base}/api/health`, {
      headers: { authorization: `Bearer ${ctx.token}` }
    });
    expect(health.status).toBe(200);
    const healthBody = (await health.json()) as { revision: string };
    expect(healthBody.revision).not.toBe(ctx.revision);

    const deckResponse = await fetch(`${ctx.base}/api/deck`, {
      headers: { authorization: `Bearer ${ctx.token}` }
    });
    expect(deckResponse.status).toBe(200);
    expect(await deckResponse.json()).toMatchObject({
      html: externalHtml,
      revision: healthBody.revision
    });

    const saveResponse = await fetch(`${ctx.base}/api/deck`, {
      method: 'PUT',
      headers: {
        authorization: `Bearer ${ctx.token}`,
        'content-type': 'application/json'
      },
      body: JSON.stringify({
        html: ctx.deckHtml.replaceAll('Basic deck', 'Editor tries to save'),
        baseRevision: ctx.revision
      })
    });
    expect(saveResponse.status).toBe(409);
    expect(await readFile(ctx.deckPath, 'utf8')).toBe(externalHtml);

    const followUp = await fetch(`${ctx.base}/api/deck`, {
      headers: { authorization: `Bearer ${ctx.token}` }
    });
    expect(await followUp.json()).toMatchObject({
      html: externalHtml,
      revision: healthBody.revision
    });
  });

  it('rejects a null JSON body', async () => {
    const ctx = await setup();

    const response = await fetch(`${ctx.base}/api/deck`, {
      method: 'PUT',
      headers: {
        authorization: `Bearer ${ctx.token}`,
        'content-type': 'application/json'
      },
      body: 'null'
    });

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: 'invalid body' });
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

  it('rejects an empty token at startup', async () => {
    const dir = await makeTempDir('htmlppt-host-');
    let host: Awaited<ReturnType<typeof startHost>> | undefined;
    try {
      const editorDir = join(dir, 'editor');
      await mkdir(editorDir);
      const deckPath = await copyFixture('basic.deck.html', dir);

      await expect(
        startHost({ filePath: deckPath, token: '', editorDir, port: 0 }).then(
          (started) => {
            host = started;
          }
        )
      ).rejects.toThrow('Host requires a non-empty token.');
    } finally {
      await host?.close();
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('resolves a second close call', async () => {
    const ctx = await setup();
    context = undefined;
    try {
      await ctx.host.close();
      await expect(ctx.host.close()).resolves.toBeUndefined();
    } finally {
      await rm(ctx.dir, { recursive: true, force: true });
    }
  });
});
