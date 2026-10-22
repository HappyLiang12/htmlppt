# Test Framework Design

Date: 2026-10-21
Companion to: `2026-10-21-html-ppt-editor-design.md`
Status: approved for planning

## 1. Goals

1. Every feature is proven by executable tests before it is considered done.
2. Round-trip fidelity is guarded: HTML in → visual edit → HTML out must not drift.
3. Agent-facing contracts (MCP tools, CLI JSON, deck format, skill examples) are versioned and regression-tested.
4. Live host behavior (revisions, SSE, external edits, conflicts) is tested with real processes, not mocks.
5. The suite stays deterministic and fast enough for per-PR feedback.
6. Adding a feature has a mechanical checklist that prevents untested behavior from landing.

Non-goals:

- 100% coverage.
- Mock-heavy tests that assert implementation details.
- Replacing manual design review of visuals.

## 2. Test layers

| Layer | Tooling | Scope | Runtime target |
|---|---|---|---|
| Static | ESLint, `tsc --noEmit`, dependency-cruiser | Types, lint, module boundaries, cycles | seconds |
| Unit | Vitest (Node and jsdom), bundled with v8 coverage | Core logic, DOM mutations, geometry, validation, reducers | < 30 s |
| Contract / golden | Vitest + fixtures + golden files | Parse → validate → normalize → serialize invariants; idempotence | < 15 s |
| Host integration | Vitest + real HTTP/SSE + temp dirs + real fs | API, revisions, conflicts, watcher, session registry, export errors | < 60 s |
| MCP integration | Vitest + official MCP SDK stdio client | Tool schemas, tool behavior, resources, direct/host modes, stdout purity | < 90 s |
| CLI integration | Vitest + execa against the built bin | Commands, exit codes, JSON output, cross-platform paths | < 60 s |
| E2E | Playwright, Chromium full; Firefox/WebKit smoke | Real iframes, pointer interactions, contenteditable, tables, charts, presenter, live sync | < 10 min |
| Runtime / export | Playwright + pdfjs-dist + image-size | Exported deck navigation, notes, presenter, PDF/PNG correctness | < 3 min |
| Visual round-trip | Playwright + pixelmatch + pngjs | Original vs unedited export; edited canvas vs exported slide | < 3 min |
| Security | Vitest + Playwright | Token, origin, traversal, iframe script isolation, no stdout leaks | < 30 s |
| Accessibility | @axe-core/playwright | Editor shell, inspector, dialogs, keyboard-only path | < 2 min |
| Packaging | `npm pack` + tarball install + smoke | Bins, bundled assets, skill files, MCP handshake | < 2 min |
| Performance | Nightly Playwright + Node benchmarks | 100-slide import/open/serialize budgets | nightly |

## 3. Repository layout

```
packages/
  core/src/**/*.test.ts
  host/src/**/*.test.ts
  editor/src/**/*.test.tsx
  cli/test/*.test.ts
  mcp/test/*.test.ts
test-utils/
  fixtures/            # internal decks
  fonts/               # local fonts used by visual fixtures
  images/              # local images
  builders/            # deck builders, temp dirs, id/clock injection
  adapters/            # linkedom and jsdom adapters for parity tests
  playwright/
    fixtures.ts        # host, editor page, temp deck per test/worker
    helpers.ts         # select, drag, resize, screenshot, export
e2e/
  specs/               # feature acceptance tests
  runtime/             # exported deck / runtime tests
  visual/              # round-trip and UI visual tests
docs/
  testing.md           # contributor guide for adding tests
  features.json        # feature id manifest
scripts/
  check-feature-coverage.mjs
.github/workflows/
  ci.yml
  nightly.yml
  release.yml
```

Vitest uses a workspace with one project per package. The editor project runs in jsdom; core runs its DOM-dependent suites against both linkedom (production Node adapter) and jsdom (browser-like adapter) through `describe.each`.

## 4. Determinism rules

These are mandatory for every test:

- **Ids:** core accepts an injectable `IdGenerator`. Tests use a seeded incrementing generator. Production uses nanoid.
- **Time:** autosave, history coalescing, SSE heartbeats, and timers accept a `Clock` abstraction. Unit/integration tests use fake time; E2E uses `page.clock` where timing is asserted.
- **Files:** every test gets a fresh temp directory; no shared deck files. Hosts use port 0. Cleanup in fixtures.
- **Network:** E2E blocks all non-localhost requests via `page.route`. Fixtures reference only local fonts/images. A fixture with external assets exists but is never used for visual comparisons.
- **Animations:** screenshot helpers inject `*, *::before, *::after { animation: none !important; transition: none !important; caret-color: transparent !important; }` and wait for `document.fonts.ready`. Animation tests opt out deliberately.
- **Viewport:** fixed 1600 × 900 slide, 1440 × 900 editor viewport, deviceScaleFactor 1 for UI snapshots, 2 for round-trip captures.
- **Time zone/locale:** UTC and `en-US` in CI.
- **No retries:** Playwright `retries: 0` in CI. Flakes are fixed, not hidden.

