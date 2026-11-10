# Runtime modes

Each conversation has a runtime mode, chosen from the composer toolbar. For Codex, the modes map to
these app-server settings (`apps/server/src/provider/Layers/CodexSessionRuntime.ts`):

| Mode                  | Approval policy | Sandbox              | Reviewer      |
| --------------------- | --------------- | -------------------- | ------------- |
| **Supervised**        | `untrusted`     | `read-only`          | you           |
| **Auto-accept edits** | `on-request`    | `workspace-write`    | you           |
| **Auto**              | `on-request`    | `workspace-write`    | `auto_review` |
| **Full access**       | `never`         | `danger-full-access` | you           |

**Full access** is the default. In the supervised modes, Vitre prompts in the conversation for
command and file approvals.
