import { and, eq } from "drizzle-orm";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { RelayDb } from "../db.ts";
import { relayCloudAccounts } from "../persistence/schema.ts";
import { CloudError } from "./policy.ts";
import { initialState, type CloudState } from "./state.ts";
import type { SealedCredential } from "./crypto.ts";

export interface CloudPrivateData {
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
      read: (userId) =>
        load(userId).pipe(
          Effect.map((rows) => {
            const document = structuredClone(rows[0]?.document ?? emptyDocument());
            document.state.revision = rows[0]?.revision ?? 0;
            return document;
          }),
        ),
      users: db
        .select({ userId: relayCloudAccounts.userId })
        .from(relayCloudAccounts)
        .pipe(
          Effect.map((rows) => rows.map((r) => r.userId)),
          Effect.mapError(persistenceError),
        ),
      mutate: <A>(userId: string, reduce: (document: CloudAccountDocument) => A) =>
        Effect.gen(function* () {
          // Retried reducers may run more than once. They must never perform external I/O.
          for (let attempt = 0; attempt < 12; attempt++) {
            const existing = (yield* load(userId))[0];
            const document = structuredClone(existing?.document ?? emptyDocument());
            // The candidate revision is visible to the reducer's response, but
            // only returned after this exact CAS commits. Losing candidates and
            // their responses are discarded together.
            document.state.revision = (existing?.revision ?? 0) + 1;
            const result = yield* Effect.try({
              try: () => reduce(document),
              catch: (error) => (error instanceof CloudError ? error : persistenceError()),
            });
            if (!existing) {
              const inserted = yield* db
                .insert(relayCloudAccounts)
                .values({ userId, revision: 1, document })
                .onConflictDoNothing()
                .returning({ userId: relayCloudAccounts.userId })
                .pipe(Effect.mapError(persistenceError));
              if (inserted.length) return result;
            } else {
              const updated = yield* db
                .update(relayCloudAccounts)
                .set({ revision: existing.revision + 1, document })
                .where(
                  and(
                    eq(relayCloudAccounts.userId, userId),
                    eq(relayCloudAccounts.revision, existing.revision),
                  ),
                )
                .returning({ userId: relayCloudAccounts.userId })
                .pipe(Effect.mapError(persistenceError));
              if (updated.length) return result;
            }
          }
          return yield* Effect.fail(
            new CloudError(
              "concurrent_update",
              "Cloud state changed repeatedly; retry the request",
              409,
            ),
          );
        }),
    });
  }),
);
