import { expect, it } from "vite-plus/test";
import { makeShowcaseClient } from "./showcase";
import {
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
