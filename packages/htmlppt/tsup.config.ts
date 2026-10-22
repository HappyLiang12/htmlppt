import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { defineConfig } from 'tsup';

export default defineConfig({
  entry: {
    cli: 'src/cli.ts',
    mcp: 'src/mcp.ts'
  },
  format: ['esm'],
  target: 'node20',
  platform: 'node',
  bundle: true,
  splitting: false,
  clean: true,
  sourcemap: true,
  dts: false,
  shims: true,
  banner: {
    js: [
      '#!/usr/bin/env node',
      "import { createRequire as __htmlpptCreateRequire } from 'node:module';",
      'const require = __htmlpptCreateRequire(import.meta.url);'
    ].join('\n')
  },
  // A single self-contained tarball: bundle every dependency (the @htmlppt
  // workspaces, the MCP SDK, zod, linkedom, hono, commander, open, ...) while
  // esbuild keeps Node builtins external.
  noExternal: [/.*/],
  esbuildPlugins: [
    {
      name: 'raw-resources',
      setup(build) {
        // Matches packages/mcp so source and dist resolution both work.
        build.onResolve({ filter: /\?raw$/ }, (args) => ({
          path: path.join(args.resolveDir, args.path.replace(/\?raw$/, '')),
          namespace: 'raw-resources'
        }));
        build.onLoad(
          { filter: /.*/, namespace: 'raw-resources' },
          async (args) => ({
            contents: await readFile(args.path, 'utf8'),
            loader: 'text'
          })
        );
      }
    }
  ]
});
