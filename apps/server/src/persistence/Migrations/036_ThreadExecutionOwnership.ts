import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`CREATE TABLE IF NOT EXISTS thread_execution_ownership (
    thread_id TEXT PRIMARY KEY,
    generation INTEGER NOT NULL,
    operation_id TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('active', 'frozen', 'released')),
    workspace_primary TEXT,
    workspace_additional_json TEXT
  )`;
  yield* sql`CREATE TABLE IF NOT EXISTS cloud_handoff_journal (
    id TEXT PRIMARY KEY,
    conversation_id TEXT NOT NULL,
    input_json TEXT NOT NULL,
    journal_json TEXT NOT NULL,
    terminal INTEGER NOT NULL DEFAULT 0
  )`;
  yield* sql`CREATE UNIQUE INDEX IF NOT EXISTS cloud_handoff_pending
    ON cloud_handoff_journal(conversation_id) WHERE terminal = 0`;
});
