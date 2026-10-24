# Agent guide — htmlppt

Working rules for AI agents and humans collaborating on this repository.
`CONTRIBUTING.md` covers environment and commands; this file covers process.

## Repository location

`node_modules` links workspace packages through Windows junctions that store absolute paths, so moving or renaming the repository root silently breaks every workspace import while `git` and `npm` commands still look healthy. After a move, recreate each junction in the root `node_modules` and in every `.worktrees/*/node_modules`, and repair the linked worktrees' `.git` files, before trusting a red build.

## Workflow gates

Three separate approvals are required before code changes land:

1. **Spec** — `docs/superpowers/specs/<date>-<topic>-design.md`. An approved spec is not an approved plan.
2. **Plan** — `docs/superpowers/plans/<date>-<topic>.md`, one file per phase, written before any implementation.
3. **Execute** — explicit user go-ahead for the approved plan.

Every phase is gated by: RED test first, full `npm run verify` on the final HEAD, then a green hosted CI matrix, before the next phase starts. Local green is not a release claim.

## Git

- Never commit or push directly on `main`. Use a feature branch and open a pull request.
- The user performs merges. A push is authorized per round only; a prior approval does not carry over.
- Open the pull request, then watch the hosted CI matrix on its newest run; propose a merge only when every job is green. A red matrix is not merged.
- npm publish, GitHub releases, tags, and any other shipping action remain unauthorized until explicitly granted.

## Verification

- `npm run verify` — lint, dependency boundaries, typecheck, unit, integration, feature matrix, Playwright, package smoke.
- `npm run verify:fast` — inner-loop subset; never use it as the phase gate.
- Run build and verify sequentially; they contend for the same outputs.
- Report only verification that actually ran, with the command and the commit under test.
- Hosted CI on the newest run of the pushed SHA is authoritative; a push cancels older runs. Classify a red run as environment/flake/test-race/regression before touching product code.

## Tests

- Never skip, delete, or loosen a case to reach green. Fix the product or use the platform-accurate expectation.
- A shared payload change updates every consumer's exact assertion in the same commit, including the feature matrix and package smoke.
- Cross-file/async editor behaviour needs real E2E: autosave, revision conflicts, live-sync events, and reload recovery all have coverage that must stay green.
- Theme contrast is measured on real painted elements, with background alpha composited bottom-up. Probing CSS variables alone gives false passes.

## Platform and contract notes

- Windows CI temp paths arrive as 8.3 short names. Session-registry keys keep the caller's spelling; deck identity is compared via realpath (parent realpath plus basename when the deck file is missing).
- The host is one deck per process; `POST /api/open` rebinds it and moves the CLI registry entry. Validate before mutating.
- The per-process token is a capability secret. Browser traffic uses the HttpOnly `SameSite=Strict` cookie; CLI, MCP, and tests keep bearer auth. Do not remove the token boundary to shorten a URL.
- Presenter query params (`presenter`, `session`) must survive document redirects.
- Presenter strings cross the popup boundary as `data-ppt-strings` JSON because `PRESENTER_CLIENT.toString()` loses closures.
- Theming applies to editor chrome only. Play mode, presenter, runtime controls, and authored slide content keep their own styling.
- UI copy lives in the typed locale catalog (`en`, `zh-Hant`, `zh-Hans`); CLI and MCP stay English.

## Reporting

- Reply in Traditional Chinese with English technical terms; keep files, comments, and docs in English.
- State each phase as implemented, pending CI, designed-only, or not started.
- Surface conflicts with an approved spec before acting on a request; do not silently deviate.
