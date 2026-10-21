# M0 — Test Harness + Walking Skeleton Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the test harness and a working vertical slice (CLI → host → editor → save → export) before implementing full deck features.

**Architecture:** npm-workspace monorepo. `core` is DOM-agnostic and parses via linkedom in Node, browser `DOMParser` in the editor. `host` is a Hono server that owns one deck file and serves the built editor. `cli` exposes `new`, `validate`, `open`, and `export html`. The editor renders the active slide in a sandboxed iframe and commits text edits back to the host. This plan produces a working skeleton, not the full product.

**Tech Stack:** Node 20+, TypeScript strict, npm workspaces, Vite 6, React 19, Tailwind CSS 4, Hono 4, linkedom, Commander, tsup, Vitest 3, Playwright 1.50+.

**Specs:**
- `docs/superpowers/specs/2026-10-21-html-ppt-editor-design.md`
- `docs/superpowers/specs/2026-10-21-test-framework-design.md`

## Global Constraints

- Node.js >= 20. ESM everywhere (`"type": "module"`). TypeScript `strict: true`.
- No production code without a failing test, except configuration files in Task 1.
- No `skip`, no retries, no mocking of the host or filesystem in integration tests.
- Host binds to `127.0.0.1`, requires a per-session token, writes atomically (temp file + rename).
- Id and clock injectables land with the first production code that needs them (normalization in M1, autosave in M3). Do not add test-only branches.
- Tool UI copy is Traditional Chinese. Code, comments, docs, CLI output, and error messages are English.
- Tests use only local fixtures and no external network.
- Every task ends with a commit. Conventional commit prefixes: `feat:`, `test:`, `chore:`, `docs:`.
- M0 scope only. Do not implement selection, transform, slides CRUD, MCP, or full PowerPoint features here.

## File Structure (M0)

```
package.json                         workspace scripts and dev dependencies
package-lock.json                    committed
tsconfig.base.json                   strict base config + path aliases
eslint.config.js                     flat ESLint config
dependency-cruiser.cjs               module boundary rules
playwright.config.ts                 Chromium, no retries, traces on failure
.gitignore
.github/workflows/ci.yml             static, unit, integration, e2e, matrix jobs
.github/pull_request_template.md     TDD + feature matrix checklist
docs/testing.md                      contributor guide
docs/features.json                   feature manifest
scripts/check-feature-coverage.mjs   matrix gate

test-utils/
  package.json
  tsconfig.json
  src/index.ts                       makeTempDir, copyFixture, fixturesDir
  fixtures/basic.deck.html           2-slide contract fixture

packages/runtime/
  package.json, tsconfig.json
  src/index.ts                       RUNTIME_SOURCE string (navigation)

packages/core/
  package.json, tsconfig.json, vitest.config.ts
  src/index.ts                       browser-safe exports
  src/types.ts                       Diagnostic, ValidationResult
  src/detect.ts                      slide detection + canvas inference
  src/validate.ts                    validation rules
  src/serialize.ts                   serializeDeck, serializeExport
  src/template.ts                    createDeckHtml
  src/node.ts                        parseDeckHtml using linkedom
  test/detect.test.ts
  test/validate.test.ts
  test/serialize.test.ts
  test/template.test.ts

packages/host/
  package.json, tsconfig.json, vitest.config.ts
  src/server.ts                      startHost
  test/server.test.ts

packages/cli/
  package.json, tsconfig.json, tsup.config.ts, vitest.config.ts
  src/index.ts                       runCli, commands
  src/bin.ts                         executable entry
  test/cli.test.ts

packages/editor/
  package.json, tsconfig.json, vite.config.ts, index.html
  src/main.tsx
  src/App.tsx
  src/api.ts
  src/slide-doc.ts
  src/index.css

e2e/
  helpers.ts                         startCliHost, serveHtml
  skeleton.spec.ts                   walkthrough acceptance test
```

## Follow-up plans (not in this plan)

1. M1 — Core contract engine: normalization, id assignment, mutations, full validation, runtime hardening, golden fixtures.
2. M2 — Host persistence/live sync + CLI/MCP + skill + single-package publishing.
3. M3 — Editor foundation: shell, thumbnails, selection, transform, snapping, history.
4. M4 — PowerPoint features: rich text, shapes/images, groups, tables, charts, notes, transitions, presenter, sorter.
5. M5 — PDF/PNG export, security/a11y hardening, packaging, release, cross-platform CI.

---

### Task 1: Workspace scaffold and tooling

**Files:**
- Create: `package.json`, `tsconfig.base.json`, `eslint.config.js`, `dependency-cruiser.cjs`, `playwright.config.ts`, `.gitignore`
- Create: `packages/{core,host,cli,editor,runtime}/package.json` and `tsconfig.json`
- Create: `test-utils/package.json`, `test-utils/tsconfig.json`
- Create: `docs/features.json`

**Interfaces:**
- Produces: workspace package names `@htmlppt/core`, `@htmlppt/core/node`, `@htmlppt/host`, `@htmlppt/cli`, `@htmlppt/editor`, `@htmlppt/runtime`, `@htmlppt/test-utils`; scripts `build`, `lint`, `lint:deps`, `typecheck`, `test:unit`, `test:integration`, `test:e2e`, `test:matrix`, `verify:fast`, `verify`.

Configuration files are exempt from TDD. Verify with commands instead of tests.

- [ ] **Step 1: Create the root workspace files**

`package.json`:

```json
{
  "name": "htmlppt-workspace",
  "private": true,
  "type": "module",
  "workspaces": ["packages/*", "test-utils"],
  "engines": { "node": ">=20" },
  "scripts": {
    "build": "npm run build -w @htmlppt/runtime && npm run build -w @htmlppt/core && npm run build -w @htmlppt/host && npm run build -w @htmlppt/cli && npm run build -w @htmlppt/editor",
    "lint": "eslint .",
    "lint:deps": "depcruise packages --config dependency-cruiser.cjs",
    "typecheck": "npm run typecheck -ws --if-present",
    "test:unit": "npm run test -w @htmlppt/core",
    "test:integration": "npm run build && npm run test -w @htmlppt/host && npm run test -w @htmlppt/cli",
    "test:e2e": "playwright test",
    "test:matrix": "node scripts/check-feature-coverage.mjs",
    "verify:fast": "npm run lint && npm run lint:deps && npm run typecheck && npm run test:unit && npm run test:integration && npm run test:matrix",
    "verify": "npm run verify:fast && npm run test:e2e"
  },
  "devDependencies": {
    "@eslint/js": "^9.20.0",
    "@playwright/test": "^1.50.0",
    "@types/node": "^22.13.0",
    "dependency-cruiser": "^16.10.0",
    "eslint": "^9.20.0",
    "execa": "^9.5.0",
    "typescript": "^5.7.0",
    "typescript-eslint": "^8.24.0",
    "vitest": "^3.0.0"
  }
}
```