## 5. Contract and golden tests

Fixtures:

- `basic`: contract deck, 2 slides (matches the M0 fixture).
- `rich`: text, image, shape, group, table, chart, notes, transition, runtime.
- `messy`: sections without ids, mixed canvas sizes, inline styles, relative assets, scripts.
- `animated`: CSS animations and transitions.
- `external`: CDN fonts/images and a custom navigation script.
- `malicious`: inline scripts and event handlers used only for isolation tests.
- `large`: generated 100-slide deck for performance.

For each fixture, tests assert:

- Slide detection result and canvas inference.
- Validation JSON matches the golden file (errors/warnings with slide ids).
- Normalization assigns ids deterministically and is idempotent.
- Serialize → re-parse preserves head nodes, scripts, styles, notes, chart data, and object count.
- Exported HTML contains no editor artifacts.
- Runtime presence is preserved and not injected twice.
- Outline JSON matches the golden file.

Golden files live beside fixtures (`*.expected.json`, `*.expected.html`). Whole-file HTML snapshots are allowed only for normalized outputs and must be reviewed when changed. Semantic assertions are preferred over snapshots for logic.

## 6. Host integration tests

Real processes and real filesystem:

- Start the host on an ephemeral port with a temp deck.
- `GET /api/deck` returns HTML, revision, path.
- `PUT /api/deck` writes atomically; the file content matches; revision changes.
- Stale `baseRevision` → 409 with a structured conflict payload.
- External file write → watcher → SSE `external` event with a new revision.
- Self-write does not emit a duplicate external event.
- Token missing/wrong → 401; foreign Origin → 403; traversal attempts → 400/404.
- Session registry created on `open`, removed on graceful stop, cleaned when stale.
- `stop` terminates the process and removes the registry entry.
- Export without Chromium returns an actionable 501; export with Chromium is covered in runtime tests.
- SSE reconnection with `Last-Event-ID` replays the latest revision.

## 7. MCP integration tests

Spawn the built MCP server with the official SDK stdio client.

- `tools/list` matches a reviewed snapshot. Breaking changes require an intentional snapshot update and a package version bump.
- Every write tool has happy-path and validation-error tests.
- Direct mode: no host → writes the file, creates a `.tmp` and renames atomically, detects concurrent modification.
- Host-attached mode: open a host, call tools, assert the host revision and SSE event; assert the editor would receive it.
- Target resolution: element id, unique selector, path; ambiguous/missing targets produce actionable errors.
- Resources: contract, example, authoring guide are readable and valid.
- Stdout purity: the process emits only JSON-RPC on stdout; logs go to stderr.
- Skill examples: every HTML block in the skill's reference files validates; the skill lists only tools that exist.
- Conflict: a stale `baseRevision` returns a conflict error, not a silent overwrite.

## 8. CLI integration tests

Build once, spawn the binary with execa in a temp cwd.

- `--help`, `--version` exit 0.
- `new` creates a valid deck with runtime; `validate` exits 0.
- `validate --json` emits parseable JSON and a non-zero exit on errors.
- `outline --json` shape matches the core outline.
- `open --no-browser` starts a host, prints a tokenized URL; `stop` cleans up.
- `export --format html` works without a host.
- `export --format pdf|png` succeeds in CI with Chromium and fails with guidance when no browser is found.
- Invalid paths, missing files, and malformed decks produce clear messages and non-zero exits.
- Windows path handling and CRLF output are covered on the Windows CI job.

## 9. E2E feature acceptance tests

Playwright, Chromium, real host, real iframes. Each spec is tagged with one or more feature ids.

```
e2e/specs/
  skeleton.spec.ts
  slides.spec.ts
  sorter.spec.ts
  objects-transform.spec.ts
  objects-multi.spec.ts
  groups-zorder-lock.spec.ts
  text-edit.spec.ts
  text-format.spec.ts
  lists-links.spec.ts
  shapes.spec.ts
  images.spec.ts
  tables.spec.ts
  charts.spec.ts
  notes-transitions.spec.ts
  play.spec.ts
  presenter.spec.ts
  persistence.spec.ts
  live-sync.spec.ts
  export.spec.ts
  undo-redo.spec.ts
  keyboard.spec.ts
  a11y.spec.ts
  standalone.spec.ts
```

