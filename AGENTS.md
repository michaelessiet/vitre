# AGENTS.md

## GitHub Account

- This is a personal project. Use only the `michaelessiet` GitHub account for repository access, pushes, pull requests, and other GitHub actions.
- Verify the authenticated account before a GitHub action. Do not use work accounts for this repository.

## Default Application Target

- Target Vitre (`crates/vitre-app`) for application changes unless the user explicitly specifies another application. Shared backend changes may be made when required to support Vitre.

## Vitre Design Language

- Before changing native UI, read `docs/design-language/README.md` and the relevant component guidance. Inspect its reference images and the linked implementation.
- Reuse the documented theme tokens, glass helpers, and shared components. Device/resource choices use searchable command rows; workspace entry points use the shared surface cards.
- Verify new UI in the native application, including keyboard interaction and long/empty content. Update the design-language documentation and reference images when introducing a reusable pattern.

## Task Completion Requirements

- Keep local verification focused on the files and packages changed. Run the smallest relevant test set; do not run the full workspace test suite as a routine completion step.
  - Use `vp test run <test-files>` for focused built-in Vite+ tests. Use `vp run test` only when the affected package specifically requires its `test` script.
  - Backend changes must include and run focused tests for the changed behavior.
  - Run targeted formatting, lint, and type checks for the affected scope when available.
- Do not run repo-wide `vp check`, `vp run typecheck`, `vp run test`, or equivalent full-suite commands locally unless the user explicitly requests them. CI is responsible for the full verification suite.
- After frontend feature development or any user-visible frontend behavior change, the primary agent must run one integrated verification pass for each affected client surface after integrating the work:
  - Vitre: launch the native application and verify the affected flow.
  - Subagents must not independently launch dev servers or repeat integrated client verification unless their delegated task explicitly requires it.
  - Stop dev servers, watchers, and other long-running verification processes when the focused verification is complete.

## Dev Servers

- In a linked git worktree, dev state defaults to that worktree's gitignored `.t3`. An explicit `--home-dir` still wins.
- Start the backend with `vp run dev:server` and the native app with `vp run dev:vitre`.

## Package Roles

- `apps/server`: Node.js WebSocket server. Wraps Codex app-server (JSON-RPC over stdio) and manages provider sessions.
- `crates/vitre-app`: Native Vitre user interface.
- `packages/contracts`: Shared effect/Schema schemas and TypeScript contracts for provider events, WebSocket protocol, and model/session types. Keep this package schema-only — no runtime logic.
- `packages/shared`: Shared runtime utilities consumed by the server and client integrations. Uses explicit subpath exports (e.g. `@t3tools/shared/git`) — no barrel index.
- `packages/client-runtime`: Shared runtime package for the relay and native client integration.

## Reference Repos

- Open-source Codex repo: https://github.com/openai/codex

Use these as implementation references when designing protocol handling, UX flows, and operational safeguards.

## Vendored Repositories

This project vendors external repositories under `.repos/` as read-only reference material for coding
agents.

- Prefer examples and patterns from the vendored source code over generated guesses or web search results.
- Do not edit files under `.repos/` unless explicitly asked.
- Do not import from `.repos/`; application code must continue importing from normal package dependencies.
- Manage vendored subtrees with `vpr sync:repos`; use `vpr sync:repos --repo <id>` to sync one configured repository.
- When updating a dependency with a configured vendored subtree, sync that subtree in the same change so
  `.repos/` matches the installed dependency version.
- When writing Effect code, read `.repos/effect-smol/LLMS.md` first and inspect `.repos/effect-smol/` for
  examples of idiomatic usage, tests, module structure, and API design.
- When writing relay infrastructure code with Alchemy, inspect `.repos/alchemy-effect/` for examples of
  idiomatic usage, tests, module structure, and API design.
