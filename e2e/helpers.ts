import { createServer } from 'node:http';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { extname, join, normalize, resolve } from 'node:path';
import { execa } from 'execa';

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2'
};

/**
 * Serves the built editor without a host API, which is the upload/download
 * fallback (the standalone launcher plus its crash drafts).
 */
export async function startStaticEditor(editorDir: string): Promise<{
  url: string;
  close(): Promise<void>;
}> {
  const root = resolve(editorDir);
  const server = createServer(async (request, response) => {
    const pathname = new URL(request.url ?? '/', 'http://127.0.0.1').pathname;
    const relative = normalize(pathname).replace(/^([/\\])+/, '');
    const target = resolve(root, relative || 'index.html');
    if (
      target !== root &&
      !target.startsWith(`${root}\\`) &&
      !target.startsWith(`${root}/`)
    ) {
      response.writeHead(403);
      response.end('forbidden');
      return;
    }
    try {
      const bytes = await readFile(
        pathname === '/' ? join(root, 'index.html') : target
      );
      response.writeHead(200, {
        'content-type': MIME[extname(target)] ?? 'application/octet-stream'
      });
      response.end(bytes);
    } catch {
      response.writeHead(404, { 'content-type': 'text/plain' });
      response.end('not found');
    }
  });
  await new Promise<void>((resolvePromise) =>
    server.listen(0, '127.0.0.1', resolvePromise)
  );
  const address = server.address();
  if (!address || typeof address === 'string') {
    throw new Error('Static editor server did not bind.');
  }
  return {
    url: `http://127.0.0.1:${address.port}/`,
    close: () =>
      new Promise<void>((resolvePromise, reject) => {
        server.closeAllConnections();
        server.close((error) => (error ? reject(error) : resolvePromise()));
      })
  };
}

export async function serveHtml(html: string) {
  const server = createServer((_request, response) => {
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    response.end(html);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('No address');
  return {
    url: `http://127.0.0.1:${address.port}/`,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.closeAllConnections();
        server.close((error) => (error ? reject(error) : resolve()));
      })
  };
}

export async function startCliHost(
  cliPath: string,
  cwd: string,
  file: string,
  options: { home?: string } = {}
) {
  // Every E2E host gets its own credential store. Inheriting the environment
  // would make `open` write into the real `~/.htmlppt/decks` and reuse a
  // developer's token between runs. A caller that supplies `home` owns its
  // lifecycle (a per-test temp directory it already cleans up).
  const home =
    options.home ?? (await mkdtemp(join(tmpdir(), 'htmlppt-e2e-home-')));
  const ownsHome = options.home === undefined;
  const cleanup = () =>
    ownsHome ? rm(home, { recursive: true, force: true }) : Promise.resolve();
  const child = execa('node', [cliPath, 'open', file, '--no-browser'], {
    cwd,
    reject: false,
    env: { ...process.env, HTMLPPT_HOME: home }
  });

  let buffer = '';
  let url = '';
  try {
    url = await new Promise<string>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error('Host did not start in time')),
        15_000
      );
      child.stdout?.on('data', (chunk: Buffer) => {
        buffer += chunk.toString();
        const match = /HTMLPPT_URL=(\S+)/.exec(buffer);
        if (match?.[1]) {
          clearTimeout(timer);
          resolve(match[1]);
        }
      });
      child.on('exit', (code) => {
        if (code) {
          clearTimeout(timer);
          reject(new Error(`Host exited with code ${code}`));
        }
      });
    });
  } catch (error) {
    child.kill('SIGTERM');
    await child;
    await cleanup();
    throw error;
  }
  if (!url) throw new Error('Host did not return a URL');

  return {
    url,
    async stop() {
      child.kill('SIGTERM');
      await child;
      await cleanup();
    }
  };
}