`tsconfig.base.json`:

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "Bundler",
    "strict": true,
    "skipLibCheck": true,
    "esModuleInterop": true,
    "forceConsistentCasingInFileNames": true,
    "resolveJsonModule": true,
    "isolatedModules": true,
    "noEmit": true,
    "baseUrl": ".",
    "paths": {
      "@htmlppt/core": ["packages/core/src/index.ts"],
      "@htmlppt/core/node": ["packages/core/src/node.ts"],
      "@htmlppt/runtime": ["packages/runtime/src/index.ts"],
      "@htmlppt/test-utils": ["test-utils/src/index.ts"]
    }
  }
}
```

`eslint.config.js`:

```js
import js from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: [
      '**/dist/**',
      '**/node_modules/**',
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
    files: ['scripts/**/*.mjs'],
    languageOptions: {
      globals: { process: 'readonly', console: 'readonly', URL: 'readonly' }
    }
  },
  {
    files: [
      'packages/cli/**/*.ts',
      'packages/host/**/*.ts',
      'packages/core/**/*.ts',
      'packages/runtime/**/*.ts',
      'test-utils/**/*.ts',
      'e2e/**/*.ts'
    ],
    languageOptions: {
      globals: {
        process: 'readonly',
        console: 'readonly',
        Buffer: 'readonly',
        URL: 'readonly'
      }
    }
  }
);
```

`dependency-cruiser.cjs`:

```js
module.exports = {
  forbidden: [
    { name: 'no-circular', severity: 'error', from: {}, to: { circular: true } },
    {
      name: 'core-is-pure',
      severity: 'error',
      from: { path: '^packages/core' },
      to: { path: '^packages/(host|editor|cli|mcp)' }
    },
    {
      name: 'runtime-is-pure',
      severity: 'error',
      from: { path: '^packages/runtime' },
      to: { path: '^packages/' }
    },
    {
      name: 'editor-avoids-node-adapter',
      severity: 'error',
      from: { path: '^packages/editor' },
      to: { path: '^packages/core/src/node' }
    },
    {
      name: 'host-avoids-editor',
      severity: 'error',
      from: { path: '^packages/host' },
      to: { path: '^packages/editor' }
    }
  ],
  options: {
    doNotFollow: { path: 'node_modules' },
    exclude: { path: '(^|/)(dist|node_modules|test-results|playwright-report)/' },
    tsPreCompilationDeps: true
  }
};
```

`playwright.config.ts`:

```ts
import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './e2e',
  timeout: 30_000,
  retries: 0,
  workers: 1,
  reporter: [
    ['list'],
    ['html', { open: 'never' }],
    ['junit', { outputFile: 'test-results/junit.xml' }]
  ],
  use: {
    viewport: { width: 1440, height: 900 },
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: 'retain-on-failure'
  }
});
```

`.gitignore`:

```
node_modules/
dist/
test-results/
playwright-report/
*.log
.DS_Store
.htmlppt/
```

- [ ] **Step 2: Create package manifests and tsconfigs**

`packages/runtime/package.json`:

```json
{
  "name": "@htmlppt/runtime",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "main": "./dist/index.js",
  "types": "./dist/index.d.ts",
  "exports": {
    ".": { "types": "./dist/index.d.ts", "import": "./dist/index.js" }
  },
  "scripts": {
    "build": "tsup src/index.ts --format esm --dts --clean",
    "typecheck": "tsc --noEmit"
  },
  "devDependencies": {
    "tsup": "^8.3.0",
    "typescript": "^5.7.0"
  }
}
```

`packages/core/package.json`:

```json
{
  "name": "@htmlppt/core",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "main": "./dist/index.js",
  "types": "./dist/index.d.ts",
  "exports": {
    ".": { "types": "./dist/index.d.ts", "import": "./dist/index.js" },
    "./node": { "types": "./dist/node.d.ts", "import": "./dist/node.js" }
  },
  "scripts": {
    "build": "tsup src/index.ts src/node.ts --format esm --dts --clean",
    "typecheck": "tsc --noEmit",
    "test": "vitest run"
  },
  "dependencies": {
    "@htmlppt/runtime": "0.0.0",
    "linkedom": "^0.18.0"
  },
  "devDependencies": {
    "tsup": "^8.3.0",
    "typescript": "^5.7.0",
    "vitest": "^3.0.0"
  }
}
```

`packages/host/package.json`:

```json
{
  "name": "@htmlppt/host",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "main": "./dist/index.js",
  "types": "./dist/index.d.ts",
  "exports": {
    ".": { "types": "./dist/index.d.ts", "import": "./dist/index.js" }
  },
  "scripts": {
    "build": "tsup src/index.ts --format esm --dts --clean",
    "typecheck": "tsc --noEmit",
    "test": "vitest run"
  },
  "dependencies": {
    "@htmlppt/core": "0.0.0",
    "@hono/node-server": "^1.13.0",
    "hono": "^4.6.0"
  },
  "devDependencies": {
    "@htmlppt/test-utils": "0.0.0",
    "tsup": "^8.3.0",
    "typescript": "^5.7.0",
    "vitest": "^3.0.0"
  }
}
```

`packages/cli/package.json`:

```json
{
  "name": "@htmlppt/cli",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "bin": { "htmlppt": "./dist/bin.js" },
  "exports": {
    ".": { "types": "./dist/index.d.ts", "import": "./dist/index.js" }
  },
  "scripts": {
    "build": "tsup",
    "typecheck": "tsc --noEmit",
    "test": "vitest run"
  },
  "dependencies": {
    "@htmlppt/core": "0.0.0",
    "@htmlppt/host": "0.0.0",
    "commander": "^13.0.0",
    "open": "^10.1.0"
  },
  "devDependencies": {
    "@htmlppt/test-utils": "0.0.0",
    "tsup": "^8.3.0",
    "typescript": "^5.7.0",
    "vitest": "^3.0.0"
  }
}
```

`packages/editor/package.json`:

```json
{
  "name": "@htmlppt/editor",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "scripts": {
    "dev": "vite",
    "build": "vite build",
    "typecheck": "tsc --noEmit"
  },
  "dependencies": {
    "@htmlppt/core": "0.0.0",
    "react": "^19.0.0",
    "react-dom": "^19.0.0"
  },
  "devDependencies": {
    "@tailwindcss/vite": "^4.0.0",
    "@types/node": "^22.13.0",
    "@types/react": "^19.0.0",
    "@types/react-dom": "^19.0.0",
    "@vitejs/plugin-react": "^4.3.4",
    "tailwindcss": "^4.0.0",
    "typescript": "^5.7.0",
    "vite": "^6.0.0"
  }
}
```

`test-utils/package.json`:

```json
{
  "name": "@htmlppt/test-utils",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "exports": { ".": "./src/index.ts" },
  "scripts": {
    "typecheck": "tsc --noEmit"
  },
  "devDependencies": {
    "@types/node": "^22.13.0",
    "typescript": "^5.7.0"
  }
}
```

`packages/runtime/tsconfig.json`:

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": { "lib": ["ES2022"], "types": [] },
  "include": ["src"]
}
```

`packages/core/tsconfig.json`:

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "lib": ["ES2022", "DOM", "DOM.Iterable"],
    "types": ["node"]
  },
  "include": ["src", "test", "vitest.config.ts"]
}
```

`packages/host/tsconfig.json`:

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": { "lib": ["ES2022"], "types": ["node"] },
  "include": ["src", "test", "vitest.config.ts"]
}
```

`packages/cli/tsconfig.json`:

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": { "lib": ["ES2022"], "types": ["node"] },
  "include": ["src", "test", "tsup.config.ts", "vitest.config.ts"]
}
```

`packages/editor/tsconfig.json`:

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "lib": ["ES2022", "DOM", "DOM.Iterable"],
    "jsx": "react-jsx",
    "types": ["vite/client", "node"]
  },
  "include": ["src", "vite.config.ts"]
}
```

`test-utils/tsconfig.json`:

```json
{
  "extends": "../tsconfig.base.json",
  "compilerOptions": { "lib": ["ES2022"], "types": ["node"] },
  "include": ["src"]
}
```

- [ ] **Step 3: Add empty build entry points so the workspace installs and typechecks**

Create `packages/runtime/src/index.ts`:

```ts
export {};
```

Create `packages/core/src/index.ts`:

```ts
export {};
```

Create `packages/core/src/node.ts`:

```ts
export {};
```

Create `packages/host/src/index.ts`:

```ts
export {};
```

Create `packages/cli/src/index.ts`:

```ts
export {};
```

Create `packages/cli/src/bin.ts`:

```ts
export {};
```

Create `packages/cli/tsup.config.ts`:

```ts
import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/bin.ts', 'src/index.ts'],
  format: ['esm'],
  target: 'node20',
  dts: true,
  clean: true,
  sourcemap: true,
  banner: { js: '#!/usr/bin/env node' }
});
```

Create `packages/editor/index.html`:

```html
<!doctype html>
<html lang="zh-Hant">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>htmlppt</title>
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="/src/main.tsx"></script>
  </body>
</html>
```

Create `packages/editor/src/main.tsx`:

```tsx
export {};
```

Create `packages/editor/vite.config.ts`:

```ts
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
```

Create `test-utils/src/index.ts`:

```ts
export {};
```

Create `docs/features.json`:

```json
{
  "features": [
    { "id": "skeleton", "spec": "16", "status": "active", "tests": ["@feature:skeleton"] },
    { "id": "slides", "spec": "4.Slides", "status": "planned", "tests": ["@feature:slides"] },
    { "id": "objects-transform", "spec": "4.Objects", "status": "planned", "tests": ["@feature:objects-transform"] },
    { "id": "rich-text", "spec": "4.Text", "status": "planned", "tests": ["@feature:rich-text"] },
    { "id": "tables", "spec": "4.Tables", "status": "planned", "tests": ["@feature:tables"] },
    { "id": "charts", "spec": "4.Charts", "status": "planned", "tests": ["@feature:charts"] },
    { "id": "presenter", "spec": "4.Presentation", "status": "planned", "tests": ["@feature:presenter"] },
    { "id": "mcp", "spec": "6", "status": "planned", "tests": ["@feature:mcp"] },
    { "id": "live-sync", "spec": "9", "status": "planned", "tests": ["@feature:live-sync"] },
    { "id": "export-pdf-png", "spec": "9.Export", "status": "planned", "tests": ["@feature:export-pdf-png"] }
  ]
}
```

- [ ] **Step 4: Install and verify the scaffold**

Run:

```bash
npm install
npm run lint
npm run typecheck
```

Expected: install succeeds, lint and typecheck exit 0. Commit `package-lock.json`.

```bash
git add package.json package-lock.json tsconfig.base.json eslint.config.js dependency-cruiser.cjs playwright.config.ts .gitignore packages test-utils docs/features.json
git commit -m "chore: scaffold npm workspace and tooling"
```

---

### Task 2: Core slide detection and parsing

**Files:**
- Create: `packages/core/src/types.ts`
- Create: `packages/core/src/detect.ts`
- Create: `packages/core/src/node.ts`
- Modify: `packages/core/src/index.ts`
- Create: `packages/core/vitest.config.ts`
- Create: `packages/core/test/detect.test.ts`

**Interfaces:**
- Produces: `parseDeckHtml(html: string): Document` (Node, linkedom); `detectSlides(doc: Document): SlideInfo[]`; `SlideInfo { id, hasId, element, index, width, height }`.

- [ ] **Step 1: Write the failing detection test**

`packages/core/test/detect.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { detectSlides } from '../src/detect.js';
import { parseDeckHtml } from '../src/node.js';

const documentFor = (body: string) =>
  parseDeckHtml(
    `<!doctype html><html><head><title>Deck</title></head><body>${body}</body></html>`
  );

describe('detectSlides', () => {
  it('prefers elements with data-slide-id and reads canvas attributes', () => {
    const doc = documentFor(`
      <div data-slide-id="intro" data-width="800" data-height="600"></div>
      <div data-slide-id="details"></div>
      <section class="slide"></section>
    `);

    const slides = detectSlides(doc);

    expect(slides.map((slide) => slide.id)).toEqual(['intro', 'details']);
    expect(slides[0]).toMatchObject({ hasId: true, width: 800, height: 600, index: 0 });
    expect(slides[1]).toMatchObject({ hasId: true, width: 1600, height: 900, index: 1 });
  });

  it('falls back to .slide elements and generates stable ids', () => {
    const doc = documentFor(`<div class="slide">one</div><div class="slide">two</div>`);

    const slides = detectSlides(doc);

    expect(slides.map((slide) => slide.id)).toEqual(['s1', 's2']);
    expect(slides.every((slide) => !slide.hasId)).toBe(true);
  });

  it('uses the largest sibling group of sections', () => {
    const doc = documentFor(`
      <div><section>lonely</section></div>
      <main><section>one</section><section>two</section></main>
    `);

    const slides = detectSlides(doc);

    expect(slides).toHaveLength(2);
    expect(slides.map((slide) => slide.element.textContent)).toEqual(['one', 'two']);
  });

  it('falls back to the body as a single slide', () => {
    const doc = documentFor(`<h1>Only page</h1>`);

    const slides = detectSlides(doc);

    expect(slides).toHaveLength(1);
    expect(slides[0]).toMatchObject({
      id: 'body',
      hasId: false,
      index: 0,
      width: 1600,
      height: 900
    });
  });

  it('reads canvas size from inline styles', () => {
    const doc = documentFor(
      `<section class="slide" data-slide-id="sized" style="width:1280px;height:720px"></section>`
    );

    expect(detectSlides(doc)[0]).toMatchObject({ width: 1280, height: 720 });
  });
});
```

