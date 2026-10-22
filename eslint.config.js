import js from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: [
      '**/dist/**',
      '**/node_modules/**',
      '.worktrees/**',
      'test-results/**',
      'playwright-report/**'
    ]
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    rules: {
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }]
    }
  },
  {
    files: ['**/scripts/**/*.mjs'],
    languageOptions: {
      globals: {
        process: 'readonly',
        console: 'readonly',
        URL: 'readonly',
        setTimeout: 'readonly',
        clearTimeout: 'readonly',
        fetch: 'readonly',
        AbortSignal: 'readonly'
      }
    }
  },
  {
    files: ['**/*.cjs'],
    languageOptions: {
      globals: { module: 'writable' }
    }
  },
  {
    files: [
      'packages/cli/**/*.ts',
      'packages/host/**/*.ts',
      'packages/core/**/*.ts',
      'packages/runtime/**/*.ts',
      'packages/htmlppt/**/*.ts',
      'test-utils/**/*.ts',
      'e2e/**/*.ts'
    ],
    languageOptions: {
      globals: {
        process: 'readonly',
        console: 'readonly',
        Buffer: 'readonly',
        URL: 'readonly',
        setTimeout: 'readonly',
        clearTimeout: 'readonly'
      }
    }
  },
  {
    files: ['packages/editor/**/*.ts', 'packages/editor/**/*.tsx'],
    languageOptions: {
      globals: {
        window: 'readonly',
        document: 'readonly',
        location: 'readonly',
        fetch: 'readonly',
        DOMParser: 'readonly',
        HTMLElement: 'readonly',
        HTMLIFrameElement: 'readonly',
        CSS: 'readonly',
        URLSearchParams: 'readonly'
      }
    }
  }
);
