// @effect-diagnostics nodeBuiltinImport:off - Opt-in integration against a disposable local PostgreSQL database.
import * as NodeCrypto from "node:crypto";
import * as PgClient from "@effect/sql-pg/PgClient";
import * as PgDrizzle from "drizzle-orm/effect-postgres";
import { ExecutionContext } from "alchemy/ExecutionContext";
import { proxyChain } from "alchemy/Util/proxy-chain";
import * as Scope from "effect/Scope";
import { requestPostgres } from "../postgres.ts";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import { expect, it } from "@effect/vitest";
import { RelayDb } from "../db.ts";
import { CloudStore, controlStore, layer } from "./store.ts";
import { CloudError } from "./policy.ts";
import { emptyLens } from "@t3tools/shared/lens";
import { applyCommand, schedule } from "./state.ts";
import { reconciliationUsers } from "./reconciliation.ts";

const url = process.env.VITRE_STORE_TEST_DATABASE_URL;
const encodeJson = Schema.encodeEffect(Schema.UnknownFromJsonString);

it.live.skipIf(!url)(
  "accepts a follow-up during a batched wake burst without transferring retained history",
  () => {
    const target = new URL(url!);
    if (target.hostname !== "127.0.0.1" || target.pathname !== "/vitre_store")
      throw new Error("Use only the disposable local vitre_store database");
    const userId = `store-burst-${NodeCrypto.randomUUID()}`;
    const now = 1_793_750_400_000;
    const history = NodeCrypto.randomBytes(1_100_000).toString("base64");
    return Effect.gen(function* () {
      const sql = yield* PgClient.PgClient;
      yield* sql`CREATE TABLE IF NOT EXISTS relay_cloud_accounts (user_id varchar(255) PRIMARY KEY, revision integer NOT NULL, document jsonb NOT NULL)`;
      const db = yield* PgDrizzle.makeWithDefaults();
      // Inject network latency at the query boundary, including each CAS retry.
      // Queue wakeups are hints: the deployed consumer reduces each batch to
      // one scheduler pass per account instead of 32 competing writers.
      const delayed = proxyChain<RelayDb["Service"]>(
        Effect.sleep("400 millis").pipe(Effect.as(db)),
      );
      const scope = yield* Scope.Scope;
      yield* Effect.gen(function* () {
        const store = yield* CloudStore;
        const control = controlStore(store, { lens: "omit" });
        yield* store.mutate(userId, (doc) => {
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
          doc.state.events = {
            task: [
              {
                cursor: 1,
                attemptId: "task-1",
                sequence: 1,
                phase: "heartbeat",
                detail: history,
                createdAt: "2026-11-04T00:00:00Z",
              },
            ],
          };
        });
        const before = yield* control.read(userId);
        expect((yield* encodeJson(before)).length).toBeLessThan(10_000);
        expect(before.state).not.toHaveProperty("events");
        const request = {
          type: "task.continue" as const,
          idempotencyKey: "follow-up",
          taskId: "task",
          prompt: "Continue",
          attachments: [],
        };
        yield* Effect.all(
          [
            Effect.forEach(
              reconciliationUsers(Array.from({ length: 32 }, () => ({ userId }))),
              (id) => control.mutate(id, (doc) => schedule(doc.state, now + 1000, true, true)),
              { discard: true },
            ),
            control.mutate(userId, (doc) => {
              const result = applyCommand(
                doc.state,
                request,
                "follow-up",
                "fingerprint",
                now + 1000,
                true,
              );
              schedule(doc.state, now + 1000, true, true);
              return result;
            }),
          ],
          { concurrency: "unbounded" },
        );
        const accepted = yield* store.read(userId);
        // Only the user turn advanced the revision; idle scheduling stayed read-only.
        expect(accepted.state.revision).toBe(before.state.revision! + 1);
        expect(accepted.state.tasks.task!.turnRequestId).toBe("follow-up");
        expect(accepted.state.receipts["follow-up"]?.entityId).toBe("task");
        expect(accepted.state.events!.task![0]!.detail).toBe(history);
        yield* control.mutate(userId, (doc) =>
          applyCommand(doc.state, request, "unused", "fingerprint", now + 2000, true),
        );
        expect((yield* control.read(userId)).state.revision).toBe(accepted.state.revision);
      }).pipe(
        Effect.provide(layer),
        Effect.provideService(RelayDb, delayed),
        Effect.provideService(ExecutionContext, { scope, cache: {} }),
        Effect.ensuring(
          sql`DELETE FROM relay_cloud_accounts WHERE user_id = ${userId}`.pipe(Effect.orDie),
        ),
      );
    }).pipe(Effect.provide(PgClient.layer({ url: Redacted.make(url!), maxConnections: 4 })));
  },
  15_000,
);

it.live.skipIf(!url)(
  "commits concurrent account creation and updates without losing writes; rolls back rejected reducers",
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
        const control = controlStore(store, { lens: "omit" });
        yield* store.mutate(userId, (doc) => {
          doc.state.events = { task: [] };
          doc.state.lens = emptyLens();
          doc.state.lensConversations = {
            task: {
              id: "task",
              projectId: "project",
              title: "Retained",
              updatedAt: "2026-11-04T00:00:00Z",
              lastAssistantAt: null,
              readAt: null,
              busy: false,
              needsInput: false,
              archived: false,
              model: null,
              turns: 1,
              excerpt: "Retained excerpt",
            },
          };
          doc.private.endpoints.obsolete = { version: 1, iv: "unused", ciphertext: "unused" };
        });
        const compact = yield* control.read(userId);
        expect(compact.state).not.toHaveProperty("events");
        expect(compact.state).not.toHaveProperty("lensConversations");
        expect(compact.state).not.toHaveProperty("lens");
        expect((yield* controlStore(store).read(userId)).state.lens).toBeDefined();
        const append = (index: number) =>
          store.mutate(userId, (doc) => {
            doc.state.lens!.revision++;
            doc.state.lensConversations!.task = {
              ...doc.state.lensConversations!.task!,
              turns: doc.state.lensConversations!.task!.turns + 1,
            };
            doc.state.events!.task!.push({
              cursor: index,
              attemptId: "a",
              sequence: index,
              phase: "heartbeat",
              detail: "history".repeat(1000),
              createdAt: "2026-11-04T00:00:00Z",
            });
          });
        const update = () =>
          control.mutate(userId, (doc) => {
            doc.state.usage.compact = (doc.state.usage.compact ?? 0) + 1;
            delete doc.private.endpoints.obsolete;
          });
        yield* Effect.all(
          Array.from({ length: 12 }, (_, index) => [append(index), update()]).flat(),
          { concurrency: 8 },
        );
        const preserved = yield* store.read(userId);
        expect(preserved.state.events!.task).toHaveLength(12);
        expect(preserved.state.usage.compact).toBe(12);
        expect(preserved.state.lens!.revision).toBe(12);
        expect(preserved.state.lensConversations!.task).toMatchObject({
          turns: 13,
          excerpt: "Retained excerpt",
        });
        expect(preserved.private.endpoints.obsolete).toBeUndefined();
        const revision = yield* control.mutate(userId, (doc) => doc.state.revision);
        expect(revision).toBe(preserved.state.revision);
        expect(
          (yield* Effect.flip(
            control.mutate(userId, (doc) => {
              doc.state.events = {};
            }),
          )).code,
        ).toBe("persistence_unavailable");
        expect((yield* store.read(userId)).state.events).toEqual(preserved.state.events);
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
