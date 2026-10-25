import { expect, it } from "vite-plus/test";
import {
  EventId,
  MessageId,
  TurnId,
  type OrchestrationThread,
  type OrchestrationThreadActivity,
} from "@t3tools/contracts";
import type { CloudTask } from "@t3tools/contracts/cloud";
import { pendingRequests } from "./cloudState";
import { makeShowcaseClient } from "./showcase";

const oldTurn = TurnId.make("old-turn");
const currentTurn = TurnId.make("current-turn");
const requestedAt = "2026-10-25T13:45:49.827Z";
const currentAt = "2026-10-25T13:45:51.000Z";
const oldAt = "2026-10-25T09:56:11.968Z";
type ThreadFixture = { -readonly [Key in keyof OrchestrationThread]: OrchestrationThread[Key] };

function activity(
  requestId: string,
  overrides: Partial<OrchestrationThreadActivity> = {},
): OrchestrationThreadActivity {
  return {
    id: EventId.make(`${requestId}-requested`),
    kind: "approval.requested",
    summary: "Command approval requested",
    tone: "approval",
    turnId: currentTurn,
    createdAt: currentAt,
    payload: { requestId, requestKind: "command", detail: "git branch --list main" },
    ...overrides,
  };
}

async function fixture() {
  const client = makeShowcaseClient();
  const original = (await client.events("session")).conversation as OrchestrationThread;
  const thread: ThreadFixture = {
    ...original,
    updatedAt: currentAt,
    messages: [],
    activities: [],
    latestTurn: {
      turnId: currentTurn,
      state: "running",
      requestedAt,
      startedAt: requestedAt,
      completedAt: null,
      assistantMessageId: null,
    },
  };
  const task: CloudTask = { ...(await client.overview()).tasks[0]!, state: "running", idle: false };
  return { thread, task };
}

it("does not revive the observed abandoned approvals when a later turn becomes busy", async () => {
  const { thread, task } = await fixture();
  thread.activities = [
    activity("expired-first", { turnId: oldTurn, createdAt: oldAt }),
    activity("expired-second", { turnId: oldTurn, createdAt: "2026-10-25T10:11:15.603Z" }),
    activity("expired-first", {
      id: EventId.make("old-response-failed"),
      kind: "provider.approval.respond.failed",
      turnId: null,
      createdAt: "2026-10-25T13:45:32.837Z",
      payload: {
        requestId: "expired-first",
        detail: "No active provider session is bound to this thread.",
      },
    }),
  ];
  expect(pendingRequests(thread, task)).toEqual([]);
  thread.activities = [...thread.activities, activity("current-approval")];
  expect(pendingRequests(thread, task).map((request) => request.id)).toEqual(["current-approval"]);
});

it.each(["completed", "interrupted", "error"] as const)(
  "does not present an unclosed approval from a %s latest turn",
  async (state) => {
    const { thread, task } = await fixture();
    thread.latestTurn = { ...thread.latestTurn!, state, completedAt: currentAt };
    thread.activities = [activity("unclosed")];
    expect(pendingRequests(thread, task)).toEqual([]);
  },
);

it("requires active cloud work even when the cached thread still says running", async () => {
  const { thread, task } = await fixture();
  thread.activities = [activity("cached")];
  expect(pendingRequests(thread, { ...task, idle: true })).toEqual([]);
  expect(pendingRequests(thread, { ...task, state: "cancelled" })).toEqual([]);
});

it("uses requestedAt for untagged requests and turn identity for tagged requests", async () => {
  const { thread } = await fixture();
  thread.activities = [
    activity("legacy-old", { turnId: null, createdAt: oldAt }),
    activity("late-old", { turnId: oldTurn, createdAt: currentAt }),
    activity("legacy-current", { turnId: null, createdAt: requestedAt }),
    activity("current"),
  ];
  expect(pendingRequests(thread).map((request) => request.id)).toEqual([
    "legacy-current",
    "current",
  ]);
});

it("applies an untagged resolution by request ID even before the current requestedAt", async () => {
  const { thread } = await fixture();
  thread.activities = [
    activity("resolved", {
      id: EventId.make("resolution-with-older-clock"),
      kind: "approval.resolved",
      turnId: null,
      createdAt: oldAt,
    }),
    activity("resolved"),
  ];
  expect(pendingRequests(thread)).toEqual([]);
});

it.each(["accept", "decline"] as const)(
  "keeps %s terminal despite reordered and replayed request activities",
  async (decision) => {
    const { thread } = await fixture();
    const requested = activity("answered", { sequence: 10 });
    const resolved = activity("answered", {
      id: EventId.make("resolved"),
      kind: "approval.resolved",
      sequence: 11,
      payload: { requestId: "answered", decision },
    });
    const replayed = { ...requested, id: EventId.make("replayed"), sequence: 12 };
    for (const activities of [
      [resolved, requested, replayed],
      [requested, resolved, replayed],
    ]) {
      expect(pendingRequests({ ...thread, activities })).toEqual([]);
    }
    expect(
      pendingRequests({ ...thread, activities: [resolved, replayed, activity("new-request")] }).map(
        (request) => request.id,
      ),
    ).toEqual(["new-request"]);
  },
);

