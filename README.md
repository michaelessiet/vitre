# [Vitre](https://github.com/michaelessiet/vitre)

Vitre is an open source, native macOS workspace for coding with agents. It brings conversations, files, diffs, a terminal, and a browser preview into one focused window. The desktop client is built with Rust and GPUI and uses a bundled Node sidecar for provider sessions.

Vitre is under active development. A local Apple Silicon build is available to contributors, but there is no signed public release or update feed yet.

## Run locally

You need macOS, a Rust toolchain, Node.js 24, and [Vite+](https://viteplus.dev/guide/) (`vp`). Install dependencies, then start the native app:

```bash
vp install
vp run dev:vitre
```

The development runner builds the sidecar when needed. Use `vp run dev:vitre --rebuild` after changing server code. Configure and authenticate a supported coding agent before starting a conversation.

## Project layout

- `crates/vitre-app` — native desktop interface.
- `crates/vitre-state`, `crates/vitre-client`, and `crates/vitre-rpc` — state and protocol layers.
- `apps/server` — bundled provider and workspace sidecar.
- `apps/marketing` — website and landing page.

See [Vitre handover](./docs/vitre-handover.md) for the current implementation status and open work.

## License

Vitre is MIT licensed. See [LICENSE](./LICENSE).
