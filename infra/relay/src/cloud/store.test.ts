import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { RelayDb } from "../db.ts";
import { CloudStore, emptyDocument, layer, type CloudAccountDocument } from "./store.ts";
import { publicOverview } from "./state.ts";

/** Exercise the real optimistic store against a deterministic SQL boundary. */
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
  const commit = (candidate: { revision: number; document: CloudAccountDocument }) =>
    Effect.sync(() => {
      attempted.push(candidate.revision);
      if (race && !raced) {
        raced = true;
        row = { userId: "user", revision: (row?.revision ?? 0) + 1, document: emptyDocument() };
        return [];
      }
      row = { userId: "user", ...candidate };
      return [{ userId: "user" }];
    });
  const db = {
    select: () => ({
      from: () =>
        Object.assign(Effect.succeed([{ userId: "user" }]), {
          where: () => ({ limit: () => Effect.sync(() => (row ? [structuredClone(row)] : [])) }),
        }),
    }),
    insert: () => ({
      values: (candidate: { revision: number; document: CloudAccountDocument }) => ({
        onConflictDoNothing: () => ({ returning: () => commit(candidate) }),
      }),
    }),
    update: () => ({
      set: (candidate: { revision: number; document: CloudAccountDocument }) => ({
        where: () => ({ returning: () => commit(candidate) }),
      }),
    }),
  } as unknown as RelayDb["Service"];
  const run = <A, E>(effect: Effect.Effect<A, E, CloudStore>) =>
    effect.pipe(Effect.provide(layer), Effect.provideService(RelayDb, db));
  return { run, attempted };
}

describe("account overview revision", () => {
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
  it.effect("returns only the winning CAS revision after a concurrent update", () => {
    const f = fixture(7, true);
    return f.run(
      Effect.gen(function* () {
        const store = yield* CloudStore;
        const overview = yield* store.mutate("user", (document) =>
          publicOverview(document.state, true, 0),
        );
        expect(f.attempted).toEqual([8, 9]);
        expect(overview.revision).toBe(9);
        expect((yield* store.read("user")).state.revision).toBe(9);
      }),
    );
  });
  it.effect(
    "retries a first-account insert collision without returning the losing revision",
    () => {
      const f = fixture(undefined, true);
      return f.run(
        Effect.gen(function* () {
          const store = yield* CloudStore;
          expect((yield* store.read("user")).state.revision).toBe(0);
          const overview = yield* store.mutate("user", (document) =>
            publicOverview(document.state, true, 0),
          );
          expect(f.attempted).toEqual([1, 2]);
          expect(overview.revision).toBe(2);
        }),
      );
    },
  );
});
