import { describe, expect } from "vite-plus/test";
import { it } from "@effect/vitest";
import * as PgClient from "@effect/sql-pg/PgClient";
import { listSqlFiles } from "alchemy/Sql/SqlFile";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import { configureRuntimeRole, migrateDatabase } from "./database.ts";

// Opt-in, disposable PostgreSQL ONLY. These tests create and drop public tables.
const testUrl = process.env.VITRE_TEST_DATABASE_URL;
describe.skipIf(!testUrl)("PostgreSQL database deployment", () => {
  it.effect(
    "serializes repeated migrations, grants DML only, and rolls back failed migrations",
    () =>
      Effect.gen(function* () {
        const sql = yield* PgClient.PgClient;
        const files = yield* listSqlFiles("./migrations/postgres");
        yield* Effect.all([migrateDatabase(files), migrateDatabase(files)], { concurrency: 2 });
        const journal = yield* sql<{
          count: number;
        }>`SELECT count(*)::int AS count FROM relay_migrations`;
        expect(journal[0]!.count).toBe(files.length);
        const origin = {
          database: "postgres",
          password: Redacted.make("runtime-'quoted\\password"),
        };
        yield* configureRuntimeRole(origin);
        yield* configureRuntimeRole(origin);
        const privileges = yield* sql<{
          read: boolean;
          write: boolean;
          ddl: boolean;
          journal: boolean;
        }>`SELECT
        has_table_privilege('vitre_relay', 'relay_cloud_accounts', 'SELECT') AS read,
        has_table_privilege('vitre_relay', 'relay_cloud_accounts', 'UPDATE') AS write,
        has_schema_privilege('vitre_relay', 'public', 'CREATE') AS ddl,
        has_table_privilege('vitre_relay', 'relay_migrations', 'INSERT') AS journal`;
        expect(privileges[0]).toEqual({ read: true, write: true, ddl: false, journal: false });
        const failed = yield* migrateDatabase([
          {
            id: "bad.sql",
            hash: "bad",
            sql: "CREATE TABLE relay_should_rollback(id int); --> statement-breakpoint INVALID SQL",
          },
        ]).pipe(Effect.result);
        expect(failed._tag).toBe("Failure");
        const rollback = yield* sql<{
          table: string | null;
          count: number;
        }>`SELECT to_regclass('relay_should_rollback')::text AS table,
        (SELECT count(*)::int FROM relay_migrations WHERE name = 'bad.sql') AS count`;
        expect(rollback[0]).toEqual({ table: null, count: 0 });
        yield* sql`ALTER ROLE vitre_relay CREATEDB`;
        const unsafe = yield* configureRuntimeRole(origin).pipe(Effect.result);
        expect(unsafe._tag).toBe("Failure");
        yield* sql`ALTER ROLE vitre_relay NOCREATEDB`;
      }).pipe(
        Effect.provide([
          PgClient.layer({ url: Redacted.make(testUrl!), maxConnections: 3 }),
          NodeServices.layer,
        ]),
      ),
  );
});
