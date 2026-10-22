# M5 Export, Hardening, Packaging, and Release Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Finish v1: PDF/PNG export with a system Chromium, visual round-trip coverage, security and accessibility hardening, real release documentation, cross-platform CI, and the final acceptance pass. This milestone prepares the project for publishing but does not push or publish without explicit user authorization.

**Architecture:** A `packages/renderer` workspace uses `playwright-core` with a detected system Chromium to turn deck HTML into PDF (one page per slide) or per-slide PNGs at 2× scale. The host exposes `POST /api/export`; the CLI and MCP call the same renderer. Visual tests compare standalone-rendered slides with editor/export rendering using pixelmatch/pngjs. Security and accessibility tests exercise the real host and editor. Release work adds README/LICENSE/CONTRIBUTING/SECURITY, contract and MCP docs, package smoke, and Ubuntu/Windows CI on Node 20/22.

**Tech Stack:** `playwright-core` (system Chromium), `pixelmatch`, `pngjs` (dev), Playwright, Vitest, tsup, GitHub Actions.

**Spec:** design §9 Export, §13 Security, §14 Testing, §15 Acceptance; test framework §10–§13.

## Global Constraints

- No telemetry, no remote services. PDF/PNG rendering is local and treats the deck as untrusted.
- Renderer uses `HTMLPPT_CHROMIUM` or a detected Chrome/Edge/Chromium; when unavailable, return actionable instructions (host 501, CLI/MCP structured errors), never a silent fallback.
- PDF page size = first slide canvas size; mixed decks warn. Print backgrounds; no editor chrome; hidden runtime slides are shown per slide.
- PNG per slide at 2× device scale, named `<basename>-s1.png` etc.
- No push, PR, npm publish, or remote repository creation without explicit user authorization.
- New dependencies: `playwright-core` and `pdf-lib` (runtime), `pixelmatch`/`pngjs`/`pdfjs-dist` and optional direct `@napi-rs/canvas` declaration (dev), recorded here. PDF normalization uses a structural library, not a handwritten byte parser.

## File Structure

```
packages/renderer/                 new package
  src/index.ts                     detect browser, renderPdf, renderPngs
  src/browser.ts                   Chromium discovery
  test/renderer.test.ts
packages/host/src/server.ts        POST /api/export
packages/host/test/export.test.ts
packages/cli/src/index.ts          export pdf|png, actionable renderer errors
packages/cli/test/cli.test.ts
packages/mcp/src/tools.ts          export_deck pdf/png
packages/mcp/test/mcp-stdio.test.ts
e2e/export.spec.ts                 @feature:export-pdf-png
e2e/visual.spec.ts                 visual round-trip
e2e/security.spec.ts
e2e/a11y.spec.ts
docs/README.md, docs/contract.md, docs/mcp.md, CONTRIBUTING.md, SECURITY.md, LICENSE
.github/workflows/ci.yml
scripts/package-smoke.mjs
```

---

### Task 1: Chromium discovery and PDF/PNG renderer

**Files:** `packages/renderer/*` (new), root `package.json`, `package-lock.json`, `tsconfig.json`, and `dependency-cruiser.cjs` only for renderer wiring.

