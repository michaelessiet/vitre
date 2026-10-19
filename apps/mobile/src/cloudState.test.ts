import { expect, it } from "vite-plus/test";
import { makeShowcaseClient } from "./showcase";
import {
  approvalDetails,
  taskProgress,
  acceptHistory,
  acceptOverview,
  cloudOwned,
  diffFiles,
  pendingRequests,
} from "./cloudState";
import { EventId, type OrchestrationThread } from "@t3tools/contracts";

it("keeps newer cloud state when a cached or delayed response arrives", async () => {
  const client = makeShowcaseClient();
  const overview = await client.overview();
  const newer = { ...overview, revision: 10 };
  expect(acceptOverview(newer, overview)).toBe(newer);
  const thread = (await client.events("session")).conversation as OrchestrationThread;
  const current = { ...thread, updatedAt: "2026-10-20T00:00:00Z" };
  expect(acceptHistory(current, { ...thread, updatedAt: "2026-10-19T00:00:00Z" })).toBe(current);
  expect(cloudOwned(overview, overview.tasks[0]!)).toBe(true);
  expect(
    cloudOwned(overview, {
      ...overview.tasks[0]!,
      handoff: {
        operationId: "handoff",
        conversationId: "conversation",
        generation: 0,
        history: { sha256: "a".repeat(64), sizeBytes: 1, chunks: ["b".repeat(64)] },
      },
    }),
  ).toBe(false);
});

it("removes resolved input requests and groups unified diff files", async () => {
  const thread = (await makeShowcaseClient().events("session")).conversation as OrchestrationThread;
  const activity = thread.activities[0]!;
  const requested = {
    ...activity,
    id: EventId.make("request"),
    kind: "approval.requested",
    payload: { requestId: "permission" },
  };
  expect(pendingRequests({ ...thread, activities: [requested] })).toHaveLength(1);
  expect(
    pendingRequests({
      ...thread,
      activities: [
        requested,
        { ...requested, id: EventId.make("resolved"), kind: "approval.resolved" },
      ],
    }),
  ).toHaveLength(0);
  expect(
    diffFiles("diff --git a/a.ts b/a.ts\n--- a/a.ts\n+++ b/a.ts\n@@ -1 +1 @@\n-old\n+new\n"),
  ).toMatchObject([{ name: "a.ts", additions: 1, deletions: 1 }]);
});

it("does not show a previous preparation failure while retrying", async () => {
  const task = (await makeShowcaseClient().overview()).tasks[0]!;
  const events = [
    {
      cursor: 1,
      attemptId: "old",
      sequence: 1,
      phase: "failed",
      detail: "GitHub unavailable",
      createdAt: "",
    },
  ];
  expect(
    taskProgress(events, {
      ...task,
      state: "preparing",
      attempt: {
        id: "new",
        generation: 2,
        startedAt: "",
        deadlineAt: "",
        heartbeatAt: "",
        lastSequence: 0,
        reservedMicroDollars: 0,
        billedThrough: "",
      },
    }),
  ).toBe("");
  expect(
    taskProgress(events, {
      ...task,
      state: "queued",
      attempt: {
        id: "old",
        generation: 1,
        startedAt: "",
        deadlineAt: "",
        heartbeatAt: "",
        lastSequence: 1,
        reservedMicroDollars: 0,
        billedThrough: "",
      },
    }),
  ).toBe("");
  expect(
    taskProgress(events, {
      ...task,
      state: "failed",
      attempt: {
        id: "old",
        generation: 1,
        startedAt: "",
        deadlineAt: "",
        heartbeatAt: "",
        lastSequence: 1,
        reservedMicroDollars: 0,
        billedThrough: "",
      },
    }),
  ).toBe("GitHub unavailable");
});

it("preserves complete approval details in pending mobile requests", async () => {
  const thread = (await makeShowcaseClient().events("session")).conversation as OrchestrationThread;
  const detail = '/bin/bash -lc "pwd && cat README.md"\necho "finished"';
  const requests = pendingRequests({
    ...thread,
    activities: [
      {
        ...thread.activities[0]!,
        id: EventId.make("command-request"),
        kind: "approval.requested",
        payload: { requestId: "permission", requestKind: "command", detail },
      },
    ],
  });
  expect(requests[0]).toMatchObject({
    id: "permission",
    kind: "approval",
    approval: { label: "Command", detail },
  });
});

it("labels approval kinds and handles missing or malformed provider details", () => {
  for (const [requestKind, requestType, label] of [
    ["command", "command_execution_approval", "Command"],
    ["file-read", "file_read_approval", "File to read"],
    ["file-change", "file_change_approval", "File change"],
  ]) {
    expect(approvalDetails({ requestKind, detail: "provided detail" })).toEqual({
      label,
      detail: "provided detail",
    });
    expect(approvalDetails({ requestType })).toEqual({ label, detail: null });
  }
  for (const detail of [undefined, null, "", "  ", {}, 42]) {
    expect(approvalDetails({ detail })).toEqual({ label: "Requested action", detail: null });
  }
});
