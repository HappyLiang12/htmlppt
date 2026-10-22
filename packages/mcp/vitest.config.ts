import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    alias: {
      // Vite aliases match by prefix, so the more specific entry must come first.
      '@htmlppt/core/node': fileURLToPath(new URL('../core/src/node.ts', import.meta.url)),
      '@htmlppt/core': fileURLToPath(new URL('../core/src/index.ts', import.meta.url)),
      '@htmlppt/runtime': fileURLToPath(new URL('../runtime/src/index.ts', import.meta.url)),
      '@htmlppt/host': fileURLToPath(new URL('../host/src/index.ts', import.meta.url)),
      '@htmlppt/test-utils': fileURLToPath(new URL('../../test-utils/src/index.ts', import.meta.url))
    }
  },
  test: {
    environment: 'node',
    include: ['test/**/*.test.ts'],
    testTimeout: 30_000
  }
});
