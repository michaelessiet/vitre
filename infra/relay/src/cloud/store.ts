import { eq, sql } from "drizzle-orm";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { RelayDb } from "../db.ts";
import { relayCloudAccounts } from "../persistence/schema.ts";
import { CloudError } from "./policy.ts";
import { initialState, type CloudState } from "./state.ts";
import type { SealedCredential } from "./crypto.ts";
import type { CloudMobileDevice, CloudPushEvent } from "./notifications.ts";

import type { StoredGitHubConnection, GitHubConnectionFlow } from "./githubConnections.ts";

export interface CloudPrivateData {
  githubConnections?: Record<string, StoredGitHubConnection>;
  githubConnectionFlows?: Record<string, GitHubConnectionFlow>;
  mobileDevices?: Record<string, CloudMobileDevice>;
  pushEvents?: Record<string, CloudPushEvent>;
  credentials: Partial<Record<"codex" | "claude", { version: number; sealed: SealedCredential }>>;
  workerTokens: Record<string, { hash: string; sealed: SealedCredential }>;
  endpoints: Record<string, SealedCredential>;
}
export interface CloudAccountDocument {
  state: CloudState;
  private: CloudPrivateData;
}
export const emptyDocument = (): CloudAccountDocument => ({
  state: initialState(),
  private: { credentials: {}, workerTokens: {}, endpoints: {} },
});

export class CloudStore extends Context.Service<
  CloudStore,
  {
    readonly read: (userId: string) => Effect.Effect<CloudAccountDocument, CloudError>;
    readonly mutate: <A>(
      userId: string,
      reduce: (document: CloudAccountDocument) => A,
    ) => Effect.Effect<A, CloudError>;
    readonly users: Effect.Effect<ReadonlyArray<string>, CloudError>;
  }
>()("t3code-relay/cloud/store/CloudStore") {}

const persistenceError = () =>
  new CloudError("persistence_unavailable", "Cloud state is temporarily unavailable", 503);

export const layer = Layer.effect(
  CloudStore,
  Effect.gen(function* () {
    const db = yield* RelayDb;
    const load = (userId: string) =>
      db
        .select()
        .from(relayCloudAccounts)
        .where(eq(relayCloudAccounts.userId, userId))
        .limit(1)
        .pipe(Effect.mapError(persistenceError));
    return CloudStore.of({
      // requestPostgres returns a lazy query proxy whose iterator must be
      // evaluated before handing the operation to a runtime or Promise adapter.
      read: Effect.fnUntraced(function* (userId) {
        const rows = yield* load(userId);
        const document = structuredClone(rows[0]?.document ?? emptyDocument());
        document.state.revision = rows[0]?.revision ?? 0;
        return document;
      }),
      users: Effect.gen(function* () {
        const rows = yield* db
          .select({ userId: relayCloudAccounts.userId })
          .from(relayCloudAccounts)
          .pipe(Effect.mapError(persistenceError));
        return rows.map((row) => row.userId);
      }),
      mutate: <A>(userId: string, reduce: (document: CloudAccountDocument) => A) =>
        Effect.gen(function* () {
          // Serialize this account in PostgreSQL, including across Worker isolates.
          // Reducers remain synchronous and must never perform external I/O.
          const committed = yield* db
            .transaction((tx) =>
              Effect.gen(function* () {
                yield* tx.execute(sql`SET LOCAL lock_timeout = '10s'`);
                const locked = () =>
                  tx
                    .select()
                    .from(relayCloudAccounts)
                    .where(eq(relayCloudAccounts.userId, userId))
                    .limit(1)
                    .for("update");
                let existing = (yield* locked())[0];
                if (!existing) {
                  // Another first request may insert while we wait; lock and reload
                  // its committed document instead of overwriting it with an empty one.
                  yield* tx
                    .insert(relayCloudAccounts)
                    .values({ userId, revision: 0, document: emptyDocument() })
                    .onConflictDoNothing();
                  existing = (yield* locked())[0];
                }
                if (!existing) return yield* Effect.fail(persistenceError());
                const document = structuredClone(existing.document);
                const revision = existing.revision + 1;
                document.state.revision = revision;
                const result = yield* Effect.try({
                  try: () => reduce(document),
                  catch: (error) => (error instanceof CloudError ? error : persistenceError()),
                });
                yield* tx
                  .update(relayCloudAccounts)
                  .set({ revision, document })
                  .where(eq(relayCloudAccounts.userId, userId));
                return result;
              }),
            )
            .pipe(
              Effect.mapError((error) =>
                error instanceof CloudError ? error : persistenceError(),
              ),
            );
          return committed;
        }),
    });
  }),
);
