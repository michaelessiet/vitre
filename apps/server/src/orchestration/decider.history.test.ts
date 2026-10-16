import {
  CommandId,
  MessageId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type OrchestrationReadModel,
  type OrchestrationSession,
  type OrchestrationThread,
} from "@t3tools/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import { decideOrchestrationCommand } from "./decider.ts";

const NOW = "2026-01-01T00:00:00.000Z";
const SETTLED_AT = "2025-12-30T00:00:00.000Z";

function makeReadModel(
  settledOverride: OrchestrationThread["settledOverride"],
  archivedAt: string | null = null,
  session: OrchestrationSession | null = null,
  activities: OrchestrationThread["activities"] = [],
  messages: OrchestrationThread["messages"] = [],
): OrchestrationReadModel {
  return {
    snapshotSequence: 0,
    projects: [],
    threads: [
      {
        id: ThreadId.make("thread-1"),
        projectId: ProjectId.make("project-1"),
        title: "Thread",
        additionalRoots: [],
        modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4" },
        runtimeMode: "full-access",
        interactionMode: "default",
        branch: null,
        worktreePath: null,
        latestTurn: null,
        createdAt: NOW,
        updatedAt: NOW,
        archivedAt,
        settledOverride,
        settledAt: settledOverride === "settled" ? SETTLED_AT : null,
        deletedAt: null,
        messages,
        proposedPlans: [],
        activities,
        checkpoints: [],
        session,
      },
    ],
    updatedAt: NOW,
  };
}

function makeSession(status: OrchestrationSession["status"]): OrchestrationSession {
  return {
    threadId: ThreadId.make("thread-1"),
    status,
    providerName: "Codex",
    runtimeMode: "full-access",
    activeTurnId: null,
    lastError: null,
    updatedAt: NOW,
  };
}

it.layer(NodeServices.layer)("cloud conversation import", (it) => {
  it.effect("imports messages without replaying agent turns", () =>
    Effect.gen(function* () {
      const result = yield* decideOrchestrationCommand({
        readModel: makeReadModel(null),
        command: {
          type: "thread.history.import",
          commandId: CommandId.make("transfer"),
          threadId: ThreadId.make("thread-1"),
          createdAt: NOW,
          messages: [
            {
              id: MessageId.make("user-1"),
              role: "user",
              text: "existing request",
              streaming: false,
              turnId: null,
              createdAt: NOW,
              updatedAt: NOW,
            },
          ],
          proposedPlans: [],
        },
      });
      const events = Array.isArray(result) ? result : [result];
      expect(events.map((event) => event.type)).toEqual([
        "thread.message-sent",
        "thread.activity-appended",
      ]);
      expect(events[0]?.payload).toMatchObject({
        messageId: "user-1",
        role: "user",
        text: "existing request",
        streaming: false,
      });
    }),
  );
  it.effect("rejects importing into a running conversation", () =>
    Effect.gen(function* () {
      const error = yield* decideOrchestrationCommand({
        readModel: makeReadModel(null, null, makeSession("running")),
        command: {
          type: "thread.history.import",
          commandId: CommandId.make("transfer"),
          threadId: ThreadId.make("thread-1"),
          createdAt: NOW,
          messages: [],
          proposedPlans: [],
        },
      }).pipe(Effect.flip);
      expect(error.message).toContain("active turn");
    }),
  );
});
