import { describe, expect, it } from "@effect/vitest";
import { ExecutionContext } from "alchemy/ExecutionContext";
import { sql } from "drizzle-orm";
import * as Effect from "effect/Effect";
import * as Deferred from "effect/Deferred";
import * as Fiber from "effect/Fiber";
import * as Redacted from "effect/Redacted";
import * as Result from "effect/Result";
import * as Scope from "effect/Scope";
import { beforeEach, vi } from "vite-plus/test";
import { requestPostgres } from "./postgres.ts";

const database = vi.hoisted(() => ({
  pools: [] as Array<{ end: ReturnType<typeof vi.fn>; options: { connectionString: string } }>,
  queries: [] as string[],
  connectError: null as Error | null,
  clients: [] as Array<{ end: ReturnType<typeof vi.fn>; release: ReturnType<typeof vi.fn> }>,
  queryStarted: null as (() => void) | null,
}));

vi.mock("pg", () => ({
  Pool: class {
    readonly end = vi.fn(async () => {});
    readonly on = vi.fn();
    readonly options: { connectionString: string };
    constructor(options: { connectionString: string }) {
      this.options = options;
      database.pools.push(this);
    }
    connect(callback: (error: Error | null, client?: object, release?: () => void) => void) {
      if (database.connectError) {
        callback(database.connectError);
        return;
      }
      let pending: ((error: Error) => void) | undefined;
      let ended = false;
      const client = {
        processID: null,
        on: vi.fn(),
        once: vi.fn(),
        off: vi.fn(),
        release: vi.fn(),
        end: vi.fn(async () => {
          ended = true;
          pending?.(new Error("Connection terminated"));
        }),
        query: (
          query: string,
          _params: unknown[],
          done: (error: Error | null, result?: { rows: Array<{ answer: number }> }) => void,
        ) => {
          database.queries.push(query);
          if (ended) return done(new Error("Connection already ended"));
          if (query === "select blocked") {
            pending = done;
            database.queryStarted?.();
            return;
          }
          done(null, { rows: [{ answer: 42 }] });
        },
      };
      database.clients.push(client);
      callback(null, client, client.release);
    }
  },
}));

const request = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  Effect.scoped(
    Effect.gen(function* () {
      const scope = yield* Scope.Scope;
      return yield* Effect.gen(function* () {
        return yield* effect;
      }).pipe(Effect.provideService(ExecutionContext, { scope, cache: {} }));
    }),
  );

describe("request PostgreSQL connection", () => {
  beforeEach(() => {
    database.pools.length = 0;
    database.queries.length = 0;
    database.connectError = null;
    database.clients.length = 0;
    database.queryStarted = null;
  });

  it.effect(
    "discards an interrupted Hyperdrive connection without querying a null backend PID",
    () =>
      Effect.gen(function* () {
        const db = yield* requestPostgres(
          Effect.succeed(Redacted.make("postgresql://user:secret@hyperdrive.test/db")),
        );
        yield* request(
          Effect.gen(function* () {
            const started = yield* Deferred.make<void>();
            database.queryStarted = () => {
              Deferred.doneUnsafe(started, Effect.void);
            };
            const fiber = yield* Effect.forkChild(
              Effect.gen(function* () {
                yield* db.execute(sql`select blocked`);
              }),
            );
            yield* Deferred.await(started);
            yield* Effect.yieldNow;
            expect(database.queries).toEqual(["select blocked"]);
            yield* Fiber.interrupt(fiber);
            expect(database.clients[0]!.end).toHaveBeenCalledExactlyOnceWith();
            expect(database.clients[0]!.release).toHaveBeenCalledTimes(1);
            expect(yield* db.execute(sql`select 42`)).toEqual([{ answer: 42 }]);
            expect(database.clients).toHaveLength(2);
            expect(database.queries.some((query) => query.includes("pg_cancel_backend"))).toBe(
              false,
            );
          }),
        );
      }),
  );

  it.effect("runs the first application query without a probe and reuses its pool", () =>
    Effect.gen(function* () {
      let credentialsRead = 0;
      const db = yield* requestPostgres(
        Effect.sync(() => {
          credentialsRead++;
          return Redacted.make("postgresql://user:secret@request-one.test/db");
        }),
      );
      expect(credentialsRead).toBe(0);
      expect(database.pools).toHaveLength(0);
      yield* request(
        Effect.gen(function* () {
          expect(yield* db.execute(sql`select 42 as answer`)).toEqual([{ answer: 42 }]);
          yield* db.execute(sql`select 43 as answer`);
          expect(credentialsRead).toBe(1);
          expect(database.pools).toHaveLength(1);
          expect(database.pools[0]!.end).not.toHaveBeenCalled();
        }),
      );
      expect(database.queries).toEqual(["select 42 as answer", "select 43 as answer"]);
      expect(database.pools[0]!.end).toHaveBeenCalledExactlyOnceWith();
    }),
  );

  it.effect("gets new credentials and a fresh pool for each Worker event", () =>
    Effect.gen(function* () {
      let credentialsRead = 0;
      const db = yield* requestPostgres(
        Effect.sync(() =>
          Redacted.make(`postgresql://user:secret@request-${++credentialsRead}.test/db`),
        ),
      );
      yield* request(db.execute(sql`select 42`));
      yield* request(db.execute(sql`select 42`));
      expect(credentialsRead).toBe(2);
      expect(database.pools).toHaveLength(2);
      expect(database.pools[0]!.options.connectionString).toContain("request-1.test");
      expect(database.pools[1]!.options.connectionString).toContain("request-2.test");
      for (const pool of database.pools) expect(pool.end).toHaveBeenCalledExactlyOnceWith();
    }),
  );

  it.effect("reports the first connection failure as a typed query error and closes the pool", () =>
    Effect.gen(function* () {
      database.connectError = Object.assign(new Error("Connection unavailable"), {
        code: "ECONNREFUSED",
      });
      const db = yield* requestPostgres(
        Effect.succeed(Redacted.make("postgresql://user:secret@unavailable.test/db")),
      );
      const result = yield* request(db.execute(sql`select 42`)).pipe(Effect.result);
      expect(Result.isFailure(result)).toBe(true);
      expect(database.queries).toEqual([]);
      expect(database.pools[0]!.end).toHaveBeenCalledExactlyOnceWith();
    }),
  );
});