`packages/core/vitest.config.ts`:

```ts
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    alias: {
      '@htmlppt/runtime': fileURLToPath(new URL('../runtime/src/index.ts', import.meta.url))
    }
  },
  test: {
    environment: 'node',
    include: ['test/**/*.test.ts']
  }
});
```

- [ ] **Step 2: Run the test and confirm RED**

Run: `npm run test -w @htmlppt/core`

Expected: FAIL because `../src/detect.js` / `../src/node.js` do not exist.

- [ ] **Step 3: Implement types, parsing, and detection**

`packages/core/src/types.ts`:

```ts
export type DiagnosticSeverity = 'error' | 'warning' | 'info';

export interface Diagnostic {
  severity: DiagnosticSeverity;
  code: string;
  message: string;
  slideId?: string;
}

export interface ValidationResult {
  errors: Diagnostic[];
  warnings: Diagnostic[];
  info: Diagnostic[];
  valid: boolean;
}
```

`packages/core/src/detect.ts`:

```ts
export interface SlideInfo {
  id: string;
  hasId: boolean;
  element: Element;
  index: number;
  width: number;
  height: number;
}

const SLIDE_SELECTORS = ['[data-slide-id]', '.slide', '.page', '.slide-page'];
const DEFAULT_WIDTH = 1600;
const DEFAULT_HEIGHT = 900;

function positiveNumber(value: number): boolean {
  return Number.isFinite(value) && value > 0;
}

function readSize(element: Element): { width: number; height: number } {
  const attributeWidth = Number(element.getAttribute('data-width'));
  const attributeHeight = Number(element.getAttribute('data-height'));
  const inlineStyle = element.getAttribute('style') ?? '';
  const styleWidth = Number.parseFloat(
    /(?:^|;)\s*width\s*:\s*([\d.]+)px/.exec(inlineStyle)?.[1] ?? ''
  );
  const styleHeight = Number.parseFloat(
    /(?:^|;)\s*height\s*:\s*([\d.]+)px/.exec(inlineStyle)?.[1] ?? ''
  );

  return {
    width: positiveNumber(attributeWidth)
      ? attributeWidth
      : positiveNumber(styleWidth)
        ? styleWidth
        : DEFAULT_WIDTH,
    height: positiveNumber(attributeHeight)
      ? attributeHeight
      : positiveNumber(styleHeight)
        ? styleHeight
        : DEFAULT_HEIGHT
  };
}

function toSlideInfo(element: Element, index: number): SlideInfo {
  const rawId = element.getAttribute('data-slide-id');
  return {
    id: rawId ?? `s${index + 1}`,
    hasId: Boolean(rawId),
    element,
    index,
    ...readSize(element)
  };
}

export function detectSlides(doc: Document): SlideInfo[] {
  for (const selector of SLIDE_SELECTORS) {
    const matches = Array.from(doc.querySelectorAll(selector));
    if (matches.length > 0) {
      return matches.map(toSlideInfo);
    }
  }

  const sections = Array.from(doc.querySelectorAll('section'));
  if (sections.length > 0) {
    const groups = new Map<Element, Element[]>();
    for (const section of sections) {
      const parent = section.parentElement;
      if (!parent) continue;
      const group = groups.get(parent) ?? [];
      group.push(section);
      groups.set(parent, group);
    }

    let best: Element[] | undefined;
    for (const group of groups.values()) {
      if (!best || group.length > best.length) best = group;
    }
    if (best && best.length > 0) {
      return best.map(toSlideInfo);
    }
  }

  return doc.body ? [toSlideInfo(doc.body, 0)] : [];
}
```

`packages/core/src/node.ts`:

```ts
import { parseHTML } from 'linkedom';

export function parseDeckHtml(html: string): Document {
  const { document } = parseHTML(html);
  return document as unknown as Document;
}
```

`packages/core/src/index.ts`:

```ts
export { detectSlides } from './detect.js';
export type { SlideInfo } from './detect.js';
export type { Diagnostic, DiagnosticSeverity, ValidationResult } from './types.js';
```

- [ ] **Step 4: Run the test and confirm GREEN**

Run: `npm run test -w @htmlppt/core`

Expected: 5 tests pass.

- [ ] **Step 5: Commit**

```bash
git add packages/core
git commit -m "feat(core): detect slides and infer canvas size"
```

---

### Task 3: Core validation and serialization

**Files:**
- Create: `packages/core/src/validate.ts`
- Create: `packages/core/src/serialize.ts`
- Modify: `packages/core/src/index.ts`
- Create: `packages/core/test/validate.test.ts`
- Create: `packages/core/test/serialize.test.ts`

**Interfaces:**
- Consumes: `detectSlides(doc)` from Task 2.
- Produces: `validateDeck(doc: Document): ValidationResult`; `serializeDeck(doc: Document): string`; `serializeExport(doc: Document): string`.

- [ ] **Step 1: Write the failing validation test**

`packages/core/test/validate.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { parseDeckHtml } from '../src/node.js';
import { validateDeck } from '../src/validate.js';

const deck = (body: string, title = 'Deck') =>
  parseDeckHtml(
    `<!doctype html><html><head><title>${title}</title></head><body>${body}</body></html>`
  );

describe('validateDeck', () => {
  it('accepts a deck with unique slide ids', () => {
    const result = validateDeck(
      deck(`<section data-slide-id="s1"></section><section data-slide-id="s2"></section>`)
    );

    expect(result.valid).toBe(true);
    expect(result.errors).toEqual([]);
    expect(result.warnings).toEqual([]);
  });

  it('reports duplicate slide ids', () => {
    const result = validateDeck(
      deck(`<section data-slide-id="same"></section><section data-slide-id="same"></section>`)
    );

    expect(result.valid).toBe(false);
    expect(result.errors).toContainEqual(
      expect.objectContaining({ code: 'duplicate-slide-id', slideId: 'same' })
    );
  });

  it('warns when a slide has no id', () => {
    const result = validateDeck(deck(`<section class="slide"></section>`));

    expect(result.valid).toBe(true);
    expect(result.warnings).toContainEqual(
      expect.objectContaining({ code: 'missing-slide-id' })
    );
  });

  it('warns when the document has no title', () => {
    const doc = parseDeckHtml(
      '<!doctype html><html><head></head><body><section data-slide-id="s1"></section></body></html>'
    );

    const result = validateDeck(doc);

    expect(result.warnings).toContainEqual(
      expect.objectContaining({ code: 'missing-title' })
    );
  });

  it('rejects invalid chart JSON', () => {
    const result = validateDeck(
      deck(`<section data-slide-id="s1"><figure data-ppt-chart="{oops}"></figure></section>`)
    );

    expect(result.valid).toBe(false);
    expect(result.errors).toContainEqual(
      expect.objectContaining({ code: 'invalid-chart-json', slideId: 's1' })
    );
  });

  it('rejects an empty document', () => {
    const result = validateDeck(
      parseDeckHtml(
        '<!doctype html><html><head><title>Empty</title></head><body></body></html>'
      )
    );

    expect(result.valid).toBe(false);
    expect(result.errors).toContainEqual(
      expect.objectContaining({ code: 'empty-document' })
    );
  });
});
```

- [ ] **Step 2: Run the test and confirm RED**

Run: `npm run test -w @htmlppt/core`

Expected: FAIL because `../src/validate.js` does not exist.

- [ ] **Step 3: Implement validation**

`packages/core/src/validate.ts`:

```ts
import { detectSlides } from './detect.js';
import type { Diagnostic, ValidationResult } from './types.js';

function diagnostic(
  severity: Diagnostic['severity'],
  code: string,
  message: string,
  slideId?: string
): Diagnostic {
  return slideId ? { severity, code, message, slideId } : { severity, code, message };
}

export function validateDeck(doc: Document): ValidationResult {
  const errors: Diagnostic[] = [];
  const warnings: Diagnostic[] = [];
  const info: Diagnostic[] = [];

  if (!doc.body || doc.body.children.length === 0) {
    errors.push(
      diagnostic('error', 'empty-document', 'The document has no content.')
    );
  }

  if (!doc.title.trim()) {
    warnings.push(
      diagnostic('warning', 'missing-title', 'The document has no <title>.')
    );
  }

  const slides = detectSlides(doc);
  if (slides.length === 0) {
    errors.push(
      diagnostic('error', 'no-slides', 'No slides were found in the document.')
    );
  }

  const seen = new Map<string, number>();
  for (const slide of slides) {
    if (slide.hasId) {
      seen.set(slide.id, (seen.get(slide.id) ?? 0) + 1);
    } else {
      warnings.push(
        diagnostic(
          'warning',
          'missing-slide-id',
          `Slide ${slide.index + 1} has no data-slide-id.`,
          slide.id
        )
      );
    }

    for (const chart of Array.from(slide.element.querySelectorAll('[data-ppt-chart]'))) {
      try {
        JSON.parse(chart.getAttribute('data-ppt-chart') ?? '');
      } catch {
        errors.push(
          diagnostic(
            'error',
            'invalid-chart-json',
            'Chart data is not valid JSON.',
            slide.id
          )
        );
      }
    }
  }

  for (const [id, count] of seen) {
    if (count > 1) {
      errors.push(
        diagnostic(
          'error',
          'duplicate-slide-id',
          `Slide id "${id}" is used ${count} times.`,
          id
        )
      );
    }
  }

  info.push(
    diagnostic('info', 'slide-count', `${slides.length} slide(s) detected.`)
  );

  return { errors, warnings, info, valid: errors.length === 0 };
}
```

- [ ] **Step 4: Run the validation test and confirm GREEN**

Run: `npm run test -w @htmlppt/core -- test/validate.test.ts`

