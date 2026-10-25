import {
  EventId,
  MessageId,
  ThreadId,
  TurnId,
  type OrchestrationThread,
  type OrchestrationThreadActivity,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";
import { acceptHistory, pendingRequests } from "./cloudState";
import { makeShowcaseClient } from "./showcase";

const earlier = "2026-10-25T12:00:00.000Z";
const later = "2026-10-25T12:01:00.000Z";

async function history(overrides: Partial<OrchestrationThread> = {}) {
  const sample = (await makeShowcaseClient().events("session")).conversation as OrchestrationThread;
  return { ...sample, updatedAt: earlier, activities: [], ...overrides };
}

function activity(
  id: string,
  kind: string,
  requestId: string,
  detail?: string,
): OrchestrationThreadActivity {
  return {
    id: EventId.make(id),
    kind,
    tone: "approval",
    summary: kind,
    payload: { requestId, ...(detail ? { detail } : {}) },
    turnId: TurnId.make("old-turn"),
    createdAt: earlier,
  };
}

describe("accepted conversation history", () => {
  it("keeps the current state reference when a rejected older mirror has no new terminal evidence", async () => {
    const requested = activity("requested", "approval.requested", "request-one");
    const resolved = activity("resolved", "approval.resolved", "request-one");
    const current = await history({ updatedAt: later, activities: [requested, resolved] });
    const stale = { ...current, updatedAt: earlier, activities: [requested] };

    // Persistence observes this accepted state, so the rejected raw mirror
    // cannot replace the cached resolution or trigger a history-state change.
    expect(acceptHistory(current, stale)).toBe(current);
  });

  it.each([earlier, later])(
    "retains a missing resolution while accepting incoming messages at %s",
    async (updatedAt) => {
      const requested = activity("requested", "approval.requested", "request-one");
      const resolved = activity("resolved", "approval.resolved", "request-one");
      const current = await history({ activities: [requested, resolved] });
      const messages = [
        ...current.messages,
        {
          id: MessageId.make("new-message"),
          role: "assistant" as const,
          text: "New live content",
          turnId: TurnId.make("new-turn"),
          streaming: true,
          createdAt: later,
          updatedAt: later,
        },
      ];
      const incoming = {
        ...current,
        updatedAt,
        title: "New title",
        messages,
        activities: [requested],
      };

      const accepted = acceptHistory(current, incoming);

      expect(accepted.messages).toBe(messages);
      expect(accepted.title).toBe("New title");
      expect(accepted.updatedAt).toBe(updatedAt);
      expect(accepted.activities).toEqual([requested, resolved]);
      expect(incoming.activities).toEqual([requested]);
    },
  );

  it("preserves the new turn and does not reintroduce unrelated previous activities", async () => {
    const requested = activity("old-requested", "approval.requested", "old-request");
    const resolved = activity("old-resolved", "approval.resolved", "old-request");
    const unrelated = activity("unrelated", "approval.resolved", "unrelated-request");
    const current = await history({ activities: [requested, resolved, unrelated] });
    const nextRequest = {
      ...activity("new-requested", "approval.requested", "new-request"),
      turnId: TurnId.make("new-turn"),
      createdAt: later,
    };
    const latestTurn = {
      turnId: TurnId.make("new-turn"),
      state: "running" as const,
      requestedAt: later,
      startedAt: later,
      completedAt: null,
      assistantMessageId: null,
    };
    const incoming = {
      ...current,
      updatedAt: later,
      latestTurn,
      activities: [requested, nextRequest],
    };

    const accepted = acceptHistory(current, incoming);

    expect(accepted.latestTurn).toBe(latestTurn);
    expect(accepted.activities).toEqual([requested, nextRequest, resolved]);
  });

  it("recognizes existing terminal evidence regardless of incoming array order", async () => {
    const requested = activity("requested", "user-input.requested", "question-one");
    const resolved = activity("resolved", "user-input.resolved", "question-one");
    const current = await history({ activities: [requested, resolved] });
    const incoming = { ...current, activities: [resolved, requested] };

    expect(acceptHistory(current, incoming)).toBe(incoming);
    expect(incoming.activities).toHaveLength(2);
  });

  it("retains at most one missing resolution per requested ID", async () => {
    const requested = activity("requested", "approval.requested", "request-one");
    const resolved = activity("resolved", "approval.resolved", "request-one");
    const second = activity("second-resolution", "approval.resolved", "request-one");
    const current = await history({ activities: [resolved, resolved, second, requested] });
    const incoming = { ...current, activities: [requested] };

    const accepted = acceptHistory(current, incoming);
    expect(accepted.activities).toEqual([requested, resolved]);
    expect(acceptHistory(accepted, incoming).activities).toEqual([requested, resolved]);
    expect(acceptHistory(accepted, { ...incoming, activities: [] }).activities).toEqual([]);
  });

  it("retains stale-request terminal failures without treating transient failures as resolutions", async () => {
    const approval = activity("approval", "approval.requested", "permission");
    const question = activity("question", "user-input.requested", "question");
    const stale = activity(
      "stale",
      "provider.approval.respond.failed",
      "permission",
      "Unknown pending approval request",
    );
    const transient = activity(
      "transient",
      "provider.user-input.respond.failed",
      "question",
      "Connection temporarily unavailable",
    );
    const current = await history({ activities: [approval, question, stale, transient] });
    const accepted = acceptHistory(current, { ...current, activities: [approval, question] });

    expect(accepted.activities).toEqual([approval, question, stale]);
  });

  it("accepts delayed terminal evidence without replacing newer message or turn state", async () => {
    const requested = activity("requested", "approval.requested", "request-one");
    const resolved = activity("resolved", "approval.resolved", "request-one");
    const current = await history({ updatedAt: later, activities: [requested] });
    const delayed = {
      ...current,
      updatedAt: earlier,
      messages: [],
      latestTurn: null,
      activities: [resolved],
    };

    const accepted = acceptHistory(current, delayed);

    expect(accepted.updatedAt).toBe(later);
    expect(accepted.messages).toBe(current.messages);
    expect(accepted.latestTurn).toBe(current.latestTurn);
    expect(accepted.activities).toEqual([requested, resolved]);
  });

  it("never carries request evidence between separate conversations", async () => {
    const requested = activity("requested", "approval.requested", "request-one");
    const current = await history({
      activities: [requested, activity("resolved", "approval.resolved", "request-one")],
    });
    const other = { ...current, id: ThreadId.make("another-thread"), activities: [requested] };

    expect(acceptHistory(current, other)).toBe(other);
    expect(acceptHistory(null, other)).toBe(other);
  });

  it("does not revive an imported resolution by merging it without its history marker", async () => {
    const requested = activity("live-request", "approval.requested", "reused-request");
    const imported = activity("imported-resolution", "approval.resolved", "reused-request");
    const marker = {
      ...activity("import-marker", "thread.history.imported", "import"),
      payload: { historicalActivityIds: [imported.id] },
    };
    const current = await history({
      latestTurn: null,
      activities: [imported, marker],
    });
    const incoming = { ...current, updatedAt: later, activities: [requested] };

    const accepted = acceptHistory(current, incoming);

    expect(accepted).toBe(incoming);
    expect(pendingRequests(accepted).map((request) => request.id)).toEqual(["reused-request"]);
  });

  it("retains a live resolution even when the incoming snapshot has an imported resolution with the same request ID", async () => {
    const requested = activity("live-request", "approval.requested", "reused-request");
    const resolved = activity("live-resolution", "approval.resolved", "reused-request");
    const imported = activity("imported-resolution", "approval.resolved", "reused-request");
    const marker = {
      ...activity("import-marker", "thread.history.imported", "import"),
      payload: { historicalActivityIds: [imported.id] },
    };
    const current = await history({ latestTurn: null, activities: [requested, resolved] });
    const incoming = {
      ...current,
      updatedAt: later,
      activities: [imported, marker, requested],
    };

    const accepted = acceptHistory(current, incoming);

    expect(accepted.activities).toEqual([imported, marker, requested, resolved]);
    expect(pendingRequests(accepted)).toEqual([]);
  });
});
