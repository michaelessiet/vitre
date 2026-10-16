import type { CloudOverview, CloudTask } from "@t3tools/contracts/cloud";
import type { OrchestrationThread } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  acceptCloudHistory,
  acceptCloudOverview,
  cloudDiffSummary,
  cloudSendAccepted,
  cloudStopSettled,
  cloudTaskOwnership,
  cloudTurnBusy,
  type PendingCloudSend,
} from "./mobileCloudState";

const overview = (revision: number) => ({ revision, tasks: [] }) as unknown as CloudOverview;
const history = (updatedAt: string, text: string) =>
  ({
    updatedAt,
    messages: [{ role: "user", text, createdAt: updatedAt }],
  }) as unknown as OrchestrationThread;
const pending: PendingCloudSend = {
  accountId: "account-a",
  taskId: "task-a",
  idempotencyKey: "send-a",
  prompt: "Fix the bug",
  createdAt: "2026-10-16T10:00:00.000Z",
  disposition: "uncertain",
};

describe("Vitre Cloud mobile state", () => {
  it("keeps a newer command overview when an older poll arrives", () => {
    const current = overview(8);
    expect(acceptCloudOverview(current, overview(7))).toBe(current);
    expect(acceptCloudOverview(current, overview(8))).toBe(current);
    expect(acceptCloudOverview(current, overview(9)).revision).toBe(9);
  });

  it("keeps readable history during a missing or stale reconnect feed", () => {
    const current = history("2026-10-16T10:01:00.000Z", "new");
    expect(acceptCloudHistory(current, null)).toBe(current);
    expect(acceptCloudHistory(current, history("2026-10-16T10:00:00.000Z", "old"))).toBe(current);
  });

  it("reconciles a lost send response by request id or authoritative message", () => {
    const task = { turnRequestId: "send-a" } as CloudTask;
    expect(cloudSendAccepted(pending, task, null)).toBe(true);
    expect(
      cloudSendAccepted(pending, null, history("2026-10-16T10:01:00.000Z", pending.prompt)),
    ).toBe(true);
    expect(
      cloudSendAccepted(pending, null, history("2026-10-16T09:59:00.000Z", pending.prompt)),
    ).toBe(false);
  });

  it("does not treat an idle warm computer as an active turn", () => {
    const task = { state: "running", idle: true } as CloudTask;
    expect(cloudTurnBusy(task, null)).toBe(false);
    expect(cloudTurnBusy({ ...task, idle: false }, null)).toBe(true);
  });

  it("fences a visible task while its conversation moves or is owned locally", () => {
    const task = { id: "task-a", state: "completed" } as CloudTask;
    expect(cloudTaskOwnership(overview(1), task)).toBe("cloud");
    const binding = {
      conversationId: "conversation-a",
      cloudTaskId: "task-a",
      target: "cloud-github",
      generation: 2,
    };
    expect(
      cloudTaskOwnership(
        {
          ...overview(2),
          bindings: [binding],
          handoffs: [{ conversationId: "conversation-a", phase: "transferring" }],
        } as unknown as CloudOverview,
        task,
      ),
    ).toBe("moving");
    expect(
      cloudTaskOwnership(
        { ...overview(3), bindings: [{ ...binding, target: "local" }] } as unknown as CloudOverview,
        task,
      ),
    ).toBe("local");
    expect(
      cloudTaskOwnership(
        { ...overview(4), bindings: [binding] } as unknown as CloudOverview,
        { ...task, handoff: { conversationId: "conversation-a", generation: 2 } } as CloudTask,
      ),
    ).toBe("recovering");
  });

  it("keeps Stop pending after acknowledgement until the captured worker stops", () => {
    const acknowledged = {
      state: "cancelled",
      turnRequestId: "turn-a",
      worker: { state: "ready" },
    } as CloudTask;
    expect(cloudStopSettled(acknowledged, "turn-a")).toBe(false);
    expect(
      cloudStopSettled(
        { ...acknowledged, worker: { ...acknowledged.worker!, state: "stopped" } },
        "turn-a",
      ),
    ).toBe(true);
    expect(cloudStopSettled({ ...acknowledged, turnRequestId: "turn-b" }, "turn-a")).toBe(true);
  });

  it("counts changed files and lines without diff header lines", () => {
    expect(
      cloudDiffSummary(
        "diff --git a/a b/a\n--- a/a\n+++ b/a\n+one\n-two\ndiff --git a/b b/b\n+two",
      ),
    ).toEqual({ files: 2, added: 2, removed: 1 });
  });
});
