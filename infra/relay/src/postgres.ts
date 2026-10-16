import * as PgClient from "@effect/sql-pg/PgClient";
import { ExecutionContext } from "alchemy/ExecutionContext";
import { proxyChain } from "alchemy/Util/proxy-chain";
import * as PgDrizzle from "drizzle-orm/effect-postgres";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import type { SqlError } from "effect/unstable/sql/SqlError";
import * as Pg from "pg";

type Database = PgDrizzle.EffectPgDatabase & { readonly $client: PgClient.PgClient };

/** Reuse a lazy pool within one Worker event, then close it with that event. */
export const requestPostgres = <E, R>(
  connectionString: Effect.Effect<Redacted.Redacted<string>, E, R>,
): Effect.Effect<Database> =>
  Effect.sync(() => {
    const connections = new WeakMap<
      ExecutionContext["Service"],
      Effect.Effect<Database, E | SqlError, R>
    >();
    return proxyChain<Database>(
      Effect.gen(function* () {
        const execution = yield* ExecutionContext;
        const cached = connections.get(execution);
        if (cached) return yield* cached;
        const connection = yield* Effect.gen(function* () {
          const url = yield* connectionString;
          // Hyperdrive owns the origin connection pool. Its credentials and
          // sockets belong to this Worker event, never to a global singleton.
          // PgClient.make probes with SELECT 1 first; fromPool lets the first
          // application query establish and validate the connection instead.
          const clientLayer = PgClient.layerFrom(
            PgClient.fromPool({
              acquire: Effect.acquireRelease(
                Effect.sync(() => {
                  const pool = new Pg.Pool({
                    connectionString: Redacted.value(url),
                    connectionTimeoutMillis: 5_000,
                    application_name: "vitre-relay",
                  });
                  // Active query errors are reported by PgClient. A failed idle
                  // socket is discarded by pg and must not crash the Worker.
                  pool.on("error", () => {});
                  return pool;
                }),
                (pool) => Effect.promise(() => pool.end()).pipe(Effect.timeoutOption(1_000)),
              ),
            }),
          );
          const context = yield* Layer.buildWithScope(clientLayer, execution.scope);
          return yield* PgDrizzle.makeWithDefaults().pipe(Effect.provideContext(context));
        }).pipe(Effect.cached);
        connections.set(execution, connection);
        return yield* connection;
      }),
    );
  });
