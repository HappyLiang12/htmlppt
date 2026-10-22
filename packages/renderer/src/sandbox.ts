import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';

export async function createSandboxOrigin(): Promise<{ url: string; close: () => Promise<void> }> {
  const resource = `/${randomUUID()}`;
  const server = createServer((request, response) => {
    if (request.method !== 'GET' || request.url !== resource) {
      response.writeHead(404).end();
      return;
    }
    response.writeHead(200, {
      'content-type': 'text/html',
      'content-security-policy': "sandbox allow-same-origin; default-src 'none'; script-src 'none'; style-src 'unsafe-inline' http: https:; img-src http: https: data:; font-src http: https: data:; frame-src 'none'; worker-src 'none'; connect-src 'none'; object-src 'none'; form-action 'none'; base-uri http: https:",
      'cache-control': 'no-store'
    });
    response.end('<!doctype html><html><head></head><body></body></html>');
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Cannot bind the renderer sandbox origin.');
  return {
    url: `http://127.0.0.1:${address.port}${resource}`,
    close: async () => {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    }
  };
}
