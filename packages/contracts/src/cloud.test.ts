import { describe, expect, it } from "vite-plus/test";
import * as Schema from "effect/Schema";
import {
  CloudDesktopAuthError,
  CloudHandoffOperation,
  CloudStartConversationInput,
  CloudStartProgress,
  CloudWorkerCallback,
} from "./cloud.ts";

const decodeProgress = Schema.decodeUnknownSync(CloudStartProgress);
const decodeError = Schema.decodeUnknownSync(CloudDesktopAuthError);
const decodeHandoff = Schema.decodeUnknownSync(CloudHandoffOperation);
const decodeStart = Schema.decodeUnknownSync(CloudStartConversationInput);
const decodeCallback = Schema.decodeUnknownSync(CloudWorkerCallback);

describe("cloud presentation wire compatibility", () => {
  it("accepts legacy progress, errors, and transfer records without inventing facts", () => {
    expect(decodeProgress({ message: "Preparing" })).toEqual({ message: "Preparing" });
    expect(
      decodeError({ _tag: "CloudDesktopAuthError", message: "Timed out" }).requestDisposition,
    ).toBeUndefined();
    const handoff = {
      id: "move",
      conversationId: "thread",
      from: "local",
      to: "cloud-local",
      generation: 0,
      phase: "waiting",
      checkpoint: null,
      error: null,
    };
    expect(decodeHandoff(handoff)).toEqual(handoff);
  });
  it("accepts selected creation permissions and validates typed progress", () => {
    const start = {
      idempotencyKey: "send",
      target: "cloud-local",
      roots: [{ id: "root", path: "/workspace" }],
      provider: "codex",
      model: "model",
      prompt: "Hello",
    };
    expect(decodeStart(start).runtimeMode).toBeUndefined();
    expect(decodeStart({ ...start, runtimeMode: "approval-required" }).runtimeMode).toBe(
      "approval-required",
    );
    expect(() => decodeStart({ ...start, runtimeMode: "invalid" })).toThrow();
    expect(() => decodeProgress({ message: "Collecting", phase: "complete-ish" })).toThrow();
    expect(() => decodeProgress({ message: "Uploading", completedBytes: -1 })).toThrow();
    expect(
      decodeProgress({ message: "", requestId: "send", sequence: 0, phase: "unknown" }).phase,
    ).toBe("unknown");
  });
  it("keeps setup outcome separate from running and requires attempt provenance", () => {
    const callback = {
      taskId: "task",
      attemptId: "attempt",
      generation: 1,
      sequence: 9,
      phase: "running",
      detail: "",
      dependencySetup: {
        attemptId: "attempt",
        sequence: 8,
        outcome: "failed",
        updatedAt: "2026-10-16T00:00:00Z",
        detail: "Install failed",
      },
    };
    expect(decodeCallback(callback).dependencySetup?.outcome).toBe("failed");
    expect(() => decodeCallback({ ...callback, dependencySetup: { outcome: "failed" } })).toThrow();
  });
});
