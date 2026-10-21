import { fileURLToPath } from 'node:url';
import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      '@htmlppt/core': fileURLToPath(new URL('../core/src/index.ts', import.meta.url)),
      '@htmlppt/runtime': fileURLToPath(new URL('../runtime/src/index.ts', import.meta.url))
    }
  },
  build: { outDir: 'dist', emptyOutDir: true }
});