**Interfaces:**
- New workspace `@htmlppt/renderer` owns browser-only rendering; core remains browser-independent. Build renderer after core and before host; wire renderer tests into `test:integration`. Runtime dependency `playwright-core` is `^1.64.1`; `pdf-lib ^1.17.1` is explicitly approved for structural PDF page-size/content-coordinate normalization instead of handwritten PDF parsing. PDF assertions use a Node-20-compatible `pdfjs-dist` dev dependency as specified by the test-framework design, and PNG assertions use the planned `pngjs` dev dependency. Tests may explicitly declare the already PDF.js-installed `@napi-rs/canvas` as a dev dependency for PDF raster edge assertions; it must not enter the runtime bundle.
- `findChromium(env?): Promise<{ executablePath: string; source: 'env'|'chrome'|'edge'|'chromium' } | null>` — checks `HTMLPPT_CHROMIUM`, then platform default Chrome/Edge/Chromium locations and Playwright browser caches; returns null when none. A supplied invalid `HTMLPPT_CHROMIUM` is authoritative and never falls through to another browser.
- `renderPdf({ html, width, height, outPath }): Promise<void>` — local Chromium with its sandbox enabled, isolated context with `javaScriptEnabled: false`, no service workers, no file access or navigation from authored content. Load with `page.setContent(html)`. Only HTTP(S) image/font/stylesheet asset requests declared by the document/CSS are permitted; no scripts, fetch/XHR, frames, workers, WebSockets, or arbitrary document requests. Trusted Playwright evaluation may prepare layout; authored scripts remain inert and original HTML is unchanged.
- Wait for external stylesheets before reading/fixing display and geometry, within the finite asset deadline. Prepare all detected slides for print independently of executing the runtime: expose navigation-hidden slides using their authored active-state display (including active-class flex/grid), page-break after each except the last, first-canvas page size, backgrounds and zero margins. Wait for fonts/images including those requested by revealed layout; timeout must close resources and return an actionable RenderError, not hang or silently report fidelity.
- Preserve exact PDF page boxes and content coordinates together. Chromium may quantize CSS page dimensions; use structural PDF parsing to adjust page dimensions and the corresponding content translation without clipping or adding edge strips. Never search the full PDF byte stream with regex for object/trailer boundaries. Test adversarial-but-valid title metadata and rasterized top/bottom/left/right edge pixels, not only page-count/MediaBox equality.
- `renderPngs({ html, width, height, outDir, basename }): Promise<string[]>` — one screenshot per detected slide at 2× scale, including decks without explicit slide-id markers supported by core detection; isolate each slide, preserve authored layout, use per-slide canvas dimensions with provided dimensions as fallback; deterministic `<basename>-sN.png` names. Validate basename as a filename, not a path.
- Errors: exported `RendererUnavailableError` with install/HTMLPPT_CHROMIUM instructions; exported `RenderError` with the failing slide where applicable. Always close page/context/browser in finally, including output failures. Outputs must not expose partial files; stage each output locally before atomic placement. Host output-directory confinement belongs to Task 2.
- Tests use real installed Chromium and real files: a 2-slide deck yields a PDF parsed by pdfjs-dist with 2 pages of width*72/96 by height*72/96 points and two PNGs of 2× canvas dimensions; test flex layout, runtime-hidden slides, background content, mixed slide dimensions, no source mutation, output failures and invalid basename. A missing executable via authoritative env override returns RendererUnavailableError even when another browser is installed.
- Assert renderer isolation with a real local HTTP asset server: an image/font may load, authored script cannot trigger a side effect, iframe/file/navigation/fetch requests do not reach forbidden endpoints. Do not disable Chromium's sandbox in tests.
- A machine lacking Chromium must report the renderer test environment as blocked and assert the error path; it cannot claim rendering acceptance. No skipped tests, fake Chromium, or replacing successful-render expectations with weaker missing-browser assertions.

**Steps:** renderer tests first and observed RED; implement; run renderer tests, typecheck, lint, dependency gate and build with preserved command exit codes. Do not edit host/CLI/MCP/editor integration in this task.

**Commit:** `feat(renderer): add system Chromium PDF and PNG export`.

---

### Task 2: Host export endpoint

**Files:** `packages/host/src/server.ts`, tests.

**Interfaces:** `POST /api/export { format: 'pdf'|'png', outDir? }` → `{ files: string[] }`; auth/origin required; path resolution constrained to the deck directory + requested outDir; default names; 501 with instructions when no renderer; 400 for unsupported format; no shell execution.

**Tests:** real host + renderer; default output names; custom outDir; no token 401; foreign origin 403; unsupported format 400; renderer unavailable 501 (env override); the source deck is unchanged.

**Commit:** `feat(host): add PDF and PNG export endpoint`.

---

### Task 3: CLI and MCP export formats

