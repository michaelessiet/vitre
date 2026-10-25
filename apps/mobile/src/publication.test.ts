import { describe, expect, it } from "vite-plus/test";
import type { CloudSavedResult, CloudTask } from "@t3tools/contracts/cloud";
import { makeShowcaseClient } from "./showcase";
import { publicationUnavailable, reviewedPublication } from "./publication";

async function fixture() {
  const overview = await makeShowcaseClient().overview();
  const sample = overview.tasks[0]!;
  const hash = "a".repeat(64);
  const result = {
    id: "saved",
    taskId: sample.id,
    checkpointId: "saved",
    sha256: hash,
    summary: "Finished changes",
    createdAt: sample.updatedAt,
  };
  const task: CloudTask = {
    ...sample,
    source: undefined,
    repository: { ...sample.repository, owner: "michaelessiet", installationId: "1" },
    state: "completed",
    result,
    checkpoint: {
      id: "saved",
      taskId: sample.id,
      attemptId: "attempt",
      sequence: 1,
      objectKey: "manifest",
      sha256: hash,
      sizeBytes: 100,
      createdAt: sample.updatedAt,
    },
  };
  const saved: CloudSavedResult = {
    revision: result,
    result: {
      summary: "Finished changes",
      diff: "diff --git a/README.md b/README.md\n+fixed",
      conversation: null,
      testOutput: "Tests passed",
      testExitCode: 0,
    },
  };
  return { task, saved };
}

describe("mobile pull request review", () => {
  it("publishes the exact reviewed snapshot and entered metadata", async () => {
    const { task, saved } = await fixture();
    expect(publicationUnavailable(task, false)).toBeNull();
    expect(reviewedPublication(task, saved, " Fix ", " Reviewed ", "key")).toEqual({
      type: "publication.create",
      idempotencyKey: "key",
      taskId: task.id,
      resultId: saved.revision!.id,
      resultSha256: saved.revision!.sha256,
      kind: "pull_request",
      title: "Fix",
      body: "Reviewed",
    });
  });
  it("rejects a replacement result, active turn, or mismatched checkpoint after review", async () => {
    const { task, saved } = await fixture();
    for (const changed of [
      { ...task, state: "running" as const },
      { ...task, result: { ...task.result!, id: "new" } },
      { ...task, result: { ...task.result!, sha256: "b".repeat(64) } },
      { ...task, checkpoint: { ...task.checkpoint!, id: "other" } },
      { ...task, checkpoint: null },
    ])
      expect(() => reviewedPublication(changed, saved, "Fix", "Reviewed", "key")).toThrow(
        "Review the latest snapshot",
      );
  });
  it("does not publish before review or with an empty diff or metadata", async () => {
    const { task, saved } = await fixture();
    expect(() => reviewedPublication(task, null, "Fix", "Reviewed", "key")).toThrow("Review");
    expect(() =>
      reviewedPublication(
        task,
        { ...saved, result: { ...saved.result, diff: "" } },
        "Fix",
        "Reviewed",
        "key",
      ),
    ).toThrow("no changes");
    expect(() => reviewedPublication(task, saved, " ", "Reviewed", "key")).toThrow(
      "title and description",
    );
  });
  it("allows idle workspaces to save and explains busy, unsupported, and disconnected states", async () => {
    const { task } = await fixture();
    const ready: CloudTask = {
      ...task,
      state: "running",
      idle: true,
      result: null,
      worker: {
        id: "worker",
        sandboxId: "machine-test",
        environmentId: "env",
        state: "ready",
        cpu: 1,
        memoryGiB: 1,
        diskGiB: 1,
        stoppedAt: null,
      },
    };
    expect(publicationUnavailable(ready, true)).toBeNull();
    expect(publicationUnavailable(ready, false)).toContain("Update the cloud service");
    expect(publicationUnavailable({ ...ready, idle: false }, true)).toContain("current work");
    expect(publicationUnavailable({ ...ready, state: "cancelled" }, true)).toContain("Resume");
    expect(
      publicationUnavailable(
        { ...ready, repository: { ...ready.repository, installationId: "public" } },
        true,
      ),
    ).toContain("personal GitHub");
    expect(
      publicationUnavailable(
        { ...ready, repository: { ...ready.repository, installationId: "local" } },
        true,
      ),
    ).toContain("not connected");
  });
});
