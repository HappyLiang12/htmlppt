import { createServer } from 'node:http';
import { execa } from 'execa';

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

export async function startCliHost(cliPath: string, cwd: string, file: string) {
  const child = execa('node', [cliPath, 'open', file, '--no-browser'], {
    cwd,
    reject: false
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
    throw error;
  }
  if (!url) throw new Error('Host did not return a URL');

  return {
    url,
    async stop() {
      child.kill('SIGTERM');
      await child;
    }
  };
}
