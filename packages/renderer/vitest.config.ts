import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    alias: {
      '@htmlppt/core/node': fileURLToPath(new URL('../core/src/node.ts', import.meta.url)),
      '@htmlppt/core': fileURLToPath(new URL('../core/src/index.ts', import.meta.url)),
      '@htmlppt/runtime': fileURLToPath(new URL('../runtime/src/index.ts', import.meta.url))
    }
  },
  test: {
    environment: 'node',
    include: ['test/**/*.test.ts'],
    testTimeout: 30000,
    hookTimeout: 30000,
    fileParallelism: false
  }
});
