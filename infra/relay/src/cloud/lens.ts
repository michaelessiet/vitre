// @effect-diagnostics globalDate:off - Reducers receive an explicit clock.
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import type {
  LensCommand,
  LensConversation,
  LensInventory,
  LensModelReply,
} from "@t3tools/contracts/lens";
import { OrchestrationThread } from "@t3tools/contracts";
import {
  beginLensRun,
  emptyLens,
  finishLensRun,
  lensActionStillValid,
  lensOverview,
  markLensRead,
  nextLensRun,
} from "@t3tools/shared/lens";
import { CloudConfiguration } from "./config.ts";
import { CloudStore } from "./store.ts";
import { applyCommand, type CloudState } from "./state.ts";
import { backfillProjects, projectIdentity } from "./projects.ts";
import { reserveJob } from "./jobs.ts";
import { CloudError, iso } from "./policy.ts";
import { currentMillis, fromPromise } from "./service.ts";
import { sha256 } from "./crypto.ts";

const connected = (state: CloudState) =>
  Object.values(state.accounts)
    .filter((entry) => entry.state === "connected")
    .map((entry) => entry.provider);
const decodeThread = Schema.decodeUnknownOption(OrchestrationThread);

export function rememberLensConversation(state: CloudState, taskId: string, value: unknown): void {
  const decoded = decodeThread(value);
  const task = state.tasks[taskId];
  if (decoded._tag !== "Some" || !task) return;
  const thread = decoded.value;
  const messages = thread.messages.filter(
    (entry) => entry.role === "user" || entry.role === "assistant",
  );
  const assistant = messages.findLast((entry) => entry.role === "assistant" && !entry.streaming);
  (state.lensConversations ??= {})[taskId] = {
    id: taskId,
    projectId: projectIdentity(task),
    title: task.title ?? thread.title,
    updatedAt: thread.updatedAt,
    lastAssistantAt: assistant?.createdAt ?? null,
    readAt: null,
    busy: false,
    needsInput: false,
    archived: !!task.archivedAt,
    model: task.model ? { provider: task.provider, model: task.model } : null,
    turns: messages.filter((entry) => entry.role === "user").length,
    excerpt: messages
      .slice(-6)
      .map((entry) => `${entry.role}: ${entry.text}`)
      .join("\n")
      .slice(-4000),
  };
}

export function refreshLensInventory(state: CloudState, now: number): void {
  const lens = (state.lens ??= emptyLens());
  backfillProjects(state);
  const tasks = Object.values(state.tasks).filter(
    (entry) => !state.deletedTasks.includes(entry.id),
  );
  const conversations: LensConversation[] = tasks.map((task) => {
    const summary = state.lensConversations?.[task.id];
    return {
      id: task.id,
      projectId: projectIdentity(task),
      title: task.title ?? task.prompt.slice(0, 100),
      updatedAt: summary?.updatedAt ?? task.updatedAt,
      lastAssistantAt: summary?.lastAssistantAt ?? task.result?.createdAt ?? null,
      readAt: null,
      busy:
        task.state === "queued" ||
        task.state === "preparing" ||
        (task.state === "running" && task.idle !== true),
      needsInput: task.state === "waiting_for_input",
      archived: !!task.archivedAt,
      model: task.model ? { provider: task.provider, model: task.model } : null,
      turns: summary?.turns ?? 1,
      excerpt: summary?.excerpt ?? `${task.prompt}\n${task.result?.summary ?? ""}`.slice(-4000),
    };
  });
  lens.inventories.cloud = {
    sourceId: "cloud",
    sourceLabel: "Cloud",
    collectedAt: iso(now),
    conversations,
    projects: Object.values(state.projects ?? {})
      .filter((project) => !state.deletedProjects?.includes(project.id))
      .map((project) => ({
        id: project.id,
        title: project.title,
        updatedAt: conversations
          .filter((entry) => entry.projectId === project.id)
          .reduce(
            (at, entry) => (entry.updatedAt > at ? entry.updatedAt : at),
            project.latestSnapshot?.savedAt ??
              tasks
                .filter((task) => projectIdentity(task) === project.id)
                .map((task) => task.createdAt)
                .sort()[0] ??
              iso(now),
          ),
      })),
  };
}

function queueRun(state: CloudState, id: string, message: string | null, now: number): void {
  const next = structuredClone(state.lens ?? emptyLens());
  const run = beginLensRun(next, id, message, now, connected(state));
  reserveJob(state, id, "lens", now, null, run.model.provider);
  next.revision++;
  state.lens = next;
}

