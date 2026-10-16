import { describe, expect, it } from "vite-plus/test";
import {
  advanceHandoffCoordinator,
  HandoffWait,
  HandoffFailure,
  HandoffCommitConfirmed,
  type HandoffJournal,
  type HandoffPorts,
} from "./handoffCoordinator.ts";

function fixture() {
  let state: HandoffJournal = {
    id: "move",
    conversationId: "thread",
    from: "local",
    to: "cloud-local",
    generation: 0,
    phase: "waiting",
    checkpoint: null,
    destination: null,
    error: null,
    cancelRequested: false,
  };
  const calls: string[] = [];
  let owner = "source";
  let sourceFrozen = false;
  const ports: HandoffPorts = {
    read: async () => structuredClone(state),
    save: async (previous, next) => {
      expect(state).toEqual(previous);
      state = structuredClone(next);
    },
    isSourceIdle: async () => true,
    prepare: async () => {
      calls.push("prepare");
    },
    freezeAndCapture: async () => {
      sourceFrozen = true;
      calls.push("capture");
      return "snapshot";
    },
    transfer: async () => {
      expect(sourceFrozen).toBe(true);
      calls.push("transfer");
      return "destination";
    },
    verify: async () => {
      calls.push("verify");
    },
    commit: async () => {
      expect(sourceFrozen).toBe(true);
      owner = "destination";
      calls.push("commit");
    },
    activate: async () => {
      expect(owner).toBe("destination");
      expect(sourceFrozen).toBe(true);
      calls.push("activate");
    },
    release: async () => {
      calls.push("release");
    },
    rollback: async () => {
      if (owner !== "source") throw new Error("Already committed");
      sourceFrozen = false;
      calls.push("rollback");
    },
  };
  return {
    ports,
    calls,
    get state() {
      return state;
    },
    get sourceFrozen() {
      return sourceFrozen;
    },
    step: () => advanceHandoffCoordinator(ports, "move"),
  };
}

describe("durable handoff coordinator", () => {
  it("waits for active turns without preparing or blocking draft editing", async () => {
    const f = fixture();
    f.ports.isSourceIdle = async () => false;
    expect((await f.step()).phase).toBe("waiting");
    expect(f.calls).toEqual([]);
  });
  it("orders verification and activation before releasing the source", async () => {
    const f = fixture();
    for (let i = 0; i < 8; i++) await f.step();
    expect(f.state.phase).toBe("completed");
    expect(f.calls).toEqual([
      "prepare",
      "capture",
      "transfer",
      "verify",
      "commit",
      "activate",
      "release",
    ]);
  });
  it("resumes an interrupted transfer at the saved checkpoint", async () => {
    const f = fixture();
    for (let i = 0; i < 3; i++) await f.step();
    const transfer = f.ports.transfer;
    f.ports.transfer = async () => {
      throw new Error("Disconnected");
    };
    await f.step();
    expect(f.state).toMatchObject({
      phase: "transferring",
      checkpoint: "snapshot",
      error: "Disconnected",
    });
    f.ports.transfer = transfer;
    await f.step();
    expect(f.state).toMatchObject({ phase: "verifying", error: null });
    expect(f.calls.filter((call) => call === "capture")).toHaveLength(1);
  });
  it("never rolls back an ambiguous commit, even if cancellation arrives", async () => {
    const f = fixture();
    for (let i = 0; i < 5; i++) await f.step();
    const commit = f.ports.commit;
    let first = true;
    f.ports.commit = async (op) => {
      await commit(op);
      if (first) {
        first = false;
        throw new Error("Reply lost");
      }
    };
    await f.step();
    f.state.cancelRequested = true;
    expect(f.state.phase).toBe("activating");
    expect(f.sourceFrozen).toBe(true);
    await f.step();
    await f.step();
    expect(f.state.phase).toBe("completed");
    expect(f.calls).not.toContain("rollback");
  });
  it("restores source ownership on precommit cancellation", async () => {
    const f = fixture();
    for (let i = 0; i < 3; i++) await f.step();
    f.state.cancelRequested = true;
    await f.step();
    expect(f.state.phase).toBe("cancelled");
    expect(f.sourceFrozen).toBe(false);
    expect(f.calls).not.toContain("activate");
  });
});

it("represents cloud preparation as a neutral typed wait with monotonic revision", async () => {
  const f = fixture();
  f.ports.now = async () => "2026-10-16T12:00:00.000Z";
  for (let i = 0; i < 4; i++) await f.step();
  f.ports.verify = async () => {
    throw new HandoffWait("cloud-preparation");
  };
  const waiting = await f.step();
  expect(waiting).toMatchObject({
    phase: "verifying",
    waitReason: "cloud-preparation",
    error: null,
    revision: 5,
  });
  expect(waiting.startedAt).toBe("2026-10-16T12:00:00.000Z");
  f.ports.verify = async () => {};
  expect(await f.step()).toMatchObject({ phase: "activating", revision: 6, error: null });
  expect(f.state.waitReason).toBeUndefined();
});

it("pauses terminal precommit failures with the source fenced and supports safe cancellation", async () => {
  const f = fixture();
  for (let i = 0; i < 4; i++) await f.step();
  let calls = 0;
  f.ports.verify = async () => {
    calls++;
    throw new HandoffFailure("Provider needs authentication");
  };
  await f.step();
  const revision = f.state.revision;
  await f.step();
  expect(calls).toBe(1);
  expect(f.state.revision).toBe(revision);
  expect(f.state.errorDisposition).toBe("terminal");
  expect(f.sourceFrozen).toBe(true);
  f.state.cancelRequested = true;
  await f.step();
  expect(f.state.phase).toBe("cancelled");
  expect(f.sourceFrozen).toBe(false);
});

it("keeps ambiguous ownership fenced even if the final request has a terminal error", async () => {
  const f = fixture();
  for (let i = 0; i < 5; i++) await f.step();
  f.ports.activate = async () => {
    throw new HandoffFailure("Could not confirm ownership");
  };
  await f.step();
  expect(f.state).toMatchObject({
    phase: "activating",
    errorDisposition: "unknown",
    waitReason: "ownership-confirmation",
  });
  expect(f.sourceFrozen).toBe(true);
  f.state.cancelRequested = true;
  await f.step();
  expect(f.calls).not.toContain("rollback");
});

it("finishes a confirmed committed operation when cancellation finds stale local phase", async () => {
  const f = fixture();
  for (let i = 0; i < 4; i++) await f.step();
  f.state.cancelRequested = true;
  f.ports.rollback = async () => {
    throw new HandoffCommitConfirmed();
  };
  await f.step();
  expect(f.state).toMatchObject({
    phase: "activating",
    cancelRequested: false,
    waitReason: "ownership-confirmation",
    error: null,
  });
  await f.step();
  await f.step();
  expect(f.state.phase).toBe("completed");
  expect(f.calls).not.toContain("rollback");
});

it("does not let a delayed save overwrite cancellation or a newer journal revision", async () => {
  const f = fixture();
  const save = f.ports.save;
  f.ports.prepare = async () => {
    f.state.cancelRequested = true;
    f.state.revision = (f.state.revision ?? 0) + 1;
  };
  f.ports.save = async (previous, next) => {
    if (previous.revision !== f.state.revision) throw new Error("Switch changed; reloading");
    await save(previous, next);
  };
  await f.step();
  await expect(f.step()).rejects.toThrow("Switch changed");
  expect(f.state.cancelRequested).toBe(true);
  expect(f.state.phase).toBe("preparing");
  await f.step();
  expect(f.state.phase).toBe("cancelled");
});