it("clears recognized stale approval failures while retaining transient response failures", async () => {
  const { thread } = await fixture();
  for (const detail of [
    "Stale pending approval request: permission",
    "Unknown pending approval request: permission",
    "UNKNOWN PENDING PERMISSION REQUEST: permission",
  ]) {
    const failed = activity("permission", {
      id: EventId.make("failed"),
      kind: "provider.approval.respond.failed",
      turnId: null,
      payload: { requestId: "permission", detail },
    });
    expect(pendingRequests({ ...thread, activities: [failed, activity("permission")] })).toEqual(
      [],
    );
  }
  for (const detail of ["Connection reset while responding", "Provider temporarily unavailable"]) {
    const failed = activity("permission", {
      id: EventId.make("transient"),
      kind: "provider.approval.respond.failed",
      payload: { requestId: "permission", detail },
    });
    expect(
      pendingRequests({ ...thread, activities: [activity("permission"), failed] }).map(
        (request) => request.id,
      ),
    ).toEqual(["permission"]);
  }
});

it("applies the same turn and terminal rules to questions", async () => {
  const { thread } = await fixture();
  const question = activity("question", {
    kind: "user-input.requested",
    payload: { requestId: "question", questions: [{ id: "choice", question: "Which target?" }] },
  });
  const old = { ...question, id: EventId.make("old-question"), turnId: oldTurn };
  expect(pendingRequests({ ...thread, activities: [old, question] })).toMatchObject([
    { id: "question", kind: "question", questions: [{ id: "choice", question: "Which target?" }] },
  ]);
  for (const detail of [
    "Stale pending user-input request",
    "Unknown pending user-input request",
    "Unknown pending user input request",
    "Unknown pending codex user input request",
  ]) {
    const stale = activity("question", {
      kind: "provider.user-input.respond.failed",
      payload: { requestId: "question", detail },
    });
    expect(pendingRequests({ ...thread, activities: [stale, question] })).toEqual([]);
  }
  const resolved = activity("question", {
    kind: "user-input.resolved",
    turnId: null,
    createdAt: oldAt,
  });
  expect(pendingRequests({ ...thread, activities: [resolved, question] })).toEqual([]);
});

it("keeps old import markers and does not let imported resolutions close a live request", async () => {
  const { thread } = await fixture();
  const imported = activity("historical");
  const historicalResolution = activity("reused", {
    id: EventId.make("historical-resolution"),
    kind: "approval.resolved",
  });
  const marker = activity("import", {
    kind: "thread.history.imported",
    turnId: oldTurn,
    createdAt: oldAt,
    payload: { historicalActivityIds: [imported.id, historicalResolution.id] },
  });
  thread.activities = [imported, activity("reused"), historicalResolution, marker];
  expect(pendingRequests(thread).map((request) => request.id)).toEqual(["reused"]);
});

it("waits for a queued follow-up message to be adopted before showing its approvals", async () => {
  const { thread, task } = await fixture();
  const followUp = { ...task, turnRequestId: "follow-up" };
  thread.activities = [activity("old-active-request")];
  for (const state of ["queued", "preparing", "running"] as const) {
    expect(pendingRequests(thread, { ...followUp, state })).toEqual([]);
  }
  const messageAt = "2026-10-25T14:00:00.000Z";
  thread.messages = [
    {
      id: MessageId.make("follow-up-message"),
      role: "user",
      text: "Next task",
      createdAt: messageAt,
      updatedAt: messageAt,
      turnId: null,
      streaming: false,
    },
  ];
  expect(pendingRequests(thread, followUp)).toEqual([]);
  const nextTurn = TurnId.make("follow-up-turn");
  thread.latestTurn = {
    ...thread.latestTurn!,
    turnId: nextTurn,
    requestedAt: messageAt,
    startedAt: messageAt,
  };
  thread.activities = [
    ...thread.activities,
    activity("follow-up-approval", { turnId: nextTurn, createdAt: messageAt }),
  ];
  expect(pendingRequests(thread, followUp).map((request) => request.id)).toEqual([
    "follow-up-approval",
  ]);
  thread.messages = [
    { ...thread.messages[0]!, turnId: nextTurn, createdAt: "2026-10-25T14:01:00.000Z" },
  ];
  expect(pendingRequests(thread, followUp).map((request) => request.id)).toEqual([
    "follow-up-approval",
  ]);
});

it("retains a legitimate current approval even when Full Access is selected", async () => {
  const { thread, task } = await fixture();
  thread.activities = [activity("still-requires-a-response")];
  expect(
    pendingRequests(
      { ...thread, runtimeMode: "full-access" },
      { ...task, runtimeMode: "full-access" },
    ),
  ).toMatchObject([
    {
      id: "still-requires-a-response",
      approval: { label: "Command", detail: "git branch --list main" },
    },
  ]);
});
