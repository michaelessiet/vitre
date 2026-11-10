/**
 * Summarizes running subagents on each provider's small text model and
 * appends the result as a `task.summary` activity.
 *
 * The provider's own progress summaries would run on the subagent's model;
 * these run on the inexpensive model Vitre already uses for commit messages
 * and titles (Haiku for Claude, the luna model for Codex), so a long-running
 * agent costs little to watch.
 */
import {
  CommandId,
  DEFAULT_GIT_TEXT_GENERATION_MODEL_BY_PROVIDER,
  EventId,
  type ModelSelection,
  type OrchestrationEvent,
  ThreadId,
} from "@t3tools/contracts";
import { makeDrainableWorker } from "@t3tools/shared/DrainableWorker";
import * as Cause from "effect/Cause";
import * as Clock from "effect/Clock";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";

import { ServerConfig } from "../../config.ts";
import { ProviderInstanceRegistry } from "../../provider/Services/ProviderInstanceRegistry.ts";
import { ServerSettingsService } from "../../serverSettings.ts";
import { TextGeneration } from "../../textGeneration/TextGeneration.ts";
import { OrchestrationEngineService } from "../Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../Services/ProjectionSnapshotQuery.ts";
import {
  SubagentSummaryReactor,
  type SubagentSummaryReactorShape,
} from "../Services/SubagentSummaryReactor.ts";
import { type SubagentSummaryRequest, SubagentSummaryTracker } from "../subagentSummaries.ts";

type ActivityAppendedEvent = Extract<OrchestrationEvent, { type: "thread.activity-appended" }>;

const make = Effect.gen(function* () {
  const orchestrationEngine = yield* OrchestrationEngineService;
  const projectionSnapshotQuery = yield* ProjectionSnapshotQuery;
  const textGeneration = yield* TextGeneration;
  const instances = yield* ProviderInstanceRegistry;
  const serverSettings = yield* ServerSettingsService;
  const serverConfig = yield* ServerConfig;
  const crypto = yield* Crypto.Crypto;
  const tracker = new SubagentSummaryTracker();

  /** The thread's own provider, on its small model; else the configured text model. */
  const summaryModelFor = Effect.fn("summaryModelFor")(function* (
    selection: ModelSelection | undefined,
  ) {
    if (selection) {
      const instance = yield* instances.getInstance(selection.instanceId);
      const model = instance
        ? DEFAULT_GIT_TEXT_GENERATION_MODEL_BY_PROVIDER[instance.driverKind]
        : undefined;
      if (model) return { instanceId: selection.instanceId, model } satisfies ModelSelection;
    }
    return (yield* serverSettings.getSettings).textGenerationModelSelection;
  });

  const summarize = Effect.fn("summarize")(function* (request: SubagentSummaryRequest) {
    const threadId = ThreadId.make(request.threadId);
    const thread = yield* projectionSnapshotQuery
      .getThreadDetailById(threadId)
      .pipe(Effect.map(Option.getOrUndefined));
    if (!thread) return;
    const modelSelection = yield* summaryModelFor(thread.modelSelection);
    const { summary } = yield* textGeneration.generateSubagentSummary({
      cwd: thread.worktreePath ?? serverConfig.stateDir,
      task: request.task,
      transcript: request.transcript,
      modelSelection,
    });
    if (!summary || !tracker.settle(request.threadId, request.taskId)) return;
    const createdAt = DateTime.formatIso(yield* DateTime.now);
    yield* orchestrationEngine.dispatch({
      type: "thread.activity.append",
      commandId: CommandId.make(`server:subagent-summary:${yield* crypto.randomUUIDv4}`),
      threadId,
      activity: {
        id: EventId.make(yield* crypto.randomUUIDv4),
        tone: "info",
        kind: "task.summary",
        summary,
        payload: { ...request.identity, summary, model: modelSelection.model },
        turnId: null,
        createdAt,
      },
      createdAt,
    });
  });

  // Summaries in flight belong to the reactor and end with it.
  const scope = yield* Effect.scope;
  const observe = (event: ActivityAppendedEvent) =>
    Effect.gen(function* () {
      const now = yield* Clock.currentTimeMillis;
      const request = tracker.observe(event.payload.threadId, event.payload.activity, now);
      if (!request) return;
      // Generation takes seconds; never hold up the next activity for it.
      yield* summarize(request).pipe(
        Effect.catchCause((cause) =>
          Effect.sync(() => tracker.settle(request.threadId, request.taskId)).pipe(
            Effect.andThen(
              Cause.hasInterruptsOnly(cause)
                ? Effect.void
                : Effect.logDebug("subagent summary skipped", {
                    threadId: request.threadId,
                    taskId: request.taskId,
                    cause: Cause.pretty(cause),
                  }),
            ),
          ),
        ),
        Effect.forkIn(scope),
      );
    });
  const worker = yield* makeDrainableWorker(observe);

  const start: SubagentSummaryReactorShape["start"] = Effect.fn("start")(function* () {
    yield* Effect.forkScoped(
      Stream.runForEach(orchestrationEngine.streamDomainEvents, (event) =>
        event.type === "thread.activity-appended" && event.payload.activity.kind.startsWith("task.")
          ? worker.enqueue(event)
          : Effect.void,
      ),
    );
  });

  return {
    start,
    drain: worker.drain,
  } satisfies SubagentSummaryReactorShape;
});

export const SubagentSummaryReactorLive = Layer.effect(SubagentSummaryReactor, make);