Expected: 6 tests pass.

- [ ] **Step 5: Write the failing serialization test**

`packages/core/test/serialize.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { parseDeckHtml } from '../src/node.js';
import { serializeDeck, serializeExport } from '../src/serialize.js';

const source = `<!doctype html><html><head><title>Deck</title><style>.slide{color:red}</style></head><body><section data-slide-id="s1"><h1>Hello</h1></section><script>window.deck = 1;</script></body></html>`;

describe('serialization', () => {
  it('adds a doctype and preserves head, styles, and scripts', () => {
    const html = serializeDeck(parseDeckHtml(source));

    expect(html.startsWith('<!doctype html>')).toBe(true);
    expect(html).toContain('<style>.slide{color:red}</style>');
    expect(html).toContain('<script>window.deck = 1;</script>');
  });

  it('is idempotent', () => {
    const once = serializeDeck(parseDeckHtml(source));
    const twice = serializeDeck(parseDeckHtml(once));

    expect(twice).toBe(once);
  });

  it('adds a generator comment for exports', () => {
    const html = serializeExport(parseDeckHtml(source));

    expect(html).toContain('<!-- Edited with htmlppt. Format: htmldeck/v1. -->');
  });
});
```

Run: `npm run test -w @htmlppt/core -- test/serialize.test.ts`

Expected: FAIL because `../src/serialize.js` does not exist.

- [ ] **Step 6: Implement serialization and exports**

`packages/core/src/serialize.ts`:

```ts
const DOCTYPE = '<!doctype html>';
const GENERATOR_COMMENT = '<!-- Edited with htmlppt. Format: htmldeck/v1. -->';

export function serializeDeck(doc: Document): string {
  return `${DOCTYPE}\n${doc.documentElement.outerHTML}`;
}

export function serializeExport(doc: Document): string {
  return `${DOCTYPE}\n${GENERATOR_COMMENT}\n${doc.documentElement.outerHTML}`;
}
```

Modify `packages/core/src/index.ts`:

```ts
export { detectSlides } from './detect.js';
export type { SlideInfo } from './detect.js';
export { validateDeck } from './validate.js';
export type { Diagnostic, DiagnosticSeverity, ValidationResult } from './types.js';
export { serializeDeck, serializeExport } from './serialize.js';
```

- [ ] **Step 7: Run the core tests and confirm GREEN**

Run: `npm run test -w @htmlppt/core`

Expected: all core tests pass.

- [ ] **Step 8: Commit**

```bash
git add packages/core
git commit -m "feat(core): validate decks and serialize exports"
```

---

### Task 4: Presentation runtime and deck template

**Files:**
- Modify: `packages/runtime/src/index.ts`
- Create: `packages/core/src/template.ts`
- Modify: `packages/core/src/index.ts`
- Create: `packages/core/test/template.test.ts`

**Interfaces:**
- Consumes: `RUNTIME_SOURCE` from `@htmlppt/runtime`; `validateDeck` and `parseDeckHtml` for tests.
- Produces: `createDeckHtml(options?: { title?: string; slides?: number; width?: number; height?: number }): string`.

- [ ] **Step 1: Write the failing template test**

`packages/core/test/template.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { RUNTIME_SOURCE } from '@htmlppt/runtime';
import { detectSlides } from '../src/detect.js';
import { parseDeckHtml } from '../src/node.js';
import { createDeckHtml } from '../src/template.js';
import { validateDeck } from '../src/validate.js';

describe('createDeckHtml', () => {
  it('creates a valid deck with the requested slide count', () => {
    const doc = parseDeckHtml(createDeckHtml({ title: 'Demo', slides: 3 }));

    expect(validateDeck(doc).valid).toBe(true);
    expect(detectSlides(doc).map((slide) => slide.id)).toEqual(['s1', 's2', 's3']);
    expect(doc.title).toBe('Demo');
  });

  it('escapes the title', () => {
    const html = createDeckHtml({ title: '<script>alert(1)</script>' });

    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
    expect(html).not.toContain('<script>alert(1)</script>');
  });

  it('embeds the runtime without a nested closing script tag', () => {
    const html = createDeckHtml();

    expect(RUNTIME_SOURCE).not.toContain('</script>');
    expect(html).toContain('data-ppt-runtime="1"');
    expect(html).toContain('ArrowRight');
  });
});
```

Run: `npm run test -w @htmlppt/core -- test/template.test.ts`

Expected: FAIL because `../src/template.js` and the runtime export do not exist.

- [ ] **Step 2: Implement the runtime**

`packages/runtime/src/index.ts`:

```ts
export const RUNTIME_SOURCE = String.raw`
(() => {
  var slides = Array.prototype.slice.call(document.querySelectorAll('[data-slide-id]'));
  if (!slides.length) return;
  var index = 0;

  function show(next) {
    index = Math.max(0, Math.min(slides.length - 1, next));
    slides.forEach(function (slide, i) {
      slide.style.display = i === index ? '' : 'none';
    });
    history.replaceState(null, '', '#/' + (index + 1));
  }

  document.addEventListener('keydown', function (event) {
    if (event.key === 'ArrowRight' || event.key === ' ' || event.key === 'PageDown') {
      event.preventDefault();
      show(index + 1);
    } else if (event.key === 'ArrowLeft' || event.key === 'PageUp') {
      event.preventDefault();
      show(index - 1);
    } else if (event.key === 'Home') {
      event.preventDefault();
      show(0);
    } else if (event.key === 'End') {
      event.preventDefault();
      show(slides.length - 1);
    }
  });

  window.addEventListener('hashchange', function () {
    var match = /#\/(\d+)/.exec(location.hash);
    if (match) show(Number(match[1]) - 1);
  });

  var initial = /#\/(\d+)/.exec(location.hash);
  show(initial ? Number(initial[1]) - 1 : 0);
})();
`;
```

- [ ] **Step 3: Implement the deck template**

`packages/core/src/template.ts`:

```ts
import { RUNTIME_SOURCE } from '@htmlppt/runtime';

export interface CreateDeckOptions {
  title?: string;
  slides?: number;
  width?: number;
  height?: number;
}

const ESCAPES: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;'
};

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => ESCAPES[character] ?? character);
}

export function createDeckHtml(options: CreateDeckOptions = {}): string {
  const title = options.title ?? 'Untitled deck';
  const count = Math.max(1, Math.floor(options.slides ?? 2));
  const width = options.width ?? 1600;
  const height = options.height ?? 900;
  const safeTitle = escapeHtml(title);

  const slides = Array.from({ length: count }, (_, index) => {
    const heading = index === 0 ? title : `${title} — ${index + 1}`;
    return `
    <section class="slide" data-slide-id="s${index + 1}" data-width="${width}" data-height="${height}">
      <div class="slide-inner">
        <p class="kicker">htmlppt</p>
        <h1 data-ppt-el="e${index + 1}">${escapeHtml(heading)}</h1>
      </div>
    </section>`;
  }).join('');

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${safeTitle}</title>
<style>
  :root { color-scheme: light; }
  html, body { margin: 0; padding: 0; background: #0b0d12; }
  .slide { width: ${width}px; height: ${height}px; position: relative; overflow: hidden; background: #f7f5ef; color: #17181c; font-family: Inter, ui-sans-serif, system-ui, sans-serif; }
  .slide-inner { position: absolute; inset: 0; display: flex; flex-direction: column; justify-content: center; padding: 96px; }
  .kicker { margin: 0 0 18px; font-size: 22px; letter-spacing: .18em; text-transform: uppercase; color: #9a6b1f; }
  h1 { margin: 0; font-size: 96px; line-height: 1.05; max-width: 1200px; }
</style>
</head>
<body>
<main data-ppt-deck>${slides}
</main>
<script data-ppt-runtime="1">${RUNTIME_SOURCE}</script>
</body>
</html>
`;
}
```

Modify `packages/core/src/index.ts`:

```ts
export { detectSlides } from './detect.js';
export type { SlideInfo } from './detect.js';
export { validateDeck } from './validate.js';
export type { Diagnostic, DiagnosticSeverity, ValidationResult } from './types.js';
export { serializeDeck, serializeExport } from './serialize.js';
export { createDeckHtml } from './template.js';
export type { CreateDeckOptions } from './template.js';
```

- [ ] **Step 4: Run the core tests and confirm GREEN**

Run: `npm run test -w @htmlppt/core`

Expected: all tests pass, including the 3 template tests.

- [ ] **Step 5: Commit**

```bash
git add packages/runtime packages/core
git commit -m "feat(core): add presentation runtime and deck template"
```

---

### Task 5: Host server

**Files:**
- Create: `packages/host/src/server.ts`
- Modify: `packages/host/src/index.ts`
- Create: `packages/host/vitest.config.ts`
- Create: `packages/host/test/server.test.ts`
- Create: `test-utils/src/index.ts`
- Create: `test-utils/fixtures/basic.deck.html`

**Interfaces:**
- Consumes: `parseDeckHtml`, `validateDeck` from core.
- Produces: `startHost(options: { filePath: string; token: string; editorDir: string; port?: number }): Promise<{ url: string; port: number; close: () => Promise<void> }>`.

- [ ] **Step 1: Write the failing host integration test**

Create `test-utils/src/index.ts`:

```ts
import { cp, mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

export async function makeTempDir(prefix = 'htmlppt-'): Promise<string> {
  return mkdtemp(join(tmpdir(), prefix));
}

export const fixturesDir = fileURLToPath(new URL('../fixtures', import.meta.url));

export async function copyFixture(name: string, destinationDir: string): Promise<string> {
  const destination = join(destinationDir, name);
  await cp(join(fixturesDir, name), destination);
  return destination;
}
```

Create `test-utils/fixtures/basic.deck.html`:

```html
<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <title>Basic deck</title>
  <style>
    .slide { width: 1600px; height: 900px; background: #fff; position: relative; overflow: hidden; }
    h1 { font-size: 96px; }
  </style>
</head>
<body>
  <main data-ppt-deck>
    <section class="slide" data-slide-id="s1">
      <h1 data-ppt-el="e1">Basic deck</h1>
      <p data-ppt-el="e2">First slide</p>
    </section>
    <section class="slide" data-slide-id="s2">
      <h2 data-ppt-el="e3">Second slide</h2>
    </section>
  </main>
</body>
</html>
```

Create `packages/host/vitest.config.ts`:

```ts
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    alias: {
      '@htmlppt/core': fileURLToPath(new URL('../core/src/index.ts', import.meta.url)),
      '@htmlppt/core/node': fileURLToPath(new URL('../core/src/node.ts', import.meta.url)),
      '@htmlppt/test-utils': fileURLToPath(new URL('../../test-utils/src/index.ts', import.meta.url))
    }
  },
  test: {
    environment: 'node',
    include: ['test/**/*.test.ts']
  }
});
```

Create `packages/host/test/server.test.ts`:

```ts
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { copyFixture, makeTempDir } from '@htmlppt/test-utils';
import { afterEach, describe, expect, it } from 'vitest';
import { startHost } from '../src/server.js';