Helpers in `test-utils/playwright/helpers.ts`:

- `openDeck(fixture)` → host + editor page.
- `frame()` → slide iframe frame locator.
- `object(id)` → deck element locator inside the frame.
- `select(id)`, `dragBy`, `resizeBy`, `rotateBy`.
- `readInlineStyle(id, prop)`.
- `editText(id, text)`.
- `exportHtml()` → absolute path + content.
- `hideChrome()` and `screenshotSlide(index)` for visuals.

Assertions target user-visible behavior and persisted HTML, not store internals. Every feature bullet in the product spec maps to at least one test; the feature coverage script enforces it.

## 10. Visual round-trip methodology

Round-trip tests compare within one browser/OS, so cross-platform font rendering does not affect them.

1. Open the fixture in the editor at 100% zoom; screenshot each slide at deviceScaleFactor 2, animations disabled, fonts ready.
2. Export HTML without edits.
3. Serve the export through a static test server; navigate the runtime to each slide; screenshot the same slide region at the same size.
4. Pixel-compare with pixelmatch (`threshold: 0.1`); assert differing pixels ≤ 0.1% of total and write a diff image to `test-results/visual/`.
5. For edited round-trips: perform scripted edits, screenshot the editor, export, render, compare; also re-import the export and assert outline/geometry invariants.

UI visual snapshots (editor chrome) are a small curated set (empty state, normal view, inspector with text, sorter, chart dialog). Baselines are generated on Linux only; `toHaveScreenshot` masks dynamic paths and status text. Updating baselines is an explicit reviewed command (`npm run test:update`), never automatic in CI.

## 11. Runtime and export tests

- Open the exported HTML in Playwright; assert navigation, hash routing, transitions, notes hidden, presenter view popup, and timer behavior.
- Print emulation: each slide is one page.
- PDF: page count equals slides; page size in points matches canvas size; extracted text contains slide titles.
- PNG: one file per slide; dimensions equal canvas × 2.
- HTML export: no `contenteditable`, no editor-injected styles or overlays, generator comment present, slide/object ids and notes preserved.
- Re-import exported HTML through core/MCP and compare outline.

## 12. Security and accessibility tests

Security:

- Host auth/origin/path tests (section 6).
- A deck with `<script>` and `onerror` handlers must not execute inside the editor iframe; assert sentinel globals remain unset.
- MCP stdout purity and token redaction in logs/errors.
- Editor `open` actions reject `javascript:` URLs; links allow only http/https/mailto/#.

Accessibility:

- axe checks on the main editor, inspector, sorter, chart dialog, and export dialog; fail on serious/critical violations.
- Keyboard-only path: open deck, select object, move with arrows, edit text, undo, open Play, Escape.
- Focus is visible and returns from the iframe after Escape.

## 13. Packaging and CI

Commands:

```
npm run verify          # static + unit + integration + build + e2e + package smoke
npm run verify:fast     # static + unit + integration
npm run test:unit
npm run test:e2e
npm run test:e2e:ui
npm run test:update     # visual baselines, reviewed
npm run test:matrix     # feature coverage check
npm run test:perf       # nightly
```

CI jobs:

- `static`: lint, typecheck, dependency boundaries.
- `unit`: Vitest workspace with coverage thresholds (Linux; Node 20 and 22).
- `integration`: host, MCP, CLI.
- `e2e`: build, Playwright Chromium, upload traces/screenshots/diffs/JUnit.
- `e2e-windows`: unit + integration + E2E smoke on Windows (file watching, paths).
- `cross-browser`: Firefox/WebKit smoke subset (open, edit text, save/export HTML).
- `package`: `npm pack`, install tarball in a temp project, smoke CLI/MCP/editor assets/skill files.
- `feature-matrix`: compare `docs/features.json` with test tags.
- Nightly: performance suite and 3× repeat of E2E to detect flakes; results reported but not PR-blocking.

Required for merge: all jobs except nightly. Playwright retries are 0; artifacts are uploaded on failure.

Coverage thresholds:

| Package | Lines | Branches |
|---|---|---|
| core | 90% | 85% |
| host | 80% | 75% |
| mcp | 75% | 70% |
| cli | 75% | 70% |
| editor | 60% | 55% |

Coverage is a floor, not a target. The feature matrix and acceptance tests are the primary quality signal.

## 14. Feature traceability

`docs/features.json` tracks every product feature. `status` is `planned` until the feature has a tagged test, then `active`. CI enforces tagged tests only for active features, so the manifest can list the full roadmap without turning CI red before a feature is implemented.