export function tickLens(state: CloudState, now: number, id: string, enabled: boolean): void {
  if (!state.lens) return;
  refreshLensInventory(state, now);
  const run = state.lens.run;
  if (run && state.jobs?.[run.id]?.state === "failed") {
    finishLensRun(
      state.lens,
      run.id,
      null,
      state.jobs[run.id]!.error ?? "Lens could not complete this review.",
      now,
    );
    state.lens.revision++;
  }
  if (
    !enabled ||
    !state.lens.settings.enabled ||
    state.lens.run ||
    !state.lens.nextRunAt ||
    Date.parse(state.lens.nextRunAt) > now
  )
    return;
  try {
    queueRun(state, id, null, now);
  } catch (error) {
    state.lens.error =
      error instanceof Error ? error.message : "Lens could not start. Check your AI account.";
  }
}

export function applyLensCommand(
  state: CloudState,
  command: LensCommand,
  now: number,
  runId: string,
  enabled: boolean,
  fingerprint: string,
): void {
  refreshLensInventory(state, now);
  let lens = state.lens!;
  const receipt = lens.receipts[command.idempotencyKey];
  if (receipt) {
    if (receipt !== fingerprint)
      throw new CloudError("idempotency_conflict", "This request ID was already used.");
    return;
  }
  switch (command.type) {
    case "settings.update":
      if (command.expectedRevision !== (lens.settingsRevision ?? 0))
        throw new CloudError(
          "revision_conflict",
          "Lens settings changed on another device. Refresh and try again.",
        );
      try {
        const next = nextLensRun(command.settings.schedule, now);
        lens.settings = command.settings;
        lens.settingsRevision = (lens.settingsRevision ?? 0) + 1;
        lens.nextRunAt = command.settings.enabled ? next : null;
        lens.error = null;
      } catch {
        throw new CloudError(
          "invalid_schedule",
          "Choose a valid IANA time zone, such as Africa/Lagos.",
          400,
        );
      }
      break;
    case "sweep":
    case "chat":
      if (!enabled) throw new CloudError("disabled", "Cloud execution is disabled.", 503);
      try {
        queueRun(state, runId, command.type === "chat" ? command.message.trim() : null, now);
      } catch (error) {
        throw error instanceof CloudError
          ? error
          : new CloudError(
              "lens_unavailable",
              error instanceof Error ? error.message : "Lens is unavailable.",
            );
      }
      lens = state.lens!;
      break;
    case "read.batch":
      for (const entry of command.entries)
        markLensRead(lens, command.sourceId, entry.targetId, entry.through, now);
      break;
    case "read":
      markLensRead(lens, command.sourceId, command.targetId, command.through, now);
      lens.recommendations = lens.recommendations.map((entry) =>
        entry.sourceId === command.sourceId &&
        entry.targetId === command.targetId &&
        entry.kind === "unread" &&
        entry.status === "pending" &&
        !lensActionStillValid(lens, entry, now)
          ? { ...entry, status: "applied" }
          : entry,
      );
      break;
    case "sync": {
      const inventory: LensInventory = command.inventory;
      if (inventory.sourceId === "cloud" || !inventory.sourceId.startsWith("local:"))
        throw new CloudError("invalid_source", "Only a desktop inventory can be uploaded.", 400);
      if (
        inventory.sourceId.length > 256 ||
        inventory.projects.some((entry) => entry.id.length > 256) ||
        inventory.conversations.some(
          (entry) => entry.id.length > 256 || entry.projectId.length > 256,
        )
      )
        throw new CloudError("invalid_source", "Inventory identifiers are too long.", 400);
      const previous = lens.inventories[inventory.sourceId];
      if (!previous && Object.keys(lens.inventories).length >= 16)
        throw new CloudError("source_limit", "Lens supports up to 15 desktop sources.", 400);
      if (
        !Number.isFinite(Date.parse(inventory.collectedAt)) ||
        Date.parse(inventory.collectedAt) > now + 60_000
      )
        throw new CloudError("invalid_source", "Invalid inventory time.", 400);
      if (!previous || inventory.collectedAt > previous.collectedAt)
        lens.inventories[inventory.sourceId] = inventory;
      break;
    }
    case "decide": {
      const index = lens.recommendations.findIndex(
        (entry) => entry.id === command.recommendationId,
      );
      const action = lens.recommendations[index];
      if (!action) throw new CloudError("not_found", "Recommendation not found.", 404);
      if (action.status !== "pending") break;
      if (command.decision === "dismiss") {
        lens.recommendations[index] = { ...action, status: "dismissed" };
        break;
      }
      if (action.kind !== "archive_conversation" && action.kind !== "remove_project")
        throw new CloudError("invalid_action", "Open this conversation to read or reply.", 400);
      if (!lensActionStillValid(lens, action, now)) {
        lens.recommendations[index] = {
          ...action,
          status: "stale",
          error: "This item changed since the review. Run Lens again.",
        };
        break;
      }
      if (action.sourceId === "cloud") {
        const cloudCommand =
          action.kind === "archive_conversation"
            ? {
                type: "task.update" as const,
                idempotencyKey: `lens-${command.idempotencyKey}`,
                taskId: action.targetId,
                archived: true,
              }
            : {
                type: "project.delete" as const,
                idempotencyKey: `lens-${command.idempotencyKey}`,
                projectId: action.targetId,
                expectedRevision: state.projects![action.targetId]!.revision,
              };
        applyCommand(state, cloudCommand, command.idempotencyKey, fingerprint, now, true);
        lens.recommendations[index] = { ...action, status: "applied" };
      } else lens.recommendations[index] = { ...action, status: "approved" };
      break;
    }
    case "action.result": {
      const index = lens.recommendations.findIndex(
        (entry) => entry.id === command.recommendationId,
      );
      const action = lens.recommendations[index];
      if (!action || action.sourceId === "cloud" || action.status !== "approved")
        throw new CloudError("invalid_action", "No approved desktop action is waiting.");
      lens.recommendations[index] = { ...action, status: command.status, error: command.error };
      break;
    }
  }
  if (["sync", "read", "read.batch"].includes(command.type)) {
    lens.recommendations = lens.recommendations.map((entry) =>
      entry.kind === "unread" &&
      entry.status === "pending" &&
      !lensActionStillValid(lens, entry, now)
        ? { ...entry, status: "applied" }
        : entry,
    );
  }
  lens.revision++;
  // Bound idempotency metadata without retaining uploaded conversation text in receipts.
  lens.receipts[command.idempotencyKey] = fingerprint;
  const keys = Object.keys(lens.receipts);
  for (const key of keys.slice(0, Math.max(0, keys.length - 64))) delete lens.receipts[key];
}