interface Context {
  dir: string;
  deckPath: string;
  deckHtml: string;
  token: string;
  host: Awaited<ReturnType<typeof startHost>>;
  base: string;
  revision: string;
}

let context: Context | undefined;

async function setup(): Promise<Context> {
  const dir = await makeTempDir('htmlppt-host-');
  const editorDir = join(dir, 'editor');
  await mkdir(editorDir);
  await writeFile(
    join(editorDir, 'index.html'),
    '<!doctype html><title>Editor</title><div id="root">editor-shell</div>',
    'utf8'
  );
  const deckPath = await copyFixture('basic.deck.html', dir);
  const deckHtml = await readFile(deckPath, 'utf8');
  const token = randomUUID();
  const host = await startHost({ filePath: deckPath, token, editorDir, port: 0 });
  const base = new URL(host.url).origin;
  const deckResponse = await fetch(`${base}/api/deck`, {
    headers: { authorization: `Bearer ${token}` }
  });
  const deck = (await deckResponse.json()) as { revision: string };
  context = { dir, deckPath, deckHtml, token, host, base, revision: deck.revision };
  return context;
}

afterEach(async () => {
  await context?.host.close();
  context = undefined;
});

describe('host', () => {
  it('serves the editor and the deck', async () => {
    const ctx = await setup();

    const page = await fetch(ctx.host.url);
    expect(await page.text()).toContain('editor-shell');

    const response = await fetch(`${ctx.base}/api/deck`, {
      headers: { authorization: `Bearer ${ctx.token}` }
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      html: ctx.deckHtml,
      filePath: ctx.deckPath,
      revision: ctx.revision
    });
  });

  it('requires a token for the API', async () => {
    const ctx = await setup();

    const response = await fetch(`${ctx.base}/api/deck`);

    expect(response.status).toBe(401);
  });

  it('rejects a foreign origin', async () => {
    const ctx = await setup();

    const response = await fetch(`${ctx.base}/api/deck`, {
      headers: {
        authorization: `Bearer ${ctx.token}`,
        origin: 'http://evil.example'
      }
    });

    expect(response.status).toBe(403);
  });

  it('saves a valid deck atomically and returns a new revision', async () => {
    const ctx = await setup();
    const updated = ctx.deckHtml.replace('Basic deck', 'Updated deck');

    const response = await fetch(`${ctx.base}/api/deck`, {
      method: 'PUT',
      headers: {
        authorization: `Bearer ${ctx.token}`,
        'content-type': 'application/json'
      },
      body: JSON.stringify({ html: updated, baseRevision: ctx.revision })
    });

    expect(response.status).toBe(200);
    const body = (await response.json()) as { revision: string };
    expect(body.revision).not.toBe(ctx.revision);
    expect(await readFile(ctx.deckPath, 'utf8')).toBe(updated);
  });

  it('rejects an invalid deck and leaves the file unchanged', async () => {
    const ctx = await setup();
    const duplicate = `<!doctype html><html><head><title>Bad</title></head><body><section data-slide-id="same"></section><section data-slide-id="same"></section></body></html>`;

    const response = await fetch(`${ctx.base}/api/deck`, {
      method: 'PUT',
      headers: {
        authorization: `Bearer ${ctx.token}`,
        'content-type': 'application/json'
      },
      body: JSON.stringify({ html: duplicate, baseRevision: ctx.revision })
    });

    expect(response.status).toBe(400);
    expect(await readFile(ctx.deckPath, 'utf8')).toBe(ctx.deckHtml);
  });

  it('rejects a stale base revision', async () => {
    const ctx = await setup();

    const response = await fetch(`${ctx.base}/api/deck`, {
      method: 'PUT',
      headers: {
        authorization: `Bearer ${ctx.token}`,
        'content-type': 'application/json'
      },
      body: JSON.stringify({ html: ctx.deckHtml, baseRevision: 'stale' })
    });

    expect(response.status).toBe(409);
  });
});
```

- [ ] **Step 2: Run the test and confirm RED**

Run: `npm run test -w @htmlppt/host`

Expected: FAIL because `../src/server.js` does not exist.

- [ ] **Step 3: Implement the host**

`packages/host/src/server.ts`:

```ts
import { createHash } from 'node:crypto';
import { readFile, rename, writeFile } from 'node:fs/promises';
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

export async function startHost(options: HostOptions): Promise<HostHandle> {
  let html = await readFile(options.filePath, 'utf8');
  let revision = hash(html);
  let port = 0;

  const app = new Hono();

  app.use('/api/*', async (c, next) => {
    const authorization = c.req.header('authorization') ?? '';
    const bearer = authorization.startsWith('Bearer ') ? authorization.slice(7) : '';
    const queryToken = new URL(c.req.url).searchParams.get('token') ?? '';
    if (bearer !== options.token && queryToken !== options.token) {
      return c.json({ error: 'unauthorized' }, 401);
    }

    const origin = c.req.header('origin');
    if (origin) {
      const parsed = new URL(origin);
      const isLocal =
        parsed.hostname === '127.0.0.1' || parsed.hostname === 'localhost';
      if (!isLocal || parsed.port !== String(port)) {
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
    let body: { html?: unknown; baseRevision?: unknown };
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: 'invalid json' }, 400);
    }

    if (typeof body.html !== 'string') {
      return c.json({ error: 'html is required' }, 400);
    }
    if (typeof body.baseRevision === 'string' && body.baseRevision !== revision) {
      return c.json({ error: 'conflict', revision }, 409);
    }

    const result = validateDeck(parseDeckHtml(body.html));
    if (!result.valid) {
      return c.json({ error: 'invalid deck', diagnostics: result.errors }, 400);
    }

    const temporaryPath = path.join(
      path.dirname(options.filePath),
      `.${path.basename(options.filePath)}.htmlppt.tmp`
    );
    await writeFile(temporaryPath, body.html, 'utf8');
    await rename(temporaryPath, options.filePath);

    html = body.html;
    revision = hash(html);
    return c.json({ revision });
  });

  app.get('/', serveStatic({ path: '/index.html', root: options.editorDir }));
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

  return {
    url,
    port,
    async close() {
      (
        server as unknown as { closeAllConnections?: () => void }
      ).closeAllConnections?.();
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    }
  };
}
```

Modify `packages/host/src/index.ts`:

```ts
export { startHost } from './server.js';
export type { HostHandle, HostOptions } from './server.js';
```

- [ ] **Step 4: Run the host tests and confirm GREEN**

Run: `npm run test -w @htmlppt/host`

Expected: 6 tests pass.

- [ ] **Step 5: Commit**

```bash
git add packages/host test-utils
git commit -m "feat(host): serve decks and save revisions atomically"
```

---

### Task 6: CLI new, validate, export

**Files:**
- Modify: `packages/cli/src/index.ts`
- Modify: `packages/cli/src/bin.ts`
- Create: `packages/cli/vitest.config.ts`
- Create: `packages/cli/test/cli.test.ts`

**Interfaces:**
- Consumes: `createDeckHtml`, `parseDeckHtml`, `validateDeck`, `serializeExport`.
- Produces: `runCli(argv: string[], io?: Partial<CliIO>): Promise<number>`; `CliIO { cwd, stdout, stderr }`.

- [ ] **Step 1: Write the failing CLI test**

`packages/cli/vitest.config.ts`:

```ts
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    alias: {
      '@htmlppt/core': fileURLToPath(new URL('../core/src/index.ts', import.meta.url)),
      '@htmlppt/core/node': fileURLToPath(new URL('../core/src/node.ts', import.meta.url)),
      '@htmlppt/host': fileURLToPath(new URL('../host/src/index.ts', import.meta.url)),
      '@htmlppt/test-utils': fileURLToPath(new URL('../../test-utils/src/index.ts', import.meta.url))
    }
  },
  test: {
    environment: 'node',
    include: ['test/**/*.test.ts']
  }
});
```

`packages/cli/test/cli.test.ts`:

```ts
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { makeTempDir } from '@htmlppt/test-utils';
import { describe, expect, it } from 'vitest';
import { runCli } from '../src/index.js';

function capture() {
  const stdout: string[] = [];
  const stderr: string[] = [];
  return {
    stdout,
    stderr,
    io: {
      stdout: (line: string) => stdout.push(line),
      stderr: (line: string) => stderr.push(line)
    }
  };
}