**Files:** `packages/cli/src/index.ts`, `packages/mcp/src/tools.ts`, tests, skills docs.

**Interfaces:**
- `htmlppt export <file> --format pdf|png [--out <path>]`: PDF uses `--out` as a file path; PNG uses `--out` as a directory (default next to the deck). Prints absolute paths. Actionable error when Chromium is unavailable.
- `export_deck({ path, format: 'html'|'pdf'|'png', outDir? })` returns absolute paths; host-attached mode calls the host endpoint, direct mode uses the renderer.
- Update the skill/MCP reference.

**Tests:** real CLI export to a temp dir; MCP direct and host-attached exports; invalid format; renderer unavailable message; no leftover temp files.

**Commit:** `feat: add PDF and PNG export to CLI and MCP`.

---

### Task 4: Visual round-trip tests

**Files:** `e2e/visual.spec.ts`, dev dependencies `pixelmatch`, `pngjs`, fixtures.

**Interfaces:**
- For every contract fixture with fixed canvas: render the source standalone, export HTML, render the export, compare per-slide screenshots; mismatch threshold < 0.1% differing pixels.
- Editing round-trip: open the export in the editor, make a scripted edit, export, render, compare the edited slide with the editor canvas (same viewport/device scale); assert the unedited slide still matches the original within threshold.
- Output diffs to `test-results/visual/` on failure.

**Tests:** run for `basic`, `rich`, `animated`, `external` (external assets may require network; if offline, use local data URIs for the visual fixture) and a mixed-size deck (PDF uses the first slide size; warning).

**Commit:** `test(e2e): add visual round-trip coverage`.

---

### Task 5: Security hardening and tests

**Files:** `e2e/security.spec.ts`, host/editor fixes as needed.

**Checklist:**
- Host: token required for page/API/SSE/export; wrong token 401; foreign Origin 403; encoded path traversal and static deck access blocked; only the opened file is read/written; no directory listing; export paths cannot escape the deck dir.
- MCP: direct mode only writes explicit paths; host mode uses tokens; no shell interpolation from file paths; error messages do not leak tokens.
- Editor: iframe sandbox without scripts; deck scripts/onerror never execute; exported scripts preserved but not run by host/CLI; paste/link sanitization rejects `javascript:`.
- Renderer: no network beyond deck assets (block other requests in the browser context), no local file access from deck JS, no shell.
- Session registry file permissions 0600 (where supported) and token not logged.

**Tests:** real host, real MCP, real Chromium; assert behavior, not just status codes. Fix any finding in the same task.

**Commit:** `test(security): harden host, MCP, editor, and renderer`.

---

### Task 6: Accessibility hardening and tests

**Files:** editor components, `e2e/a11y.spec.ts`.

**Checklist:**
- All toolbar/rail/inspector controls reachable by keyboard with visible focus; icon-only buttons have `aria-label` (Traditional Chinese where user-facing).
- Dialogs trap focus, close on Escape, restore focus; the canvas iframe has a title; selection state is announced via an `aria-live` status.
- Shortcut help dialog lists bindings; color is not the only selection indicator.
- Contrast meets WCAG AA for editor chrome (not deck content).
- Play/presenter keys work without a mouse.

**Tests:** Playwright keyboard-only flows; focus trap; accessible names; `aria-live` updates; no positive tabindex.

**Commit:** `feat(editor): improve accessibility and add a11y tests`.

---

### Task 7: Release documentation and packaging

**Files:** `README.md`, `LICENSE` (MIT), `CONTRIBUTING.md`, `SECURITY.md`, `docs/contract.md`, `docs/mcp.md`, `docs/architecture.md`, `skills/htmlppt/`, `packages/htmlppt/*`, `scripts/package-smoke.mjs`.

**Content:**
- README: what it is, quick start (`npx htmlppt open deck.html`), agent workflow, contract summary, editor features, security model, limitations, development commands.
- Contract doc: every required/optional attribute, examples, normalization/validation rules, export guarantees.
- MCP reference: modes, tools, resources, target selectors, errors, example transcripts.
- CONTRIBUTING: setup, TDD, test layers, worktree/merge workflow, code style.
- SECURITY: local-only model, token/origin, iframe sandbox, renderer isolation, reporting.
- LICENSE: MIT.
- Package files include editor assets, skill, bins; smoke test asserts them.

