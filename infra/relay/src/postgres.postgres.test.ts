// @effect-diagnostics nodeBuiltinImport:off - Opt-in integration against a disposable local PostgreSQL database.
import * as NodeCrypto from "node:crypto";
import { expect, it } from "@effect/vitest";
import * as PgClient from "@effect/sql-pg/PgClient";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Redacted from "effect/Redacted";
import * as Pg from "pg";

const url = process.env.VITRE_STORE_TEST_DATABASE_URL;

it.live.skipIf(!url)(
  "discards a PID-less transaction and releases its lock within the server statement deadline",
  () => {
    const target = new URL(url!);
    if (target.hostname !== "127.0.0.1" || target.pathname !== "/vitre_store")
      throw new Error("Use only the disposable local vitre_store database");
    const table = `cancel_${NodeCrypto.randomUUID().replaceAll("-", "")}`;
    const application = `vitre-test-${table}`;
    return Effect.gen(function* () {
      const admin = yield* PgClient.PgClient;
      yield* admin`CREATE TABLE ${admin(table)} (id int PRIMARY KEY, value int NOT NULL)`;
      yield* admin`INSERT INTO ${admin(table)} VALUES (1, 1)`;
      yield* Effect.gen(function* () {
        const client = yield* PgClient.PgClient;
        const fiber = yield* Effect.forkChild(
          client.withTransaction(
            Effect.gen(function* () {
              // Socket closure alone need not interrupt a running origin query.
              // The runtime role supplies this bound in production (8 seconds).
              yield* client`SET LOCAL statement_timeout='1s'`;
              yield* client`UPDATE ${client(table)} SET value = 2 WHERE id = 1`;
              yield* client`SELECT pg_sleep(60)`;
            }),
          ),
        );
        let sleeping = false;
        for (let attempt = 0; attempt < 100; attempt++) {
          const rows = yield* admin<{
            sleeping: boolean;
          }>`SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE application_name=${application} AND wait_event='PgSleep') AS sleeping`;
          if (rows[0]!.sleeping) {
            sleeping = true;
            break;
          }
          yield* Effect.sleep("10 millis");
        }
        expect(sleeping).toBe(true);
        yield* Fiber.interrupt(fiber);
        // This would block behind the interrupted transaction if it leaked its lock.
        const rows = yield* admin.withTransaction(
          Effect.gen(function* () {
            yield* admin`SET LOCAL lock_timeout='2s'`;
            return yield* admin<{
              value: number;
            }>`SELECT value FROM ${admin(table)} WHERE id=1 FOR UPDATE`;
          }),
        );
        expect(rows[0]!.value).toBe(1);
        expect(yield* client`SELECT 42 AS answer`).toEqual([{ answer: 42 }]);
      }).pipe(
        Effect.provide(
          PgClient.layerFrom(
            PgClient.fromPool({
              acquire: Effect.acquireRelease(
                Effect.sync(() => {
                  const pool = new Pg.Pool({
                    connectionString: url!,
                    max: 1,
                    application_name: application,
                  });
                  pool.on("error", () => {});
                  pool.on("connect", (client) => {
                    // Reproduce Hyperdrive's missing BackendKeyData on a real SQL connection.
                    (client as unknown as { processID: number | null }).processID = null;
                  });
                  return pool;
                }),
                (pool) => Effect.promise(() => pool.end()),
              ),
            }),
          ),
        ),
        Effect.ensuring(admin`DROP TABLE ${admin(table)}`.pipe(Effect.orDie)),
      );
    }).pipe(Effect.provide(PgClient.layer({ url: Redacted.make(url!), maxConnections: 2 })));
  },
  15_000,
);