export function completeLens(
  state: CloudState,
  id: string,
  reply: LensModelReply | null,
  now: number,
): void {
  if (!state.lens) return;
  finishLensRun(
    state.lens,
    id,
    reply,
    reply ? null : "Lens could not finish this review. Check your model and try again.",
    now,
  );
  state.lens.revision++;
}

export const make = Effect.gen(function* () {
  const config = yield* CloudConfiguration;
  const store = yield* CloudStore;
  const crypto = yield* Crypto.Crypto;
  const own = (userId: string) =>
    userId && userId === config.allowedUserId
      ? Effect.void
      : Effect.fail(new CloudError("forbidden", "Account cannot access Lens.", 403));
  return {
    overview: Effect.fn("lens.overview")(function* (userId: string) {
      yield* own(userId);
      const now = yield* currentMillis;
      const document = yield* store.read(userId);
      refreshLensInventory(document.state, now);
      return lensOverview(document.state.lens!, now, connected(document.state));
    }),
    command: Effect.fn("lens.command")(function* (userId: string, command: LensCommand) {
      yield* own(userId);
      const now = yield* currentMillis;
      const id = `lens-${yield* crypto.randomUUIDv4.pipe(Effect.orDie)}`;
      const fingerprint = yield* fromPromise(() => sha256(JSON.stringify(command)));
      const result = yield* store.mutate(userId, (document) => {
        applyLensCommand(
          document.state,
          command,
          now,
          id,
          config.enabled && !!config.machine,
          fingerprint,
        );
        return lensOverview(document.state.lens!, now, connected(document.state));
      });
      yield* config.wake(userId).pipe(Effect.ignore);
      return result;
    }),
  };
});
export class CloudLens extends Context.Service<CloudLens, Effect.Success<typeof make>>()(
  "t3code-relay/cloud/lens/CloudLens",
) {}
export const layer = Layer.effect(CloudLens, make);