describe('htmlppt cli', () => {
  it('creates a deck with slides and a runtime', async () => {
    const cwd = await makeTempDir('htmlppt-cli-');
    const output = capture();

    const code = await runCli(['new', 'demo.html', '--slides', '3'], {
      cwd,
      ...output.io
    });

    expect(code).toBe(0);
    const html = await readFile(join(cwd, 'demo.html'), 'utf8');
    expect(html).toContain('data-slide-id="s3"');
    expect(html).toContain('data-ppt-runtime="1"');
  });

  it('validates a generated deck as JSON', async () => {
    const cwd = await makeTempDir('htmlppt-cli-');
    await runCli(['new', 'deck.html'], { cwd, ...capture().io });
    const output = capture();

    const code = await runCli(['validate', 'deck.html', '--json'], {
      cwd,
      ...output.io
    });

    expect(code).toBe(0);
    const parsed = JSON.parse(output.stdout.join('\n')) as {
      valid: boolean;
      errors: unknown[];
    };
    expect(parsed.valid).toBe(true);
    expect(parsed.errors).toEqual([]);
  });

  it('returns a non-zero code and a diagnostic for duplicate slide ids', async () => {
    const cwd = await makeTempDir('htmlppt-cli-');
    await writeFile(
      join(cwd, 'bad.html'),
      `<!doctype html><html><head><title>Bad</title></head><body><section data-slide-id="same"></section><section data-slide-id="same"></section></body></html>`,
      'utf8'
    );
    const output = capture();

    const code = await runCli(['validate', 'bad.html', '--json'], {
      cwd,
      ...output.io
    });

    expect(code).toBe(1);
    expect(output.stdout.join('\n')).toContain('duplicate-slide-id');
  });

  it('exports HTML with a generator comment and no editor artifacts', async () => {
    const cwd = await makeTempDir('htmlppt-cli-');
    await runCli(['new', 'deck.html'], { cwd, ...capture().io });
    const output = capture();

    const code = await runCli(
      ['export', 'deck.html', '--format', 'html', '--out', 'out.html'],
      { cwd, ...output.io }
    );

    expect(code).toBe(0);
    const exported = await readFile(join(cwd, 'out.html'), 'utf8');
    expect(exported).toContain('<!-- Edited with htmlppt. Format: htmldeck/v1. -->');
    expect(exported).not.toContain('contenteditable');
  });

  it('rejects unsupported export formats with a clear error', async () => {
    const cwd = await makeTempDir('htmlppt-cli-');
    await runCli(['new', 'deck.html'], { cwd, ...capture().io });
    const output = capture();

    const code = await runCli(['export', 'deck.html', '--format', 'pdf'], {
      cwd,
      ...output.io
    });

    expect(code).toBe(1);
    expect(output.stderr.join('\n')).toContain('Only html export is available');
  });
});
```

- [ ] **Step 2: Run the test and confirm RED**

Run: `npm run test -w @htmlppt/cli`

Expected: FAIL because `runCli` is not implemented.

- [ ] **Step 3: Implement the CLI**

`packages/cli/src/index.ts`:

```ts
import { access, readFile, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { join, parse, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  createDeckHtml,
  serializeExport,
  validateDeck,
  type ValidationResult
} from '@htmlppt/core';
import { parseDeckHtml } from '@htmlppt/core/node';
import { startHost } from '@htmlppt/host';
import { Command, CommanderError } from 'commander';

export interface CliIO {
  cwd: string;
  stdout: (line: string) => void;
  stderr: (line: string) => void;
}

const DEFAULT_IO: CliIO = {
  cwd: process.cwd(),
  stdout: (line) => console.log(line),
  stderr: (line) => console.error(line)
};

function editorDir(): string {
  return (
    process.env.HTMLPPT_EDITOR_DIR ??
    fileURLToPath(new URL('../../editor/dist', import.meta.url))
  );
}

function printDiagnostics(result: ValidationResult, io: CliIO): void {
  for (const diagnostic of result.errors) {
    io.stderr(`ERROR ${diagnostic.code}: ${diagnostic.message}`);
  }
  for (const diagnostic of result.warnings) {
    io.stderr(`WARN ${diagnostic.code}: ${diagnostic.message}`);
  }
  io.stdout(
    result.valid ? 'Deck is valid.' : `Deck has ${result.errors.length} error(s).`
  );
}

export async function runCli(
  argv: string[],
  overrides: Partial<CliIO> = {}
): Promise<number> {
  const io: CliIO = { ...DEFAULT_IO, ...overrides };
  let exitCode = 0;

  const program = new Command();
  program
    .name('htmlppt')
    .description('Visual editor and tooling for static HTML presentations')
    .version('0.0.0')
    .exitOverride();

  program
    .command('new <file>')
    .description('Create a contract-compliant deck')
    .option('--title <title>', 'deck title', 'Untitled deck')
    .option('--slides <count>', 'number of slides', '2')
    .option('--size <size>', 'canvas size, for example 1600x900', '1600x900')
    .action(async (file: string, options: { title: string; slides: string; size: string }) => {
      const match = /^(\d+)x(\d+)$/.exec(options.size);
      if (!match) {
        throw new Error('Invalid --size. Use WIDTHxHEIGHT, for example 1600x900.');
      }
      const width = Number(match[1]);
      const height = Number(match[2]);
      const slides = Number(options.slides);
      if (!Number.isInteger(slides) || slides < 1) {
        throw new Error('Invalid --slides. Use a positive integer.');
      }
      const html = createDeckHtml({ title: options.title, slides, width, height });
      await writeFile(resolve(io.cwd, file), html, 'utf8');
      io.stdout(`Created ${file}`);
    });

  program
    .command('validate <file>')
    .description('Validate a deck against the contract')
    .option('--json', 'print the result as JSON')
    .action(async (file: string, options: { json?: boolean }) => {
      const html = await readFile(resolve(io.cwd, file), 'utf8');
      const result = validateDeck(parseDeckHtml(html));
      if (options.json) {
        io.stdout(JSON.stringify(result, null, 2));
      } else {
        printDiagnostics(result, io);
      }
      if (!result.valid) exitCode = 1;
    });

  program
    .command('export <file>')
    .description('Export a deck')
    .option('--format <format>', 'output format', 'html')
    .option('--out <path>', 'output path')
    .action(async (file: string, options: { format: string; out?: string }) => {
      if (options.format !== 'html') {
        throw new Error(
          'Only html export is available in this milestone. Use --format html.'
        );
      }
      const sourcePath = resolve(io.cwd, file);
      const html = await readFile(sourcePath, 'utf8');
      const doc = parseDeckHtml(html);
      const result = validateDeck(doc);
      if (!result.valid) {
        printDiagnostics(result, io);
        exitCode = 1;
        return;
      }
      const parsedPath = parse(sourcePath);
      const destination = options.out
        ? resolve(io.cwd, options.out)
        : join(parsedPath.dir, `${parsedPath.name}.export.html`);
      await writeFile(destination, serializeExport(doc), 'utf8');
      io.stdout(`Exported ${destination}`);
    });

  program
    .command('open <file>')
    .description('Open the visual editor for a deck')
    .option('--port <port>', 'port to listen on', '0')
    .option('--no-browser', 'do not open a browser')
    .action(async (file: string, options: { port: string; browser: boolean }) => {
      const filePath = resolve(io.cwd, file);
      const directory = editorDir();
      await access(join(directory, 'index.html'));
      const host = await startHost({
        filePath,
        token: randomUUID(),
        editorDir: directory,
        port: Number(options.port)
      });

      io.stdout(`HTMLPPT_URL=${host.url}`);

      if (options.browser) {
        const { default: openUrl } = await import('open');
        await openUrl(host.url);
      }

      await new Promise<void>((resolvePromise) => {
        const stop = () => {
          void host.close().finally(() => resolvePromise());
        };
        process.once('SIGINT', stop);
        process.once('SIGTERM', stop);
      });
    });

  try {
    await program.parseAsync(argv, { from: 'user' });
  } catch (error) {
    if (error instanceof CommanderError) {
      return error.exitCode;
    }
    io.stderr(error instanceof Error ? error.message : String(error));
    return 1;
  }

  return exitCode;
}
```

`packages/cli/src/bin.ts`:

```ts
import { runCli } from './index.js';

const code = await runCli(process.argv.slice(2));
process.exitCode = code;
```

- [ ] **Step 4: Run the CLI tests and confirm GREEN**

Run: `npm run test -w @htmlppt/cli`

Expected: 5 tests pass.

- [ ] **Step 5: Build the CLI and verify the binary**

Run:

```bash
npm run build -w @htmlppt/runtime
npm run build -w @htmlppt/core
npm run build -w @htmlppt/host
npm run build -w @htmlppt/cli
node packages/cli/dist/bin.js --help
```

Expected: help text lists `new`, `validate`, `export`, `open`.

- [ ] **Step 6: Commit**

```bash
git add packages/cli
git commit -m "feat(cli): add new, validate, export, and open commands"
```

---

### Task 7: Walking skeleton — editor, save, export, runtime

**Files:**
- Create: `e2e/helpers.ts`
- Create: `e2e/skeleton.spec.ts`
- Create: `packages/editor/src/api.ts`
- Create: `packages/editor/src/slide-doc.ts`
- Create: `packages/editor/src/App.tsx`
- Modify: `packages/editor/src/main.tsx`
- Create: `packages/editor/src/index.css`

**Interfaces:**
- Consumes: host API `GET /api/deck`, `PUT /api/deck`.
- Produces: a built editor at `packages/editor/dist` served by `htmlppt open`; text edits commit on blur/Escape and persist; export uses the runtime.

- [ ] **Step 1: Write the failing walking-skeleton E2E test**

`e2e/helpers.ts`:

```ts
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
```

`e2e/skeleton.spec.ts`:

```ts
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test } from '@playwright/test';
import { execa } from 'execa';
import { serveHtml, startCliHost } from './helpers';

const repoRoot = fileURLToPath(new URL('..', import.meta.url));
const cliPath = join(repoRoot, 'packages/cli/dist/bin.js');

