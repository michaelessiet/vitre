import { expect, it } from "vite-plus/test";
import { makeStartProgress } from "./startProgress.ts";
import { CloudRequestFailure } from "./requestFailure.ts";

it("reports typed progress, deduplicates active starts, and retains cancellation", async () => {
  const tracker = makeStartProgress({ now: () => 1_000 });
  let calls = 0;
  const operation = tracker.run("draft", async (signal, report) => {
    calls++;
    report({ phase: "upload", message: "Uploading 12 MB", completedBytes: 12 });
    await new Promise<void>((_, reject) =>
      signal.addEventListener(
        "abort",
        () => reject(new CloudRequestFailure("draft is unchanged", "rejected")),
        { once: true },
      ),
    );
  });
  const duplicate = tracker.run("draft", async () => {
    calls++;
  });
  expect(duplicate).toBe(operation);
  await Promise.resolve();
  expect(tracker.status("draft")).toMatchObject({
    requestId: "draft",
    phase: "upload",
    sequence: 1_001,
    completedBytes: 12,
    startedAt: "1970-01-01T00:00:01.000Z",
    updatedAt: "1970-01-01T00:00:01.000Z",
  });
  expect(tracker.status("draft", true).phase).toBe("cancelling");
  await expect(operation).rejects.toThrow("draft is unchanged");
  expect(tracker.status("draft").phase).toBe("cancelled");
  expect(calls).toBe(1);
  await expect(tracker.run("draft", async () => "retried")).resolves.toBe("retried");
  expect(tracker.status("draft").sequence).toBeGreaterThan(1_003);
});

it("retains successful results for lost replies, bounds terminal retention, and reports unknown", async () => {
  let now = 0;
  const tracker = makeStartProgress({ now: () => now, retentionMs: 100, maxRetained: 2 });
  expect(tracker.status("missing").phase).toBe("unknown");
  await tracker.run("one", async () => "accepted");
  expect(tracker.status("one", true).phase).toBe("completed");
  await expect(
    tracker.run("one", async () => {
      throw new Error("must not repeat capture");
    }),
  ).resolves.toBe("accepted");
  await tracker.run("two", async () => 2);
  await tracker.run("three", async () => 3);
  expect(tracker.status("one").phase).toBe("unknown");
  now = 100;
  expect(tracker.status("two").phase).toBe("unknown");
});

it("never reports cancellation as definite when the dispatch reply was lost", async () => {
  const tracker = makeStartProgress();
  let finish!: () => void;
  const result = tracker.run("start", async (_signal, report) => {
    report({ phase: "creation", message: "Creating" });
    await new Promise<void>((resolve) => {
      finish = resolve;
    });
    throw new CloudRequestFailure("Reply lost", "unknown");
  });
  await Promise.resolve();
  tracker.status("start", true);
  finish();
  await expect(result).rejects.toThrow("Reply lost");
  expect(tracker.status("start").phase).toBe("failed");
});

it("lets committed completion win a cancellation race and ignores stale reports", async () => {
  const tracker = makeStartProgress();
  let finish!: () => void;
  const result = tracker.run("start", async (_signal, report) => {
    await new Promise<void>((resolve) => {
      finish = resolve;
    });
    report({ phase: "upload", message: "late upload" });
    return "accepted";
  });
  await Promise.resolve();
  tracker.status("start", true);
  finish();
  await expect(result).resolves.toBe("accepted");
  expect(tracker.status("start").phase).toBe("completed");
});

it("rejects changed payloads before returning an active or retained response", async () => {
  const tracker = makeStartProgress();
  let finish!: () => void;
  const accepted = tracker.run(
    "key",
    async () => {
      await new Promise<void>((resolve) => {
        finish = resolve;
      });
      return "accepted";
    },
    "original",
  );
  await Promise.resolve();
  await expect(tracker.run("key", async () => "different", "changed")).rejects.toMatchObject({
    code: "idempotency_conflict",
  });
  finish();
  await accepted;
  await expect(tracker.run("key", async () => "different", "changed")).rejects.toMatchObject({
    code: "idempotency_conflict",
  });
});
