import type { OrchestrationCommand, ThreadExecutionState } from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import * as Option from "effect/Option";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { OrchestrationCommandInvariantError } from "../orchestration/Errors.ts";

const encodePaths = Schema.encodeSync(Schema.fromJsonString(Schema.Array(Schema.String)));
const decodeJson = Schema.decodeUnknownSync(Schema.UnknownFromJsonString);

export const initialExecution: ThreadExecutionState = {
  generation: 0,
  operationId: "initial",
  status: "active",
};

export function validExecutionTransition(
  current: ThreadExecutionState,
  expectedGeneration: number,
  next: ThreadExecutionState,
): boolean {
  if (current.generation !== expectedGeneration) return false;
  if (next.status === "frozen")
    return (
      next.generation === current.generation &&
      (current.status !== "frozen" || next.operationId === current.operationId)
    );
  if (current.status !== "frozen" || next.operationId !== current.operationId) return false;
  return next.status === "released"
    ? next.generation === current.generation + 1
    : next.generation === current.generation || next.generation === current.generation + 1;
}

export const readExecutionOwnership = Effect.fn("cloud.read_execution")(function* (
  threadId: string,
) {
  const sql = yield* SqlClient.SqlClient;
  const rows =
    yield* sql<ThreadExecutionState>`SELECT generation, operation_id AS "operationId", status
    FROM thread_execution_ownership WHERE thread_id = ${threadId}`;
  return rows[0] ?? initialExecution;
});

/** Called inside the engine's serialized command transaction, including its batch path. */
export const enforceExecutionOwnership = Effect.fn("cloud.enforce_execution")(function* (
  command: OrchestrationCommand,
) {
  const sql = yield* SqlClient.SqlClient;
  if (!("threadId" in command)) return;
  const current = yield* readExecutionOwnership(command.threadId);
  if (command.type === "thread.execution.set") {
    if (command.execution.status === "frozen") {
      const pending = yield* sql<{ pending: number }>`SELECT
        pending_approval_count + pending_user_input_count AS pending
        FROM projection_threads WHERE thread_id = ${command.threadId}`;
      if ((pending[0]?.pending ?? 0) > 0)
        return yield* new OrchestrationCommandInvariantError({
          commandType: command.type,
          detail: "Answer the pending request before moving.",
        });
    }
    if (!validExecutionTransition(current, command.expectedGeneration, command.execution))
      return yield* new OrchestrationCommandInvariantError({
        commandType: command.type,
        detail: "Conversation ownership changed; reload the pending switch.",
      });
    const next = command.execution;
    yield* sql`INSERT INTO thread_execution_ownership (thread_id, generation, operation_id, status)
      VALUES (${command.threadId}, ${next.generation}, ${next.operationId}, ${next.status})
      ON CONFLICT(thread_id) DO UPDATE SET generation = excluded.generation,
      operation_id = excluded.operation_id, status = excluded.status`;
    return;
  }
  if (command.type === "thread.execution.restore") {
    if (
      current.status !== "frozen" ||
      current.operationId !== command.operationId ||
      current.generation !== command.expectedGeneration
    )
      return yield* new OrchestrationCommandInvariantError({
        commandType: command.type,
        detail: "Destination ownership changed before restore.",
      });
    yield* sql`UPDATE thread_execution_ownership SET workspace_primary = ${command.worktreePath},
      workspace_additional_json = ${encodePaths(command.additionalRoots.flatMap((root) => (root.kind === "path" ? [root.path] : [])))}
      WHERE thread_id = ${command.threadId}`;
    return;
  }
  if (
    current.status !== "active" &&
    [
      "thread.turn.start",
      "thread.checkpoint.revert",
      "thread.meta.update",
      "thread.runtime-mode.set",
      "thread.interaction-mode.set",
      "thread.delete",
    ].includes(command.type)
  )
    return yield* new OrchestrationCommandInvariantError({
      commandType: command.type,
      detail:
        current.status === "frozen"
          ? "Conversation is moving; wait for the switch or cancel it."
          : "This environment no longer owns the conversation.",
    });
});

/** Returned workspaces contain mapped copies of inherited roots. Never grant a
 * provider access to the original project's live directories after a return. */
export const isolatedWorkspaceRoots = Effect.fn("cloud.isolated_workspace_roots")(function* (
  threadId: string,
  fallback: { readonly primary: string | undefined; readonly additional: readonly string[] },
) {
  const sql = yield* Effect.serviceOption(SqlClient.SqlClient);
  if (Option.isNone(sql)) return fallback;
  const rows = yield* sql.value<{ primary: string | null; additional: string | null }>`
    SELECT workspace_primary AS "primary", workspace_additional_json AS additional
    FROM thread_execution_ownership WHERE thread_id = ${threadId}`;
  const row = rows[0];
  if (!row?.primary || row.primary !== fallback.primary || !row.additional) return fallback;
  const additional: unknown = decodeJson(row.additional);
  return Array.isArray(additional) && additional.every((path) => typeof path === "string")
    ? { primary: row.primary, additional: additional as string[] }
    : fallback;
});
