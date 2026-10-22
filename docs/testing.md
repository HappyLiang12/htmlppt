# Testing

This project follows strict TDD: write a failing test, confirm it fails for the right reason, then implement minimal code.

## Setup

After `npm ci`, install the Playwright Chromium browser once for local E2E runs:

```bash
npx playwright install chromium
```

## Commands

- `npm run test:unit` — core unit tests
- `npm run test:integration` — host, MCP, CLI, filesystem, HTTP
- `npm run test:e2e` — builds the workspace first, then runs Playwright Chromium
- `npm run test:package` — builds, packs the `htmlppt` tarball, installs it in a temp project, and smokes the installed bins
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
