/**
 * Conversations moved back from the former Vitre Cloud ran in mapped copies of
 * their workspaces, recorded in `thread_execution_ownership`. Keep honouring
 * those records so a provider never reopens the original live directories.
 */
import * as Schema from "effect/Schema";
import * as Option from "effect/Option";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

const decodeJson = Schema.decodeUnknownSync(Schema.UnknownFromJsonString);

/** Returned workspaces contain mapped copies of inherited roots. Never grant a
 * provider access to the original project's live directories after a return. */
export const isolatedWorkspaceRoots = Effect.fn("orchestration.isolated_workspace_roots")(
  function* (
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
  },
);
