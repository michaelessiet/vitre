import { PgDialect } from "drizzle-orm/pg-core";
import type { SQL } from "drizzle-orm";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import { proxyChain } from "alchemy/Util/proxy-chain";
import { RelayDb } from "../db.ts";
import { CloudStore, emptyDocument, layer, type CloudAccountDocument } from "./store.ts";
import { applyCommand, publicOverview, schedule } from "./state.ts";
import { CloudError } from "./policy.ts";

/** Model an atomic revision-checked write, including a competing Worker. */
function fixture(initialRevision?: number, race = false, failWrite = false) {
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
  const competingWrite = () => {
    if (race && !raced) {
      raced = true;
      row = {
        userId: "user",
        revision: (row?.revision ?? 0) + 1,
        document: structuredClone(row?.document ?? emptyDocument()),
      };
      row.document.state.usage.competitor = 1;
    }
  };
  const persist = (
    candidate: { revision: number; document: CloudAccountDocument },
    expected?: number,
  ) =>
    Effect.gen(function* () {
      attempted.push(candidate.revision);
      competingWrite();
      if (failWrite) return yield* Effect.fail({ _tag: "AmbiguousCommitFailure" });
      if (row?.revision !== expected) return [];
      row = { userId: "user", ...structuredClone(candidate) };
      return [{ revision: candidate.revision }];
    });
  const db = {
    select: () => ({
      from: () => ({
        where: () => ({ limit: () => Effect.sync(() => (row ? [structuredClone(row)] : [])) }),
      }),
    }),
    insert: () => ({
      values: (candidate: { revision: number; document: CloudAccountDocument }) => ({
        onConflictDoNothing: () => ({ returning: () => persist(candidate) }),
      }),
    }),
    update: () => ({
      set: (candidate: { revision: number; document: CloudAccountDocument }) => ({
        where: (predicate: SQL) => ({
          returning: () => {
            const { sql, params } = new PgDialect().sqlToQuery(predicate);
            expect(sql).toContain('"revision" =');
            return persist(candidate, params[1] as number);
          },
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
  it.effect("does not persist an idle resident scheduler pass", () => {
    const f = fixture(7);
    const now = 1_793_750_400_000;
    return f.run(
      Effect.gen(function* () {
        const store = yield* CloudStore;
        yield* store.mutate("user", (doc) => {
          doc.state.accounts.codex.state = "connected";
          doc.state.repositories.repo = {
            id: "repo",
            installationId: "1",
            owner: "example",
            name: "repo",
            defaultBranch: "main",
            setupCommand: "",
            testCommand: "",
            revision: 1,
          };
          applyCommand(
            doc.state,
            {
              type: "task.create",
              idempotencyKey: "create",
              repositoryId: "repo",
              baseBranch: "main",
              provider: "codex",
              kind: "ask",
              prompt: "Explain",
              issueNumber: null,
            },
            "task",
            "create",
            now,
            true,
          );
          schedule(doc.state, now, true, true);
          const task = doc.state.tasks.task!;
          task.worker!.sandboxId = "machine-task-1";
          task.worker!.state = "ready";
          task.state = "running";
          task.idle = true;
          doc.state.operations = {};
        });
        const before = yield* store.read("user");
        const writes = f.attempted.length;
        for (let tick = 1; tick <= 10; tick++)
          yield* store.mutate("user", (doc) => schedule(doc.state, now + tick * 1000, true, true));
        expect(yield* store.read("user")).toEqual(before);
        expect(f.attempted).toHaveLength(writes);
      }),
    );
  });
  it.effect("does not write or advance the revision for idle polls and idempotent replays", () => {
    const f = fixture(7);
    return f.run(
      Effect.gen(function* () {
        const store = yield* CloudStore;
        const before = yield* store.read("user");
        const overview = yield* store.mutate("user", (doc) => publicOverview(doc.state, true, 0));
        expect(overview.revision).toBe(7);
        expect(yield* store.read("user")).toEqual(before);
        expect(f.attempted).toEqual([]);
      }),
    );
  });
  it.effect("preserves proposed-revision semantics when a reducer depends on the revision", () => {
    const f = fixture(7);
    return f.run(
      Effect.gen(function* () {
        const store = yield* CloudStore;
        const revision = yield* store.mutate("user", (document) => {
          if (document.state.revision === 7) document.state.usage.qa = 1;
          return document.state.revision;
        });
        expect(revision).toBe(8);
        expect(f.attempted).toEqual([8]);
        expect((yield* store.read("user")).state.usage).toEqual({});
      }),
    );
  });
  it.effect("does not reject an accepted reducer if its no-op revision probe rejects", () => {
    const f = fixture(7);
    return f.run(
      Effect.gen(function* () {
        const store = yield* CloudStore;
        const revision = yield* store.mutate("user", (document) => {
          if (document.state.revision === 7)
            throw new CloudError("revision_conflict", "Old revision", 409);
          return document.state.revision;
        });
        expect(revision).toBe(8);
        expect(f.attempted).toEqual([8]);
      }),
    );
  });
  it.effect("does not retry an ambiguous database failure", () => {
    const f = fixture(7, false, true);
    return f.run(
      Effect.gen(function* () {
        const store = yield* CloudStore;
        const error = yield* Effect.flip(
          store.mutate("user", (doc) => {
            doc.state.usage.qa = 1;
          }),
        );
        expect(error.code).toBe("persistence_unavailable");
        expect(f.attempted).toEqual([8]);
      }),
    );
  });
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
        expect(yield* store.mutate("user", (value) => value.state.revision)).toBe(0);
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
  it.live("replays a reducer on the winning revision without losing another Worker’s write", () => {
    const f = fixture(7, true);
    return f.run(
      Effect.gen(function* () {
        const store = yield* CloudStore;
        const overview = yield* store.mutate("user", (document) => {
          document.state.usage.qa = (document.state.usage.qa ?? 0) + 1;
          return publicOverview(document.state, true, 0);
        });
        expect(f.attempted).toEqual([8, 9]);
        expect((yield* store.read("user")).state.usage).toEqual({ competitor: 1, qa: 1 });
        expect(overview.revision).toBe(9);
        expect((yield* store.read("user")).state.revision).toBe(9);
      }),
    );
  });
  it.live("reloads a concurrent first-account insert before committing its document", () => {
    const f = fixture(undefined, true);
    return f.run(
      Effect.gen(function* () {
        const store = yield* CloudStore;
        expect((yield* store.read("user")).state.revision).toBe(0);
        const overview = yield* store.mutate("user", (document) => {
          document.state.usage.qa = (document.state.usage.qa ?? 0) + 1;
          return publicOverview(document.state, true, 0);
        });
        expect(f.attempted).toEqual([1, 2]);
        expect((yield* store.read("user")).state.usage).toEqual({ competitor: 1, qa: 1 });
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
