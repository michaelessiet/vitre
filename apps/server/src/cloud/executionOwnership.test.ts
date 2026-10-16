import { describe, expect, it } from "vite-plus/test";
import { initialExecution, validExecutionTransition } from "./executionOwnership.ts";

describe("execution ownership transitions", () => {
  const frozen = { generation: 0, operationId: "move", status: "frozen" as const };
  it("requires a quiescent freeze before activation or release", () => {
    expect(validExecutionTransition(initialExecution, 0, frozen)).toBe(true);
    expect(
      validExecutionTransition(initialExecution, 0, {
        ...frozen,
        status: "released",
        generation: 1,
      }),
    ).toBe(false);
    expect(
      validExecutionTransition(frozen, 0, { ...frozen, status: "released", generation: 1 }),
    ).toBe(true);
    expect(
      validExecutionTransition(frozen, 0, { ...frozen, status: "active", generation: 1 }),
    ).toBe(true);
  });
  it("rejects stale generations, competing requests and rollback after release", () => {
    expect(validExecutionTransition(frozen, 1, frozen)).toBe(false);
    expect(validExecutionTransition(frozen, 0, { ...frozen, operationId: "other" })).toBe(false);
    expect(
      validExecutionTransition(frozen, 0, { ...frozen, status: "active", operationId: "other" }),
    ).toBe(false);
    expect(
      validExecutionTransition({ ...frozen, status: "released", generation: 1 }, 1, {
        ...frozen,
        status: "active",
      }),
    ).toBe(false);
    expect(validExecutionTransition(frozen, 0, { ...frozen, status: "active" })).toBe(true);
  });
});
