import * as PgClient from "@effect/sql-pg/PgClient";
import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { listSqlFiles, type SqlFile } from "alchemy/Sql/SqlFile";
import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import { databaseTunnelConfiguration, startDatabaseTunnel } from "./databaseTunnel.ts";
import {
  DatabaseSetupError,
  databaseConfiguration,
  databaseTlsConfiguration,
} from "../src/dbConfig.ts";

/** Journal format remains compatible with the previous deployment provider. */
export const migrateDatabase = (files: ReadonlyArray<SqlFile>) =>
  Effect.gen(function* () {
    const sql = yield* PgClient.PgClient;
    yield* sql.withTransaction(
      Effect.gen(function* () {
        yield* sql`SELECT pg_advisory_xact_lock(726548901)`;
        yield* sql`CREATE TABLE IF NOT EXISTS relay_migrations (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )`;
        const rows = yield* sql<{
          id: string;
          name: string;
        }>`SELECT id, name FROM relay_migrations`;
        const applied = new Set(rows.map((row) => row.name));
        let sequence = rows.reduce(
          (max, row) => Math.max(max, /^\d+$/.test(row.id) ? Number(row.id) : 0),
          0,
        );
        for (const file of files) {
          if (applied.has(file.id)) continue;
          for (const statement of file.sql.split("--> statement-breakpoint")) {
            if (statement.trim()) yield* sql.unsafe(statement);
          }
          yield* sql`INSERT INTO relay_migrations (id, name) VALUES (${String(++sequence).padStart(5, "0")}, ${file.id})`;
        }
      }),
    );
  });

export const configureRuntimeRole = (origin: {
  database: string;
  password: Redacted.Redacted<string>;
}) =>
  Effect.gen(function* () {
    const sql = yield* PgClient.PgClient;
    yield* sql.withTransaction(
      Effect.gen(function* () {
        yield* sql`SELECT pg_advisory_xact_lock(726548901)`;
        const roles = yield* sql<{ unsafe: boolean }>`SELECT
        (rolsuper OR rolcreatedb OR rolcreaterole OR rolreplication OR rolbypassrls OR
          EXISTS (SELECT 1 FROM pg_auth_members WHERE member = pg_roles.oid)) AS unsafe
        FROM pg_roles WHERE rolname = 'vitre_relay'`;
        if (roles.some((role) => role.unsafe))
          return yield* new DatabaseSetupError({
            message: "Existing vitre_relay role has elevated privileges",
          });
        if (!roles.length)
          yield* sql`CREATE ROLE vitre_relay LOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS`;
        // PostgreSQL formats the password as a literal; never interpolate a secret into SQL ourselves.
        const formatted = yield* sql<{
          statement: string;
        }>`SELECT format('ALTER ROLE vitre_relay LOGIN PASSWORD %L', ${Redacted.value(origin.password)}::text) AS statement`;
        yield* sql.unsafe(formatted[0]!.statement);
        // Apply limits on the origin role: transaction poolers may not forward
        // client startup options, and HTTP cancellation must not be the only guard.
        yield* sql`ALTER ROLE vitre_relay SET statement_timeout = '8s'`;
        yield* sql`ALTER ROLE vitre_relay SET lock_timeout = '2s'`;
        yield* sql`ALTER ROLE vitre_relay SET idle_in_transaction_session_timeout = '5s'`;
        yield* sql`GRANT CONNECT ON DATABASE ${sql(origin.database)} TO vitre_relay`;
        yield* sql`GRANT USAGE ON SCHEMA public TO vitre_relay`;
        const tables = yield* sql<{
          tablename: string;
        }>`SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND starts_with(tablename, 'relay_') AND tablename <> 'relay_migrations'`;
        for (const table of tables)
          yield* sql`GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.${sql(table.tablename)} TO vitre_relay`;
        yield* sql`REVOKE ALL ON TABLE relay_migrations FROM vitre_relay`;
      }),
    );
  }).pipe(Effect.withTracerEnabled(false));

const databaseOperation = (verifyOnly: boolean) =>
  Effect.gen(function* () {
    const admin = yield* Config.redacted("RELAY_DATABASE_ADMIN_URL");
    const runtime = yield* Config.redacted("RELAY_DATABASE_URL");
    const caCertificate = yield* Config.string("RELAY_DATABASE_CA_CERT").pipe(
      Config.withDefault(""),
    );
    const caCertificateId = yield* Config.string("RELAY_DATABASE_CA_CERTIFICATE_ID").pipe(
      Config.withDefault(""),
    );
    const { owner, origin } = yield* Effect.try({
      try: () => databaseConfiguration(admin, runtime),
      catch: () => new DatabaseSetupError({ message: "Invalid database configuration" }),
    });
    const tls = yield* Effect.try({
      try: () => databaseTlsConfiguration(caCertificate, caCertificateId),
      catch: () => new DatabaseSetupError({ message: "Invalid database TLS configuration" }),
    });
    const tunnelHost = yield* Config.string("RELAY_DATABASE_TUNNEL_HOSTNAME").pipe(
      Config.withDefault(""),
    );
    const tunnelId = yield* Config.redacted("RELAY_DATABASE_TUNNEL_CLIENT_ID").pipe(
      Config.withDefault(Redacted.make("")),
    );
    const tunnelSecret = yield* Config.redacted("RELAY_DATABASE_TUNNEL_CLIENT_SECRET").pipe(
      Config.withDefault(Redacted.make("")),
    );
    const tunnelConfig = yield* Effect.try({
      try: () =>
        databaseTunnelConfiguration(
          tunnelHost,
          Redacted.value(tunnelId),
          Redacted.value(tunnelSecret),
        ),
      catch: () => new DatabaseSetupError({ message: "Invalid database tunnel configuration" }),
    });
    const tunnel = tunnelConfig
      ? yield* Effect.acquireRelease(
          Effect.tryPromise({
            try: () => startDatabaseTunnel(tunnelConfig),
            catch: () => new DatabaseSetupError({ message: "Database tunnel could not start" }),
          }),
          (connection) => Effect.promise(() => connection.close()),
        )
      : undefined;
    const operation = verifyOnly
      ? Effect.gen(function* () {
          const sql = yield* PgClient.PgClient;
          yield* sql`SELECT 1`;
        })
      : migrateDatabase(yield* listSqlFiles("./migrations/postgres")).pipe(
          Effect.andThen(configureRuntimeRole(origin)),
        );
    yield* operation.pipe(
      Effect.provide(
        PgClient.layer({
          host: tunnel ? "127.0.0.1" : owner.host,
          port: tunnel?.port ?? owner.port,
          database: owner.database,
          username: owner.user,
          password: owner.password,
          ssl: { ...tls.client, servername: owner.host },
          maxConnections: 1,
          connectTimeout: "10 seconds",
        }),
      ),
    );
  }).pipe(
    Effect.scoped,
    // SQL errors may contain password-setting statements. Do not expose causes.
    Effect.mapError(
      () =>
        new DatabaseSetupError({
          message: verifyOnly
            ? "PostgreSQL preflight failed. Check database network access, tunnel credentials, TLS trust and owner credentials."
            : "PostgreSQL setup failed. Check database network access, tunnel credentials, owner permissions and migration compatibility.",
        }),
    ),
  );

export const prepareRelayDatabase = databaseOperation(false);
export const checkRelayDatabase = databaseOperation(true);

if (import.meta.main)
  NodeRuntime.runMain(checkRelayDatabase.pipe(Effect.provide(NodeServices.layer)));
