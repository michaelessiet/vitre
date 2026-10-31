import {
  CommandId,
  ProjectId,
  ThreadId,
  type OrchestrationReadModel,
  type OrchestrationThreadShell,
} from "@t3tools/contracts";
import type { LensInventory } from "@t3tools/contracts/lens";
import { makeCloudClient } from "@t3tools/client-runtime/cloud";
import { emptyLens, lensActionStillValid } from "@t3tools/shared/lens";
import * as Config from "effect/Config";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { ProviderRegistry } from "../provider/Services/ProviderRegistry.ts";
import { ServerConfig } from "../config.ts";
import * as Schedule from "effect/Schedule";
import { desktopCloudSession } from "./DesktopCloudSession.ts";
import { ProjectionSnapshotQuery } from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import { OrchestrationEngineService } from "../orchestration/Services/OrchestrationEngine.ts";
import { ServerEnvironment } from "../environment/ServerEnvironment.ts";
import { threadHasQueuedTurnStart } from "../orchestration/decider.ts";
import { readExecutionOwnership } from "./executionOwnership.ts";

export function localLensInventory(
  snapshot: OrchestrationReadModel,
  shells: readonly OrchestrationThreadShell[],
  sourceId: string,
  label: string,
  now: string,
  excluded: ReadonlySet<string> = new Set(),
): LensInventory {
  const byId = new Map(shells.map((thread) => [thread.id, thread]));
  const threads = snapshot.threads.filter(
    (thread) =>
      thread.deletedAt === null && !thread.id.startsWith("cloud-") && !excluded.has(thread.id),
  );
  // A partial inventory cannot safely establish that a project is inactive.
  const excludedProjects = new Set(
    snapshot.threads.filter((thread) => excluded.has(thread.id)).map((thread) => thread.projectId),
  );
  if (threads.length > 2000 || snapshot.projects.length > 500)
    throw new Error("This workspace exceeds Lens's inventory limit.");
  return {
    sourceId,
    sourceLabel: label,
    collectedAt: now,
    projects: snapshot.projects
      .filter((project) => project.deletedAt === null && !excludedProjects.has(project.id))
      .map((project) => ({ id: project.id, title: project.title, updatedAt: project.updatedAt })),
    conversations: threads.map((thread) => {
      const shell = byId.get(thread.id);
      const assistant = thread.messages.findLast(
        (message) => message.role === "assistant" && !message.streaming,
      );
      const provider =
        thread.modelSelection.instanceId === "codex"
          ? "codex"
          : thread.modelSelection.instanceId === "claudeAgent"
            ? "claude"
            : null;
      return {
        id: thread.id,
        projectId: thread.projectId,
        title: thread.title,
        updatedAt: thread.updatedAt,
        lastAssistantAt: assistant?.createdAt ?? null,
        readAt: null,
        busy:
          thread.latestTurn?.state === "running" ||
          ["running", "starting"].includes(thread.session?.status ?? "") ||
          threadHasQueuedTurnStart(thread, now),
        needsInput: shell?.hasPendingApprovals === true || shell?.hasPendingUserInput === true,
        archived: thread.archivedAt !== null,
        model: provider ? { provider, model: thread.modelSelection.model } : null,
        turns: thread.messages.filter((message) => message.role === "user").length,
        excerpt: thread.messages
          .filter((message) => message.role !== "system")
          .slice(-6)
          .map((message) => `${message.role}: ${message.text}`)
          .join("\n")
          .slice(-4000),
      };
    }),
  };
}