test(
  'walking skeleton: create, edit, save, export, present',
  { tag: '@feature:skeleton' },
  async ({ page }) => {
    const directory = await mkdtemp(join(tmpdir(), 'htmlppt-e2e-'));
    let host: Awaited<ReturnType<typeof startCliHost>> | undefined;
    let staticServer: Awaited<ReturnType<typeof serveHtml>> | undefined;

    try {
      await execa('node', [cliPath, 'new', 'demo.html', '--slides', '2'], {
        cwd: directory
      });
      await execa('node', [cliPath, 'validate', 'demo.html'], {
        cwd: directory
      });

      host = await startCliHost(cliPath, directory, 'demo.html');
      await page.goto(host.url);
      const frame = page.frameLocator('iframe[title="Slide preview"]');
      await expect(frame.locator('h1')).toContainText('Untitled deck');

      await frame.locator('h1').dblclick();
      await frame.locator('h1').fill('Updated deck title');
      await frame.locator('h1').press('Escape');
      await expect(page.getByTestId('save-status')).toHaveText('已儲存');

      const saved = await readFile(join(directory, 'demo.html'), 'utf8');
      expect(saved).toContain('Updated deck title');
      expect(saved).not.toContain('contenteditable');

      await execa(
        'node',
        [cliPath, 'export', 'demo.html', '--format', 'html'],
        { cwd: directory }
      );
      const exported = await readFile(
        join(directory, 'demo.export.html'),
        'utf8'
      );
      expect(exported).toContain(
        '<!-- Edited with htmlppt. Format: htmldeck/v1. -->'
      );
      expect(exported).toContain('Updated deck title');
      expect(exported).not.toContain('contenteditable');

      staticServer = await serveHtml(exported);
      await page.goto(staticServer.url);
      await expect(page.locator('[data-slide-id="s1"]')).toBeVisible();
      await expect(page.locator('[data-slide-id="s2"]')).toBeHidden();
      await page.keyboard.press('ArrowRight');
      await expect(page.locator('[data-slide-id="s2"]')).toBeVisible();
      expect(page.url()).toContain('#/2');
    } finally {
      if (staticServer) await staticServer.close();
      await host?.stop();
      await rm(directory, { recursive: true, force: true });
    }
  }
);
```

- [ ] **Step 2: Run the test and confirm RED**

Run:

```bash
npm run build
npx playwright install chromium
npx playwright test e2e/skeleton.spec.ts
```

Expected: FAIL. The CLI's `open` command may exist, but `packages/editor/dist/index.html` is missing (the editor has no build) or the iframe never renders.

- [ ] **Step 3: Implement the editor API client**

`packages/editor/src/api.ts`:

```ts
export interface DeckResponse {
  html: string;
  revision: string;
  filePath: string;
}

export function tokenFromLocation(): string {
  return new URLSearchParams(location.search).get('token') ?? '';
}

export async function fetchDeck(token: string): Promise<DeckResponse> {
  const response = await fetch('/api/deck', {
    headers: { authorization: `Bearer ${token}` }
  });
  if (!response.ok) {
    throw new Error(`Failed to load deck (${response.status})`);
  }
  return (await response.json()) as DeckResponse;
}

export async function saveDeck(
  token: string,
  html: string,
  baseRevision: string
): Promise<{ revision: string }> {
  const response = await fetch('/api/deck', {
    method: 'PUT',
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json'
    },
    body: JSON.stringify({ html, baseRevision })
  });
  if (!response.ok) {
    const detail = await response.text();
    throw new Error(`Save failed (${response.status}): ${detail}`);
  }
  return (await response.json()) as { revision: string };
}
```

- [ ] **Step 4: Implement slide document helpers**

`packages/editor/src/slide-doc.ts`:

```ts
import { serializeDeck, type SlideInfo } from '@htmlppt/core';

const BASE_STYLE = `
html, body { margin: 0 !important; padding: 0 !important; overflow: hidden !important; background: transparent !important; }
[data-slide-id] { margin: 0 !important; }
`;

export function parseDeck(html: string): Document {
  return new DOMParser().parseFromString(html, 'text/html');
}

export function buildSlideSrcDoc(doc: Document, slide: SlideInfo): string {
  return `<!doctype html><html><head>${doc.head.innerHTML}<style data-ppt-editor-base>${BASE_STYLE}</style></head><body>${slide.element.outerHTML}</body></html>`;
}

export function commitSlide(
  doc: Document,
  slideId: string,
  frameDocument: Document
): string {
  const current = frameDocument.querySelector('[data-slide-id]');
  if (!current) throw new Error('Slide is missing from the editor frame.');

  current
    .querySelectorAll('[contenteditable]')
    .forEach((element) => element.removeAttribute('contenteditable'));

  const target = doc.querySelector(
    `[data-slide-id="${CSS.escape(slideId)}"]`
  );
  if (!target) throw new Error(`Slide ${slideId} is missing from the deck.`);

  target.outerHTML = current.outerHTML;
  return serializeDeck(doc);
}
```

- [ ] **Step 5: Implement the editor UI**

`packages/editor/src/App.tsx`:

```tsx
import { useCallback, useEffect, useRef, useState } from 'react';
import { detectSlides, type SlideInfo } from '@htmlppt/core';
import { fetchDeck, saveDeck, tokenFromLocation } from './api';
import { buildSlideSrcDoc, commitSlide, parseDeck } from './slide-doc';

type SaveStatus = 'loading' | 'ready' | 'saving' | 'saved' | 'error';

const STATUS_LABEL: Record<SaveStatus, string> = {
  loading: '載入中…',
  ready: '已載入',
  saving: '儲存中…',
  saved: '已儲存',
  error: '儲存失敗'
};

export function App() {
  const token = useRef(tokenFromLocation());
  const master = useRef<Document | null>(null);
  const revision = useRef('');
  const frame = useRef<HTMLIFrameElement | null>(null);
  const canvas = useRef<HTMLElement | null>(null);

  const [slides, setSlides] = useState<SlideInfo[]>([]);
  const [activeIndex, setActiveIndex] = useState(0);
  const [srcDoc, setSrcDoc] = useState('');
  const [scale, setScale] = useState(1);
  const [status, setStatus] = useState<SaveStatus>('loading');
  const [error, setError] = useState('');
  const [filePath, setFilePath] = useState('');

  const activeSlide = slides[activeIndex];

  const showSlide = useCallback((doc: Document, index: number) => {
    const list = detectSlides(doc);
    const clamped = Math.max(0, Math.min(index, list.length - 1));
    setSlides(list);
    setActiveIndex(clamped);
    const slide = list[clamped];
    setSrcDoc(slide ? buildSlideSrcDoc(doc, slide) : '');
  }, []);

  useEffect(() => {
    void (async () => {
      try {
        const deck = await fetchDeck(token.current);
        const doc = parseDeck(deck.html);
        master.current = doc;
        revision.current = deck.revision;
        setFilePath(deck.filePath);
        setStatus('ready');
        showSlide(doc, 0);
      } catch (cause) {
        setStatus('error');
        setError(cause instanceof Error ? cause.message : String(cause));
      }
    })();
  }, [showSlide]);

  useEffect(() => {
    const updateScale = () => {
      if (!canvas.current || !activeSlide) return;
      const bounds = canvas.current.getBoundingClientRect();
      setScale(
        Math.min(
          (bounds.width - 96) / activeSlide.width,
          (bounds.height - 96) / activeSlide.height,
          1
        )
      );
    };
    updateScale();
    window.addEventListener('resize', updateScale);
    return () => window.removeEventListener('resize', updateScale);
  }, [activeSlide]);

  const commit = useCallback(
    async (editable: HTMLElement) => {
      const doc = master.current;
      const slide = slides[activeIndex];
      const frameDocument = frame.current?.contentDocument;
      if (!doc || !slide || !frameDocument) return;

      editable.removeAttribute('contenteditable');
      try {
        const html = commitSlide(doc, slide.id, frameDocument);
        setStatus('saving');
        const result = await saveDeck(token.current, html, revision.current);
        revision.current = result.revision;
        setSlides(detectSlides(doc));
        setStatus('saved');
        setError('');
      } catch (cause) {
        editable.setAttribute('contenteditable', 'true');
        setStatus('error');
        setError(cause instanceof Error ? cause.message : String(cause));
      }
    },
    [activeIndex, slides]
  );

  const onFrameLoad = useCallback(() => {
    const frameDocument = frame.current?.contentDocument;
    if (!frameDocument) return;

    frameDocument.addEventListener('dblclick', (event) => {
      const target = event.target as HTMLElement | null;
      if (!target || !target.closest('[data-slide-id]')) return;
      const editable = target.closest(
        'h1, h2, h3, p, li, span, td, th, blockquote, figcaption'
      ) as HTMLElement | null;
      if (!editable || !editable.textContent?.trim()) return;
      event.preventDefault();
      editable.setAttribute('contenteditable', 'true');
      editable.focus();
    });

    frameDocument.addEventListener('keydown', (event) => {
      if (event.key !== 'Escape') return;
      const editable = frameDocument.querySelector(
        '[contenteditable]'
      ) as HTMLElement | null;
      editable?.blur();
    });

    frameDocument.addEventListener('focusout', (event) => {
      const target = event.target as HTMLElement | null;
      if (target?.hasAttribute('contenteditable')) {
        void commit(target);
      }
    });

    frameDocument.addEventListener('click', (event) => {
      const link = (event.target as HTMLElement | null)?.closest('a');
      if (link) event.preventDefault();
    });
  }, [commit]);

  const goTo = (index: number) => {
    if (!master.current) return;
    showSlide(master.current, index);
  };

  return (
    <div className="flex h-screen flex-col bg-[#0f1115] text-zinc-100">
      <header className="flex items-center justify-between border-b border-white/10 px-5 py-3">
        <div className="flex min-w-0 items-center gap-3">
          <span className="text-sm font-semibold tracking-wide">htmlppt</span>
          <span className="truncate text-xs text-zinc-400">{filePath}</span>
        </div>
        <div className="flex items-center gap-4 text-xs">
          <span
            data-testid="save-status"
            className={status === 'error' ? 'text-red-400' : 'text-zinc-400'}
          >
            {STATUS_LABEL[status]}
          </span>
          <button
            type="button"
            className="rounded border border-white/15 px-2 py-1 disabled:opacity-40"
            onClick={() => goTo(activeIndex - 1)}
            disabled={activeIndex <= 0}
          >
            上一頁
          </button>
          <span className="tabular-nums text-zinc-400">
            {slides.length === 0 ? 0 : activeIndex + 1} / {slides.length}
          </span>
          <button
            type="button"
            className="rounded border border-white/15 px-2 py-1 disabled:opacity-40"
            onClick={() => goTo(activeIndex + 1)}
            disabled={activeIndex >= slides.length - 1}
          >
            下一頁
          </button>
        </div>
      </header>

      <div className="flex min-h-0 flex-1">
        <aside className="w-44 shrink-0 border-r border-white/10 p-3">
          <div className="flex flex-col gap-2">
            {slides.map((slide, index) => (
              <button
                key={slide.id}
                type="button"
                onClick={() => goTo(index)}
                className={`rounded border px-3 py-2 text-left text-xs ${
                  index === activeIndex
                    ? 'border-amber-400/70 bg-amber-400/10 text-amber-200'
                    : 'border-white/10 text-zinc-400 hover:border-white/25'
                }`}
              >
                第 {index + 1} 頁
              </button>
            ))}
          </div>
        </aside>

        <main
          ref={canvas}
          className="relative flex min-w-0 flex-1 items-center justify-center overflow-hidden bg-[#0a0c10] p-12"
        >
          {error && (
            <div className="absolute left-4 top-4 max-w-lg rounded border border-red-500/40 bg-red-950/80 px-3 py-2 text-xs text-red-200">
              {error}
            </div>
          )}

          {activeSlide ? (
            <div
              className="relative shadow-2xl shadow-black/60"
              style={{
                width: activeSlide.width * scale,
                height: activeSlide.height * scale
              }}
            >
              <iframe
                ref={frame}
                title="Slide preview"
                sandbox="allow-same-origin"
                srcDoc={srcDoc}
                onLoad={onFrameLoad}
                className="absolute left-0 top-0 border-0 bg-white"
                style={{
                  width: activeSlide.width,
                  height: activeSlide.height,
                  transform: `scale(${scale})`,
                  transformOrigin: 'top left'
                }}
              />
            </div>
          ) : (
            <p className="text-sm text-zinc-500">No slides found.</p>
          )}
        </main>
      </div>
    </div>
  );
}
```

`packages/editor/src/main.tsx`:

```tsx
import { createRoot } from 'react-dom/client';
import { App } from './App';
import './index.css';

