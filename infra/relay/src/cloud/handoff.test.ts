import { describe, expect, it } from "vite-plus/test";
import { iso } from "./policy.ts";
import {
  advanceHandoff,
  ownsConversation,
  requestHandoff,
  stopHandoff,
  type HandoffState,
} from "./handoff.ts";
const fixture = (): HandoffState => ({
  bindings: {
    thread: {
      conversationId: "thread",
      localThreadId: "thread",
      cloudTaskId: null,
      target: "local",
      generation: 0,
      leaseOwner: "desktop",
      leaseExpiresAt: "1970-01-01T00:01:40.000Z",
    },
  },
  handoffs: {},
});
const request = {
  id: "move",
  conversationId: "thread",
  target: "cloud-local" as const,
  expectedGeneration: 0,
};
describe("conversation handoff ownership", () => {
  it("revisions and timestamps advance only on actual transitions", () => {
    const state = fixture();
    const first = requestHandoff(state, { ...request, now: 1000 });
    expect(first).toMatchObject({
      revision: 1,
      startedAt: iso(1000),
      updatedAt: iso(1000),
    });
    const second = advanceHandoff(state, {
      id: "move",
      expectedPhase: "waiting",
      nextPhase: "preparing",
      now: 2000,
    });
    expect(second.revision).toBe(2);
    expect(second.startedAt).toBe(first.startedAt);
    expect(
      advanceHandoff(state, {
        id: "move",
        expectedPhase: "waiting",
        nextPhase: "preparing",
        now: 3000,
      }),
    ).toEqual(second);
    const stopped = stopHandoff(state, "move", undefined, 4000);
    expect(stopped).toMatchObject({
      revision: 3,
      phase: "cancelled",
      updatedAt: iso(4000),
    });
    expect(stopHandoff(state, "move", undefined, 5000)).toEqual(stopped);
  });
  it("deduplicates requests but rejects different intent and competing moves", () => {
    const state = fixture();
    expect(requestHandoff(state, request)).toEqual(requestHandoff(state, request));
    expect(() => requestHandoff(state, { ...request, target: "cloud-github" })).toThrow();
    expect(() => requestHandoff(state, { ...request, id: "another" })).toThrow();
  });
  it("keeps the source owner until verification and fences it at activation", () => {
    const state = fixture();
    requestHandoff(state, request);
    const phases = [
      "waiting",
      "preparing",
      "checkpointing",
      "transferring",
      "verifying",
      "activating",
      "releasing",
      "completed",
    ] as const;
    for (let i = 0; i < phases.length - 1; i++) {
      advanceHandoff(state, {
        id: "move",
        expectedPhase: phases[i]!,
        nextPhase: phases[i + 1]!,
        checkpoint: { id: "snapshot", sha256: "a".repeat(64) },
        destinationOwner: "machine",
        cloudTaskId: "task",
        now: 1000,
      });
      expect(state.bindings.thread!.target).toBe(i < 4 ? "local" : "cloud-local");
    }
    expect(ownsConversation(state.bindings.thread!, "desktop", 0, 1001)).toBe(false);
    expect(ownsConversation(state.bindings.thread!, "machine", 1, 1001)).toBe(true);
    expect(ownsConversation(state.bindings.thread!, "machine", 1, 100_000)).toBe(false);
    expect(state.bindings.thread!.cloudTaskId).toBe("task");
  });
  it("cannot skip verification or cancel after ownership commits", () => {
    const state = fixture();
    requestHandoff(state, request);
    expect(() =>
      advanceHandoff(state, {
        id: "move",
        expectedPhase: "waiting",
        nextPhase: "activating",
        now: 0,
      }),
    ).toThrow();
    state.handoffs.move = { ...state.handoffs.move!, phase: "activating" };
    expect(() => stopHandoff(state, "move")).toThrow();
  });
  it("failures and cancellations leave the source unchanged and allow retry", () => {
    const state = fixture();
    const before = structuredClone(state.bindings);
    requestHandoff(state, request);
    stopHandoff(state, "move", "Upload interrupted");
    expect(state.bindings).toEqual(before);
    expect(requestHandoff(state, { ...request, id: "retry" }).phase).toBe("waiting");
    expect(stopHandoff(state, "retry").phase).toBe("cancelled");
    expect(state.bindings).toEqual(before);
  });
});
