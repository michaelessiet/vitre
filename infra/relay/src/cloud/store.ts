// @effect-diagnostics preferSchemaOverJson:off - Compare the persisted JSON aggregate for no-op writes without introducing a second schema for private state.
import { and, eq } from "drizzle-orm";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Random from "effect/Random";
import * as Option from "effect/Option";
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
      // Reducers may be replayed after a revision conflict. Keep all side effects
      // (including IDs, timestamps and external I/O) outside the reducer.
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
          // Never hold a row lock while transferring/cloning the account document
          // or running a reducer. A single conditional write commits the document,
          // receipts, leases and outbox together across all Worker isolates.
          for (let attempt = 0; attempt < 32; attempt++) {
            const existing = (yield* load(userId))[0];
            const revision = (existing?.revision ?? 0) + 1;
            const original = existing?.document ?? emptyDocument();
            const document = structuredClone(original);
            document.state.revision = revision;
            const serialized = (value: CloudAccountDocument) =>
              Effect.try({
                try: () => JSON.stringify(value),
                catch: persistenceError,
              });
            const before = yield* serialized(document);
            const result = yield* Effect.try({
              try: () => reduce(document),
              catch: (error) => (error instanceof CloudError ? error : persistenceError()),
            });
            if ((yield* serialized(document)) === before) {
              // Idle scheduler polls and idempotent replays need no write. Return
              // a result based on the actual revision, not an uncommitted increment.
              const unchanged = structuredClone(original);
              unchanged.state.revision = existing?.revision ?? 0;
              const unchangedBefore = yield* serialized(unchanged);
              const unchangedResult = yield* Effect.try({
                try: () => reduce(unchanged),
                catch: (error) => (error instanceof CloudError ? error : persistenceError()),
              }).pipe(Effect.option);
              // A reducer may inspect the proposed revision. Only skip its write
              // if replaying at the persisted revision is also a no-op.
              if (
                Option.isSome(unchangedResult) &&
                (yield* serialized(unchanged)) === unchangedBefore
              )
                return unchangedResult.value;
            }
            const committed = existing
              ? yield* db
                  .update(relayCloudAccounts)
                  .set({ revision, document })
                  .where(
                    and(
                      eq(relayCloudAccounts.userId, userId),
                      eq(relayCloudAccounts.revision, existing.revision),
                    ),
                  )
                  .returning({ revision: relayCloudAccounts.revision })
              : yield* db
                  .insert(relayCloudAccounts)
                  .values({ userId, revision, document })
                  .onConflictDoNothing()
                  .returning({ revision: relayCloudAccounts.revision });
            if (committed.length > 0) return result;
            // Only a known revision conflict is retryable. Connection/commit
            // failures are ambiguous and must retain command idempotency handling.
            const delay = yield* Random.nextIntBetween(1, Math.min(250, 10 * 2 ** attempt));
            yield* Effect.sleep(delay);
          }
          return yield* Effect.fail(persistenceError());
        }).pipe(
          Effect.mapError((error) => (error instanceof CloudError ? error : persistenceError())),
          Effect.timeoutOrElse({
            duration: "20 seconds",
            orElse: () => Effect.fail(persistenceError()),
          }),
        ),
    });
  }),
);