export const syncLens = Effect.fn("lens.sync_desktop")(function* () {
  const session = yield* desktopCloudSession(false);
  if (!session.enabled || !session.relayUrl || !session.accessToken) return;
  const client = makeCloudClient({
    baseUrl: session.relayUrl,
    accessToken: async () => session.accessToken!,
  });
  const overview = yield* Effect.tryPromise(() => client.lens());
  // Scheduling controls model runs, not inventory freshness or approved cleanup.
  // Manual reviews also need this connected desktop, even when the schedule is off.
  const query = yield* ProjectionSnapshotQuery;
  const environment = yield* (yield* ServerEnvironment).getDescriptor;
  const sourceId = `local:${environment.environmentId}`;
  const now = DateTime.formatIso(yield* DateTime.now);
  const snapshot = yield* query.getSnapshot();
  const shells = yield* query.getShellSnapshot();
  const excluded = new Set<string>();
  for (const thread of snapshot.threads) {
    const owner = yield* readExecutionOwnership(thread.id);
    if (owner && owner.status !== "active") excluded.add(thread.id);
  }
  const inventory = localLensInventory(
    snapshot,
    shells.threads,
    sourceId,
    environment.label,
    now,
    excluded,
  );
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const config = yield* ServerConfig;
  const saved = yield* fs.readFileString(path.join(config.baseDir, "sidebar-state.json")).pipe(
    Effect.flatMap(
      Schema.decodeUnknownEffect(
        Schema.fromJsonString(
          Schema.Struct({ threadLastVisited: Schema.Record(Schema.String, Schema.String) }),
        ),
      ),
    ),
    Effect.catch(() => Effect.succeed({ threadLastVisited: {} as Record<string, string> })),
  );
  const validReadAt = (value: string | undefined) =>
    value &&
    Number.isFinite(Date.parse(value)) &&
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(value)
      ? value
      : null;
  const providers = yield* (yield* ProviderRegistry).getProviders;
  const models = providers
    .flatMap((entry) => {
      const provider =
        entry.driver === "codex"
          ? ("codex" as const)
          : entry.driver === "claudeAgent"
            ? ("claude" as const)
            : null;
      return provider ? entry.models.map((model) => ({ provider, model: model.slug })) : [];
    })
    .slice(0, 200);
  const withReads = {
    models,
    ...inventory,
    conversations: inventory.conversations.map((entry) => ({
      ...entry,
      readAt: validReadAt(saved.threadLastVisited[entry.id]),
    })),
  };
  const cloudReads = Object.entries(saved.threadLastVisited)
    .filter(([id, at]) => id.startsWith("cloud-") && validReadAt(at))
    .map(([id, through]) => ({ targetId: id.slice(6), through }));
  for (let offset = 0; offset < cloudReads.length; offset += 2000) {
    yield* Effect.tryPromise(() =>
      client.lensCommand({
        type: "read.batch",
        idempotencyKey: `read-batch:${sourceId}:${now}:${offset}`,
        sourceId: "cloud",
        entries: cloudReads.slice(offset, offset + 2000),
      }),
    );
  }
  const synced = yield* Effect.tryPromise(() =>
    client.lensCommand({
      type: "sync",
      idempotencyKey: `${sourceId}:${now}`,
      inventory: withReads,
    }),
  );
  const engine = yield* OrchestrationEngineService;
  for (const action of synced.recommendations.filter(
    (entry) => entry.sourceId === sourceId && entry.status === "approved",
  )) {
    const verification = emptyLens();
    verification.settings = overview.settings;
    verification.inventories[sourceId] = inventory;
    // The server has already verified unread status at approval. A new reply changes updatedAt.
    verification.inventories[sourceId] = {
      ...inventory,
      conversations: inventory.conversations.map((entry) => ({
        ...entry,
        readAt: entry.lastAssistantAt,
      })),
    };
    let status: "applied" | "stale" | "failed" = "stale";
    let error: string | null = "This item changed since approval. Run Lens again.";
    const alreadyApplied =
      action.kind === "archive_conversation"
        ? snapshot.threads.some(
            (thread) => thread.id === action.targetId && thread.archivedAt !== null,
          )
        : snapshot.projects.some(
            (project) => project.id === action.targetId && project.deletedAt !== null,
          );
    if (alreadyApplied) {
      status = "applied";
      error = null;
    } else if (
      lensActionStillValid(verification, action, DateTime.toEpochMillis(yield* DateTime.now))
    ) {
      const result = yield* engine
        .dispatch(
          action.kind === "archive_conversation"
            ? {
                type: "thread.archive",
                commandId: CommandId.make(`lens-${action.id}`),
                threadId: ThreadId.make(action.targetId),
                expectedUpdatedAt: action.targetUpdatedAt,
              }
            : {
                type: "project.delete",
                commandId: CommandId.make(`lens-${action.id}`),
                projectId: ProjectId.make(action.targetId),
                force: true,
                expectedUpdatedAt: action.targetUpdatedAt,
              },
        )
        .pipe(Effect.result);
      status = result._tag === "Success" ? "applied" : "failed";
      error =
        result._tag === "Success"
          ? null
          : "The project changed or the desktop could not finish this action. Review it before trying again.";
    }
    yield* Effect.tryPromise(() =>
      client.lensCommand({
        type: "action.result",
        idempotencyKey: `result:${action.id}`,
        recommendationId: action.id,
        status,
        error,
      }),
    );
  }
});

/** Cloud workers do not have desktop account credentials and never upload another source. */
export const startLensSync = Effect.gen(function* () {
  if (!(yield* Config.boolean("VITRE_CLOUD_DESKTOP_ENABLED").pipe(Config.withDefault(false))))
    return;
  yield* syncLens().pipe(
    Effect.catch(() =>
      Effect.logWarning("Lens desktop sync could not complete; it will retry in one minute."),
    ),
    Effect.repeat(Schedule.spaced("1 minute")),
    Effect.forkScoped,
  );
});
