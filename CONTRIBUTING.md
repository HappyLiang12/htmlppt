# Contributing to htmlppt

Thanks for helping improve htmlppt. The project is a TypeScript monorepo that
turns a single HTML file into a presentable deck, a visual editing session, and
clean exports. Changes should preserve that one-file contract.

By participating, you agree to keep reports and test fixtures free of secrets
and to follow the private process in [SECURITY.md](SECURITY.md) for
vulnerabilities.

## Prerequisites

- **Node.js 20 or newer** (the workspace engines field enforces this).
- **Git** with worktree support.
- **Google Chrome, Microsoft Edge, or Chromium** for PDF/PNG export. Set
  `HTMLPPT_CHROMIUM` to an executable path if auto-discovery fails.
- **Playwright Chromium** for E2E tests:

  ```bash
  npx playwright install chromium
  ```

## Install

```bash
npm ci
```

Use `npm ci` for a reproducible install from `package-lock.json`. Installing a
new dependency is a design decision: explain why it is needed and keep it out of
packages that must stay pure.

## Work in a worktree

Feature work happens on a branch in a separate worktree so the main checkout
stays usable:

```bash
git worktree add ../htmlppt-<topic> -b <type>/<topic>
cd ../htmlppt-<topic>
npm ci
```

Replace `<topic>` with a short name and `<type>` with a Conventional Commit type
such as `feat`, `fix`, `test`, or `docs`. Do not switch or rewrite another
contributor's branch.

## Development loop

1. Write or update a failing test first (see TDD below).
2. Implement the smallest change that makes it pass.
3. Run the focused package tests while iterating.
4. Build and exercise the real CLI/editor path:

   ```bash
   npm run build
   npx htmlppt new deck.html --slides 2
   npx htmlppt validate deck.html
   npx htmlppt open deck.html --no-browser
   ```

   Open the printed `HTMLPPT_URL`, make a change, and confirm it is saved. Stop
   the host with `npx htmlppt stop deck.html`.
5. Run `npm run verify:fast` before committing. Run `npm run verify` before a
   local merge or pull request when E2E and packaging are relevant.

For editor-only UI work, `npm run dev -w @htmlppt/editor` serves the Vite shell.
It has no deck host behind it, so use the built CLI and `htmlppt open` for any
flow that needs loading, saving, live sync, or export.

## Test-driven development

Strict TDD is expected:

1. **RED** - add the test and run it. Confirm it fails for the intended reason,
   not because of a typo or missing fixture.
2. **GREEN** - implement the minimum needed to pass.
3. **Refactor** - clean up with the test still green.

Rules:

- Bug fixes start with a reproduction test.
- No retries and no mocking the host or filesystem in integration tests.
  POSIX-only permission and symlink checks skip on Windows; CI gates Ubuntu
  and Windows.
- Do not edit golden files, snapshots, or visual baselines just to force a green
  suite. Explain and review any legitimate baseline change.
- Tag feature coverage with `@feature:<id>` and register the id in
  [`docs/features.json`](docs/features.json). Add it as `planned`, confirm the
  failing test, then flip it to `active`.

## Test layers

| Layer | Command | Covers |
| --- | --- | --- |
| Unit | `npm run test:unit` | Core contract, mutations, charts, tables, editor state, geometry, history, shortcuts, live-sync decisions. Editor tests use jsdom. |
| Integration | `npm run test:integration` | Builds first, then exercises the renderer with real Chromium, the host over HTTP, MCP over stdio, and the CLI as a real process against real files. |
| E2E | `npm run test:e2e` | Builds first, then drives the editor and exported decks in Playwright Chromium. |
| Package | `npm run test:package` | Builds, packs the `htmlppt` tarball, installs it in a temp project, and checks the installed bins, editor assets, skill, docs, host auth, `new`/`validate`/`open`/`stop`, and the MCP handshake. |
| Matrix | `npm run test:matrix` | Ensures feature ids in `docs/features.json` have tagged test coverage. |

The aggregate gates are `npm run verify:fast` (lint, dependency boundaries,
types, unit, integration, matrix) and `npm run verify` (everything, including
E2E and package smoke). Read [docs/testing.md](docs/testing.md) for the test
strategy.

## Code style

- TypeScript with `strict` enabled; keep the existing ESM/Node 20 targets.
- Run `npm run lint`, `npm run lint:deps`, and `npm run typecheck` before
  committing.
- Respect package boundaries: core stays browser-independent and must not import
  host/editor/CLI/MCP code; runtime stays dependency-free; the editor must not
  import the Node file adapter; the host must not import the editor.
- Prefer small pure functions for geometry, state transitions, and parsing.
  Keep process, filesystem, and HTTP code at package edges.
- Comments are minimal and in English. Explain **why** a non-obvious constraint
  exists, not what the next line does.
- Match the surrounding style. Editor-facing strings are currently Traditional
  Chinese; public documentation and code comments are English.
- Never log session tokens, bearer URLs, or deck contents that may be private.
- Keep generated output (`dist/`, tarballs, test artifacts) out of commits.

## Commit conventions

Use Conventional Commits:

```
<type>(<scope>): <imperative summary>

<why the change is needed, if not obvious>

Tests: <commands run>
```

Common types: `feat`, `fix`, `test`, `docs`, `refactor`, `perf`, `build`, `ci`,
`chore`. Common scopes: `core`, `editor`, `host`, `mcp`, `cli`, `renderer`,
`runtime`, `package`, `docs`. Keep one logical change per commit and include
its tests and documentation.

Examples:

```
fix(editor): keep selection when a slide is reordered
feat(renderer): add PNG export at 2x scale
docs: document MCP host-attached mode
```

Do not commit tokens, `.env` files, session registry files, or unrelated local
changes. Do not rewrite shared history.

## Local merge workflow

Maintainers merge locally rather than depending on a hosted service:

```bash
# From the branch worktree, after the final commit:
npm run verify

# From the main checkout:
git switch main
git pull --ff-only            # only if this checkout tracks a remote
git merge --no-ff <type>/<topic>
npm run verify
git worktree remove ../htmlppt-<topic>
git branch -d <type>/<topic>
```

Resolve conflicts on the feature branch, not by discarding either side. If the
merge changes public commands, MCP tools, or contract behavior, update
[README.md](README.md), [docs/contract.md](docs/contract.md),
[docs/mcp.md](docs/mcp.md), [docs/architecture.md](docs/architecture.md), and
the agent skill in the same change.
Contributors without merge rights should push their branch and open a pull
request instead of merging locally.

## Documentation changes

- User-facing behavior belongs in `README.md`, `docs/contract.md`,
  `docs/mcp.md`, or `docs/architecture.md`.
- `docs/superpowers/` contains internal design and planning notes. It is not
  user documentation and should not be linked from release docs.
- Agent-facing instructions live in `skills/htmlppt/SKILL.md`; keep them short
  and consistent with the actual CLI and MCP surface. Contract and tool
  reference files under `skills/htmlppt/references/` mirror code behavior and
  should be changed only when that behavior changes.
- Every command in the docs must exist in `package.json` or the CLI. Check
  relative links before committing.