```json
{
  "features": [
    { "id": "skeleton", "spec": "16", "status": "active", "tests": ["@feature:skeleton"] },
    { "id": "objects-transform", "spec": "4.Objects", "status": "planned", "tests": ["@feature:objects-transform"] },
    { "id": "rich-text", "spec": "4.Text", "status": "planned", "tests": ["@feature:rich-text"] },
    { "id": "tables", "spec": "4.Tables", "status": "planned", "tests": ["@feature:tables"] }
  ]
}
```

Playwright tests carry tags:

```ts
test('moves an object by dragging', { tag: '@feature:objects-transform' }, async ({ editor }) => {
  // ...
});
```

`npm run test:matrix`:

1. Collects `@feature:<id>` tags from E2E test sources (and Playwright's list output when available).
2. Extracts tags.
3. Fails if an `active` feature in the manifest has no tagged test.
4. Fails if a tag references an unknown feature id.
5. Fails if a manifest entry points to a spec section that no longer exists (best-effort grep of the product spec).

When a feature's acceptance test is written (RED), the manifest entry flips to `active` in the same PR.

Every PR that adds or changes behavior must update the manifest and at least one test. The PR template includes this checklist.

## 15. TDD workflow

For each feature:

1. **RED:** write the acceptance test (E2E or integration) for the user-visible behavior and tag it. Run it; confirm it fails for the right reason. Add focused unit tests for core logic as interfaces emerge.
2. **GREEN:** implement the minimal production code to pass. No unrelated features.
3. **REFACTOR:** clean up, keep all suites green.
4. **RECORD:** update the feature manifest, docs, and skill if the agent-facing surface changed.
5. **VERIFY:** run `npm run verify` locally or rely on CI; attach evidence.

Bug fixes:

1. Write a failing regression test using the real code path.
2. Fix the root cause.
3. Confirm green; keep the test.

Rules:

- No production code without a failing test (configuration files excepted).
- No `skip` to make a suite green.
- No retries added to hide flakes.
- Never edit golden files, visual baselines, or expected outputs to make a failing test pass without reviewing and justifying the diff.
- No assertions on mock calls when real behavior can be asserted.
- Tests that need a browser belong in E2E, not mocked in jsdom.

## 16. Harness-first milestone (M0)

M0 builds the test framework and proves it with a walking skeleton before feature work.

M0 deliverables:

1. Monorepo scaffold: workspaces, TypeScript strict, ESLint, dependency-cruiser, Vitest workspace, Playwright config.
2. `test-utils` package: fixtures, temp-dir builders, and Playwright CLI-host/static-server helpers. Id/clock injection is introduced with the first production code that needs it (normalization in M1, autosave in M3).
3. CI workflows and PR template; feature manifest and coverage script.
4. Walking-skeleton acceptance test, written first and watched to fail:
   - `htmlppt new demo.html` in a temp dir.
   - `htmlppt validate demo.html` passes.
   - Host starts; editor loads; the title text is visible inside the slide iframe.
   - Change the title via the text editor; save; the file on disk contains the new title.
   - `htmlppt export demo.html --format html` writes an export with no editor artifacts.
5. Thinnest vertical slice of production code to make the skeleton green: core parse/detect/validate/serialize, a minimal host with deck GET/PUT, a minimal editor that renders one slide and edits text, and the CLI `new`/`validate`/`open`/`export html`.
6. One contract fixture used by integration and E2E tests; the full golden-file suite (normalization, outline, validation) lands in M1.
7. Docs: `docs/testing.md` (how to add tests), feature manifest, commands.

Exit criteria for M0: `npm run verify` is green, includes the skeleton E2E, and the CI pipeline runs it. Only then does feature TDD begin.

## 17. Risks and mitigations

| Risk | Mitigation |
|---|---|
| E2E flakiness with iframes/contenteditable | Deterministic fixtures, no retries, trace artifacts, focused helpers, stable test ids |
| Visual tests sensitive to fonts/OS | Local fonts, same-run comparisons, Linux-only UI baselines |
| Two DOM implementations diverge (linkedom vs browser) | Core DOM parity suite; E2E covers real browser behavior |
| Browser dependency for PDF/PNG | Chromium installed in CI; production uses system Chrome/Edge with actionable errors |
| Feature matrix rot | CI script; PR checklist |
| Suite too slow | Layer separation, parallel packages, working `verify:fast`, nightly performance |
| TDD bypass under time pressure | PR template and review checklist; no production code without a regression test |
| Host/file-watch races | Hash-based revisions, debounced watcher, real-filesystem integration tests |
