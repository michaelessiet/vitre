# Scripts

- `vp run dev` or `vp run dev:vitre` — Starts the native Vitre development app.
- `vp run dev:server` — Starts the backend in watch mode.
- `vp run dev:marketing` — Starts the marketing site.
- `vp run start` — Runs the built backend.
- `vp run build` — Builds workspace packages and applications.
- `vp run build:marketing` — Builds the marketing site.
- `vp run typecheck` — Runs TypeScript checks across the workspace.
- `vp run test` — Runs workspace tests.
- `node apps/server/scripts/t3-sqlite-state.ts <query|exec> --base-dir <path> ...` — Inspects or seeds an isolated T3 SQLite database; writes create a private backup first.

`dev:server` stores data under `~/.t3` (or `T3CODE_HOME`) and `dev:vitre` under `~/.vitre` (or `VITRE_HOME`). In a linked git worktree both default to the worktree's gitignored `.t3`, so feature work never shares a database with the main checkout. Pass `--home-dir <path>` to either to choose a directory explicitly.
