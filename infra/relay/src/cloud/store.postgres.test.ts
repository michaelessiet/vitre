// @effect-diagnostics nodeBuiltinImport:off - Opt-in integration against a disposable local PostgreSQL database.
import * as NodeCrypto from "node:crypto";
import * as PgClient from "@effect/sql-pg/PgClient";
import { ExecutionContext } from "alchemy/ExecutionContext";
import * as Scope from "effect/Scope";
import { requestPostgres } from "../postgres.ts";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import { expect, it } from "@effect/vitest";
import { RelayDb } from "../db.ts";
import { CloudStore, layer } from "./store.ts";
import { CloudError } from "./policy.ts";

const url = process.env.VITRE_STORE_TEST_DATABASE_URL;

it.effect.skipIf(!url)(
  "serializes concurrent account creation and updates without losing writes; rolls back rejected reducers",
  () => {
    const target = new URL(url!);
    if (target.hostname !== "127.0.0.1" || target.pathname !== "/vitre_store")
      throw new Error("Use only the disposable local vitre_store database");
    const userId = `store-test-${NodeCrypto.randomUUID()}`;
    return Effect.gen(function* () {
      const sql = yield* PgClient.PgClient;
      yield* sql`CREATE TABLE IF NOT EXISTS relay_cloud_accounts (user_id varchar(255) PRIMARY KEY, revision integer NOT NULL, document jsonb NOT NULL)`;
      const db = yield* requestPostgres(Effect.succeed(Redacted.make(url!)));
      const scope = yield* Scope.Scope;
      yield* Effect.gen(function* () {
        const store = yield* CloudStore;
        const increment = () =>
          store.mutate(userId, (document) => {
            document.state.usage.qa = (document.state.usage.qa ?? 0) + 1;
            return { count: document.state.usage.qa, revision: document.state.revision };
          });
        for (let batch = 0; batch < 2; batch++) {
          const results = yield* Effect.all(Array.from({ length: 32 }, increment), {
            concurrency: "unbounded",
          });
          expect(results.map((result) => result.revision).sort((a, b) => a! - b!)).toEqual(
            Array.from({ length: 32 }, (_, index) => batch * 32 + index + 1),
          );
          expect(results.every((result) => result.count === result.revision)).toBe(true);
        }
        const rejected = yield* Effect.flip(
          store.mutate(userId, (document) => {
            document.state.usage.qa = 999;
            throw new CloudError("test_rejection", "Rejected reducer", 409);
          }),
        );
        expect(rejected.code).toBe("test_rejection");
        const document = yield* store.read(userId);
        expect(document.state.revision).toBe(64);
        expect(document.state.usage.qa).toBe(64);
        expect(yield* increment()).toEqual({ count: 65, revision: 65 });
      }).pipe(
        Effect.provide(layer),
        Effect.provideService(RelayDb, db),
        Effect.provideService(ExecutionContext, { scope, cache: {} }),
        Effect.ensuring(
          sql`DELETE FROM relay_cloud_accounts WHERE user_id = ${userId}`.pipe(Effect.orDie),
        ),
      );
    }).pipe(Effect.provide(PgClient.layer({ url: Redacted.make(url!), maxConnections: 12 })));
  },
  30_000,
);