**Tests:** `npm run test:package`; docs commands executed verbatim in a temp dir during the smoke test (at least new/validate/open/MCP).

**Commit:** `docs: add release documentation`.

---

### Task 8: Cross-platform CI and final acceptance

**Files:** `.github/workflows/ci.yml`, root scripts, `docs/features.json`.

**Steps:**
- CI matrix: Ubuntu + Windows, Node 20 + 22. Jobs: install, lint, depcruise, typecheck, unit, integration, build, Playwright (install Chromium), matrix, package smoke. Cache npm and Playwright browsers. Upload traces/videos on failure.
- Ensure Windows path handling, CRLF (.gitattributes), session registry permissions, process stop (SIGTERM), and renderer discovery pass.
- Add a `verify:all` script that runs `verify` + `test:package`.
- Run the full acceptance checklist from design §15, including a manual presenter/export/dirty-conflict pass. Record evidence in the M5 report.
- Update `docs/features.json` so every shipped v1 feature is active and tagged.
- Final whole-branch review, merge, post-merge verify. Do not publish.

**Commit:** `ci: add cross-platform gates and release checks`.

---

## M5 Exit

- All acceptance criteria in design §15 pass with recorded evidence.
- `npm run verify`, `npm run test:package`, and CI on Ubuntu/Windows Node 20/22 are green.
- README/LICENSE/CONTRIBUTING/SECURITY/contract/MCP docs exist.
- The package tarball contains the editor, skill, CLI, and MCP bins.
- Release is prepared; publishing waits for explicit user authorization.

---

## Amendment (2026-10-23): final-release acceptance gaps

The Task 8 acceptance review found three items that the M4 exit explicitly
deferred to M5 but this plan never allocated. They are in scope before the M5
merge:

### Task 8a: Editor export UI and host HTML export

**Files:** `packages/host/src/server.ts`, `packages/host/test/export.test.ts`,
`packages/editor/src/api.ts`, `packages/editor/src/components/Toolbar.tsx`,
`packages/editor/src/App.tsx`, `e2e/export-ui.spec.ts`, docs.

- Extend `POST /api/export` with `format: "html"`; write
  `<basename>.export.html` inside the confined `outDir` using
  `serializeExport`, and keep PDF/PNG behavior unchanged.
- Replace the disabled toolbar placeholder with an accessible Export menu
  (HTML / PDF / PNG), wired to Ctrl/Cmd+Shift+E, with busy/error/result
  feedback.
- Host mode writes through the endpoint; standalone mode downloads HTML and
  explains that PDF/PNG require a host.

### Task 8b: IndexedDB crash recovery

**Files:** new `packages/editor/src/recovery.ts` (+ test),
`packages/editor/src/App.tsx`, `packages/editor/src/use-deck-controller.ts`,
E2E recovery test.

- Persist dirty master HTML to IndexedDB (debounced), keyed by deck path.
- After a reload with an unsaved draft, show a recovery banner offering
  restore or discard; restore marks the deck dirty so autosave persists it.
- Clear the draft once a save succeeds.

### Task 8c: Standalone upload/download mode

**Files:** new `packages/editor/src/standalone.ts` (+ test),
`packages/editor/src/api.ts`, `packages/editor/src/App.tsx`,
`packages/editor/src/use-deck-controller.ts`, `e2e/standalone.spec.ts`.

- When `/api/deck` is unavailable, show an open/drop empty state and load a
  local HTML file into the editor.
- Save in place through a File System Access handle; otherwise autosave to
  IndexedDB and download through Ctrl+S / Export HTML.
- PDF/PNG are disabled in standalone mode with actionable guidance.

Each item is test-first. The final acceptance run must include the new
`@feature:standalone` and `@feature:recovery` matrix rows.
