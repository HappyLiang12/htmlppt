import { createHash, randomUUID } from 'node:crypto';
import { readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { serve } from '@hono/node-server';
import { serveStatic } from '@hono/node-server/serve-static';
import { parseDeckHtml } from '@htmlppt/core/node';
import { validateDeck } from '@htmlppt/core';
import { Hono } from 'hono';

export interface HostOptions {
  filePath: string;
  token: string;
  editorDir: string;
  port?: number;
}

export interface HostHandle {
  url: string;
  port: number;
  close: () => Promise<void>;
}

function hash(html: string): string {
  return createHash('sha256').update(html).digest('hex');
}

let saveChain: Promise<unknown> = Promise.resolve();

function withSaveLock<T>(task: () => Promise<T>): Promise<T> {
  const run = saveChain.then(task, task);
  saveChain = run.then(
    () => undefined,
    () => undefined
  );
  return run;
}

export async function startHost(options: HostOptions): Promise<HostHandle> {
  if (!options.token) {
    throw new Error('Host requires a non-empty token.');
  }

  let html = await readFile(options.filePath, 'utf8');
  let revision = hash(html);
  let port = 0;

  const app = new Hono();

  app.use('/api/*', async (c, next) => {
    const authorization = c.req.header('authorization') ?? '';
    const bearerPrefix = 'bearer ';
    const bearer = authorization.toLowerCase().startsWith(bearerPrefix)
      ? authorization.slice(bearerPrefix.length)
      : '';
    const queryToken = new URL(c.req.url).searchParams.get('token') ?? '';
    if (bearer !== options.token && queryToken !== options.token) {
      return c.json({ error: 'unauthorized' }, 401);
    }

    const origin = c.req.header('origin');
    if (origin) {
      let parsed: URL;
      try {
        parsed = new URL(origin);
      } catch {
        return c.json({ error: 'forbidden origin' }, 403);
      }
      const isLocal =
        parsed.hostname === '127.0.0.1' || parsed.hostname === 'localhost';
      if (parsed.protocol !== 'http:' || !isLocal || parsed.port !== String(port)) {
        return c.json({ error: 'forbidden origin' }, 403);
      }
    }

    await next();
  });

  app.get('/api/health', (c) => c.json({ ok: true, revision }));

  app.get('/api/deck', (c) =>
    c.json({ html, revision, filePath: options.filePath })
  );

  app.put('/api/deck', async (c) => {
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: 'invalid json' }, 400);
    }

    if (body === null || typeof body !== 'object' || Array.isArray(body)) {
      return c.json({ error: 'invalid body' }, 400);
    }

    const { html: nextHtml, baseRevision } = body as {
      html?: unknown;
      baseRevision?: unknown;
    };
    if (typeof nextHtml !== 'string') {
      return c.json({ error: 'html is required' }, 400);
    }

    return withSaveLock(async () => {
      if (typeof baseRevision === 'string' && baseRevision !== revision) {
        return c.json({ error: 'conflict', revision }, 409);
      }

      const result = validateDeck(parseDeckHtml(nextHtml));
      if (!result.valid) {
        return c.json({ error: 'invalid deck', diagnostics: result.errors }, 400);
      }

      const temporaryPath = path.join(
        path.dirname(options.filePath),
        `.${path.basename(options.filePath)}.${randomUUID()}.htmlppt.tmp`
      );
      try {
        await writeFile(temporaryPath, nextHtml, 'utf8');
        await rename(temporaryPath, options.filePath);
      } finally {
        await rm(temporaryPath, { force: true });
      }

      html = nextHtml;
      revision = hash(html);
      return c.json({ revision });
    });
  });

  app.get('/', async (c) => {
    const editorHtml = await readFile(
      path.join(options.editorDir, 'index.html'),
      'utf8'
    );
    return c.html(editorHtml);
  });
  app.use('/*', serveStatic({ root: options.editorDir }));

  const server = await new Promise<ReturnType<typeof serve>>((resolve, reject) => {
    const instance = serve(
      {
        fetch: app.fetch,
        port: options.port ?? 0,
        hostname: '127.0.0.1'
      },
      () => resolve(instance)
    );
    instance.on('error', reject);
  });

  const address = server.address();
  if (!address || typeof address === 'string') {
    throw new Error('Host did not expose a TCP address.');
  }
  port = address.port;
  const url = `http://127.0.0.1:${port}/?token=${encodeURIComponent(options.token)}`;
  let closed = false;

  return {
    url,
    port,
    async close() {
      if (closed) {
        return;
      }
      closed = true;
      (
        server as unknown as { closeAllConnections?: () => void }
      ).closeAllConnections?.();
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    }
  };
}
