import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import { proxyChain } from "alchemy/Util/proxy-chain";
import { RelayDb } from "../db.ts";
import { CloudStore, emptyDocument, layer, type CloudAccountDocument } from "./store.ts";
import { publicOverview } from "./state.ts";
import { CloudError } from "./policy.ts";

/** Exercise reducer results and rollback at a deterministic transaction boundary. */
function fixture(initialRevision?: number, race = false) {
  let row =
    initialRevision === undefined
      ? undefined
      : {
          userId: "user",
          revision: initialRevision,
          document: emptyDocument(),
        };
  if (row) row.document.state.revision = 999;
  const attempted: number[] = [];
  let raced = false;
  const select = () => ({
    from: () => ({
      where: () => ({
        limit: () => {
          const read = Effect.sync(() => (row ? [structuredClone(row)] : []));
          return Object.assign(read, {
            for: () =>
              Effect.gen(function* () {
                if (race && !raced && row) {
                  raced = true;
                  row = { ...row, revision: row.revision + 1 };
                }
                return yield* read;
              }),
          });
        },
      }),
    }),
  });
  const db = {
    select,
    execute: () => Effect.void,
    transaction: <A, E>(reduce: (tx: unknown) => Effect.Effect<A, E>) =>
      Effect.gen(function* () {
        const prior = structuredClone(row);
        return yield* reduce(db).pipe(
          Effect.onError(() =>
            Effect.sync(() => {
              row = prior;
            }),
          ),
        );
      }),
    insert: () => ({
      values: (candidate: typeof row) => ({
        onConflictDoNothing: () =>
          Effect.sync(() => {
            if (!row)
              row = race ? { userId: "user", revision: 1, document: emptyDocument() } : candidate;
            raced = true;
          }),
      }),
    }),
    update: () => ({
      set: (candidate: { revision: number; document: CloudAccountDocument }) => ({
        where: () =>
          Effect.sync(() => {
            attempted.push(candidate.revision);
            row = { userId: "user", ...candidate };
          }),
      }),
    }),
  };
  const run = <A, E>(effect: Effect.Effect<A, E, CloudStore>) =>
    effect.pipe(
      Effect.provide(layer),
      Effect.provideService(RelayDb, db as unknown as RelayDb["Service"]),
    );
  return { run, attempted };
}

describe("account overview revision", () => {
  it.effect("rolls back account creation and preserves the reducer's rejection", () => {
    const f = fixture();
    return f.run(
      Effect.gen(function* () {
        const store = yield* CloudStore;
        const failure = yield* Effect.flip(
          store.mutate("user", (document) => {
            document.state.usage.qa = 999;
            throw new CloudError("not_allowed", "Rejected", 403);
          }),
        );
        expect(failure.code).toBe("not_allowed");
        const document = yield* store.read("user");
        expect(document.state.revision).toBe(0);
        expect(document.state.usage).toEqual({});
        expect(f.attempted).toEqual([]);
        expect(yield* store.mutate("user", (value) => value.state.revision)).toBe(1);
      }),
    );
  });
  it.effect("reads SQL revision rather than a stale document copy", () => {
    const f = fixture(7);
    return f.run(
      Effect.gen(function* () {
        const store = yield* CloudStore;
        const document = yield* store.read("user");
        expect(publicOverview(document.state, true, 0).revision).toBe(7);
      }),
    );
  });
  it.effect("returns the locked revision after waiting for a concurrent update", () => {
    const f = fixture(7, true);
    return f.run(
      Effect.gen(function* () {
        const store = yield* CloudStore;
        const overview = yield* store.mutate("user", (document) =>
          publicOverview(document.state, true, 0),
        );
        expect(f.attempted).toEqual([9]);
        expect(overview.revision).toBe(9);
        expect((yield* store.read("user")).state.revision).toBe(9);
      }),
    );
  });
  it.effect("reloads a concurrent first-account insert before reducing its document", () => {
    const f = fixture(undefined, true);
    return f.run(
      Effect.gen(function* () {
        const store = yield* CloudStore;
        expect((yield* store.read("user")).state.revision).toBe(0);
        const overview = yield* store.mutate("user", (document) =>
          publicOverview(document.state, true, 0),
        );
        expect(f.attempted).toEqual([2]);
        expect(overview.revision).toBe(2);
      }),
    );
  });
});

it.effect("returns runnable Effects when the database is a request-bound query proxy", () => {
  const rows = [{ userId: "owner", revision: 7, document: emptyDocument() }];
  const query = Object.assign(Effect.succeed(rows), {
    where: () => ({ limit: () => Effect.succeed(rows) }),
  });
  const database = proxyChain(Effect.succeed({ select: () => ({ from: () => query }) }));
  return Effect.gen(function* () {
    const store = yield* CloudStore;
    const read = store.read("owner");
    // A raw query proxy works with yield*, but hangs when a runtime evaluates
    // it as an Effect directly (including the GitHub Promise adapter).
    expect(Effect.isEffect(read)).toBe(true);
    expect(Effect.isEffect(store.users)).toBe(true);
    const fiber = yield* Effect.forkChild(read);
    expect((yield* Fiber.join(fiber)).state.revision).toBe(7);
    expect(yield* store.users).toEqual(["owner"]);
  }).pipe(
    Effect.provide(
      layer.pipe(Layer.provide(Layer.succeed(RelayDb, database as unknown as RelayDb["Service"]))),
    ),
  );
});
