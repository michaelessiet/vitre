# Workspace layout

- `/crates/vitre-app`: Native Vitre desktop application.
- `/apps/server`: Backend WebSocket and HTTP server. Wraps Codex app-server and manages provider sessions.
- `/apps/vitre`: Native application development and build helpers.
- `/apps/marketing`: Vitre marketing site.
- `/packages/contracts`: Shared effect/Schema schemas and TypeScript contracts for provider events, WebSocket protocol, and model/session types.
- `/packages/shared`: Shared runtime utilities with explicit subpath exports.
- `/packages/client-runtime`: Client runtime utilities used by the relay and native integration.
