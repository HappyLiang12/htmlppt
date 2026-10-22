import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/bin.ts', 'src/index.ts'],
  format: ['esm'],
  target: 'node20',
  dts: true,
  clean: true,
  sourcemap: true,
  banner: { js: '#!/usr/bin/env node' },
  esbuildPlugins: [
    {
      name: 'raw-resources',
      setup(build) {
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
