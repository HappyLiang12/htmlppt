# M5 Export, Hardening, Packaging, and Release Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Finish v1: PDF/PNG export with a system Chromium, visual round-trip coverage, security and accessibility hardening, real release documentation, cross-platform CI, and the final acceptance pass. This milestone prepares the project for publishing but does not push or publish without explicit user authorization.

**Architecture:** A renderer module in `packages/core`/`packages/host` uses `playwright-core` with a detected system Chromium to turn deck HTML into PDF (one page per slide) or per-slide PNGs at 2× scale. The host exposes `POST /api/export`; the CLI and MCP call the same renderer. Visual tests compare standalone-rendered slides with editor/export rendering using pixelmatch/pngjs. Security and accessibility tests exercise the real host and editor. Release work adds README/LICENSE/CONTRIBUTING/SECURITY, contract and MCP docs, package smoke, and Ubuntu/Windows CI on Node 20/22.

**Tech Stack:** `playwright-core` (system Chromium), `pixelmatch`, `pngjs` (dev), Playwright, Vitest, tsup, GitHub Actions.

**Spec:** design §9 Export, §13 Security, §14 Testing, §15 Acceptance; test framework §10–§13.

## Global Constraints

- No telemetry, no remote services. PDF/PNG rendering is local and treats the deck as untrusted.
- Renderer uses `HTMLPPT_CHROMIUM` or a detected Chrome/Edge/Chromium; when unavailable, return actionable instructions (host 501, CLI/MCP structured errors), never a silent fallback.
- PDF page size = first slide canvas size; mixed decks warn. Print backgrounds; no editor chrome; hidden runtime slides are shown per slide.
- PNG per slide at 2× device scale, named `<basename>-s1.png` etc.
- No push, PR, npm publish, or remote repository creation without explicit user authorization.
- New dependencies: `playwright-core` (runtime), `pixelmatch`/`pngjs` (dev), recorded here.

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

**Files:** `packages/renderer/*` (new), root build scripts, dependencies.

**Interfaces:**
- `findChromium(env?): Promise<{ executablePath: string; source: 'env'|'chrome'|'edge'|'chromium' } | null>` — checks `HTMLPPT_CHROMIUM`, then platform default Chrome/Edge/Chromium locations and `playwright` browser caches; returns null when none.
- `renderPdf({ html, width, height, outPath }): Promise<void>` — sandboxed browser context (`javaScriptEnabled: true`, no network beyond the deck), `page.setContent(html)`, wait for fonts/images (`document.fonts.ready` + `networkidle` best effort), emulate print media, PDF at `width × height` CSS px, print backgrounds, no margins.
- `renderPngs({ html, width, height, outDir, basename }): Promise<string[]>` — one screenshot per `[data-slide-id]` at 2× scale; hide others; restore; deterministic names.
- Errors: `RendererUnavailableError` with install instructions; `RenderError` with the failing slide.
- Tests: with a real installed Chromium in CI/local, render a 2-slide deck → PDF exists, 2 pages, page size matches; PNGs count 2, dimensions 2× canvas; a missing browser executable returns `RendererUnavailableError` (test via `HTMLPPT_CHROMIUM=/nonexistent` and no fallback detection override; no mocks of Chromium itself).
- If no Chromium is available on the machine, the test must still assert the actionable error path and mark the rendering case as environment-unavailable explicitly (documented, not skipped silently; use a conditional inside one test that asserts the error message when unavailable).

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