const root = document.getElementById('root');
if (!root) throw new Error('Missing #root element');

createRoot(root).render(<App />);
```

`packages/editor/src/index.css`:

```css
@import "tailwindcss";

html,
body,
#root {
  height: 100%;
}

body {
  margin: 0;
}

* {
  box-sizing: border-box;
}
```

- [ ] **Step 6: Build and run the walking skeleton**

Run:

```bash
npm run build
npx playwright test e2e/skeleton.spec.ts
```

Expected: PASS. If it fails, inspect the Playwright trace and fix the real cause (do not add retries or skips).

- [ ] **Step 7: Run all checks available at this point**

Run:

```bash
npm run lint && npm run lint:deps && npm run typecheck && npm run test:unit && npm run test:integration && npm run test:e2e
```

Expected: all pass. The feature matrix gate is added in Task 8; `npm run verify` runs after that.

- [ ] **Step 8: Commit**

```bash
git add packages/editor e2e
git commit -m "feat(editor): add walking skeleton with text editing and save"
```

---

### Task 8: CI, feature matrix, contributor docs

**Files:**
- Create: `scripts/check-feature-coverage.mjs`
- Create: `.github/workflows/ci.yml`
- Create: `.github/pull_request_template.md`
- Create: `docs/testing.md`

**Interfaces:**
- Consumes: `docs/features.json`; `@feature:` tags in `e2e/**/*.spec.ts`.
- Produces: `npm run test:matrix` gate; CI jobs for static, unit, integration, E2E, matrix; PR checklist.

Configuration and documentation files are exempt from TDD. Verify by running the scripts.

- [ ] **Step 1: Implement the feature matrix gate**

`scripts/check-feature-coverage.mjs`:

```js
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = new URL('..', import.meta.url);
const e2eDir = fileURLToPath(new URL('e2e/', root));
const manifestPath = fileURLToPath(new URL('docs/features.json', root));
const tagPattern = /@feature:([a-z0-9-]+)/g;

async function collectFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...(await collectFiles(path)));
    else if (entry.isFile() && entry.name.endsWith('.spec.ts')) files.push(path);
  }
  return files;
}

const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
const files = await collectFiles(e2eDir);
const tags = new Set();

for (const file of files) {
  const source = await readFile(file, 'utf8');
  for (const match of source.matchAll(tagPattern)) tags.add(match[1]);
}

const errors = [];
const known = new Map(manifest.features.map((feature) => [feature.id, feature]));

for (const feature of manifest.features) {
  if (feature.status === 'active' && !tags.has(feature.id)) {
    errors.push(`Active feature "${feature.id}" has no @feature:${feature.id} test.`);
  }
}

for (const tag of tags) {
  if (!known.has(tag)) {
    errors.push(`Test tag @feature:${tag} has no entry in docs/features.json.`);
  }
}

if (errors.length > 0) {
  console.error('Feature matrix check failed:');
  for (const error of errors) console.error(`- ${error}`);
  process.exit(1);
}

console.log(
  `Feature matrix OK: ${manifest.features.filter((f) => f.status === 'active').length} active, ${tags.size} tagged test feature(s).`
);
```

- [ ] **Step 2: Run the matrix gate**

Run: `npm run test:matrix`

Expected: `Feature matrix OK: 1 active, 1 tagged test feature(s).`

- [ ] **Step 3: Add CI**

`.github/workflows/ci.yml`:

```yaml
name: CI

on:
  push:
  pull_request:

jobs:
  static:
    name: Static checks
    runs-on: ubuntu-latest
    strategy:
      matrix:
        node: [20, 22]
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: ${{ matrix.node }}
          cache: npm
      - run: npm ci
      - run: npm run lint
      - run: npm run lint:deps
      - run: npm run typecheck

  unit:
    name: Unit tests
    runs-on: ubuntu-latest
    strategy:
      matrix:
        node: [20, 22]
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: ${{ matrix.node }}
          cache: npm
      - run: npm ci
      - run: npm run test:unit

  integration:
    name: Integration tests
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 22
          cache: npm
      - run: npm ci
      - run: npm run test:integration

  integration-windows:
    name: Integration tests (Windows)
    runs-on: windows-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 22
          cache: npm
      - run: npm ci
      - run: npm run test:integration

  e2e:
    name: E2E (Chromium)
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 22
          cache: npm
      - run: npm ci
      - run: npx playwright install --with-deps chromium
      - run: npm run build
      - run: npm run test:e2e
      - uses: actions/upload-artifact@v4
        if: failure()
        with:
          name: playwright-artifacts
          path: |
            test-results
            playwright-report
          if-no-files-found: ignore

  feature-matrix:
    name: Feature matrix
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 22
          cache: npm
      - run: npm ci
      - run: npm run test:matrix
```

- [ ] **Step 4: Add the PR template and contributor guide**

`.github/pull_request_template.md`:

```markdown
## What changed

## TDD evidence
- [ ] Wrote the failing test first and confirmed it failed for the right reason
- [ ] Added or updated a `@feature:<id>` tag and `docs/features.json`
- [ ] `npm run verify` passes locally or in CI

## Tests
- [ ] Unit
- [ ] Integration
- [ ] E2E
- [ ] Visual (if rendering changed)
- [ ] Docs/skill updated (if agent-facing behavior changed)

## Risks
```

`docs/testing.md`:

```markdown
# Testing

This project follows strict TDD: write a failing test, confirm it fails for the right reason, then implement minimal code.

## Commands

- `npm run test:unit` — core unit tests
- `npm run test:integration` — host, CLI, filesystem, HTTP
- `npm run test:e2e` — Playwright Chromium
- `npm run test:matrix` — feature tag coverage
- `npm run verify:fast` — lint, boundaries, types, unit, integration, matrix
- `npm run verify` — everything, including E2E

## Adding a feature

1. Add the feature id to `docs/features.json` with `status: "planned"`.
2. Write an E2E or integration test tagged `@feature:<id>` and confirm it fails.
3. Flip the manifest entry to `status: "active"`.
4. Implement the minimum to pass.
5. Run `npm run verify` and commit.

## Rules

- No `skip`, no retries, no mocking the host or filesystem in integration tests.
- Bug fixes start with a reproduction test.
- Do not edit golden files or baselines to force a green suite.

See `docs/superpowers/specs/2026-10-21-test-framework-design.md` for the full strategy.
```

- [ ] **Step 5: Verify the gates**

Run:

```bash
npm run test:matrix
npm run lint
npm run typecheck
```

Expected: all pass.

- [ ] **Step 6: Commit**

```bash
git add scripts .github docs/testing.md
git commit -m "chore: add CI, feature matrix gate, and contributor docs"
```

---

### Task 9: M0 exit verification

**Files:** none created; verification only.

**Interfaces:** none.

- [ ] **Step 1: Run the complete verification gate**

```bash
npm run verify
```

Expected: all checks pass. If a check fails, fix the root cause with a test first; do not skip or add retries.

- [ ] **Step 2: Confirm the skeleton manually**

```bash
npm run build
mkdir -p /tmp/htmlppt-demo
node packages/cli/dist/bin.js new /tmp/htmlppt-demo/demo.html --slides 2
node packages/cli/dist/bin.js open /tmp/htmlppt-demo/demo.html
```

Expected: the browser opens; double-clicking the title edits it; the header shows `已儲存`; the original file contains the edit; closing with Ctrl+C stops the host.

- [ ] **Step 3: Commit any fixes**

```bash
git add -A
git commit -m "test: complete M0 verification"
```

Only commit if Step 1 or 2 required changes. Otherwise skip this commit.

---

## M0 exit criteria

- `npm run verify` is green, including the walking-skeleton E2E.
- `htmlppt new`, `validate`, `open`, and `export html` work from the built CLI.
- The editor renders a real slide in a sandboxed iframe; text edits persist to the file with no editor artifacts.
- The exported deck contains the runtime, navigates with arrow keys, and updates the hash.
- CI runs static, unit, integration, E2E, Windows integration, and feature matrix jobs.
- The feature manifest and PR checklist are in place for the next plan.

## Next plan

After M0, write and execute `2026-10-21-m1-core-contract-engine.md`, then M2 (host live sync, MCP, skill), then M3/M4 editor features, then M5 export/release.
