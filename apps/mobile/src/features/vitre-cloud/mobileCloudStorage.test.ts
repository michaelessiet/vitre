import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

let document = "";
vi.mock("expo-file-system", () => ({
  Paths: { document: "/documents" },
  Directory: class {
    create() {}
  },
  File: class {
    get exists() {
      return document.length > 0;
    }
    text() {
      return Promise.resolve(document);
    }
    write(value: string) {
      document = value;
    }
  },
}));

import {
  loadPendingCloudSend,
  transitionPendingCloudSend,
  updatePendingCloudSend,
} from "./mobileCloudStorage";

beforeEach(() => {
  document = "";
});

describe("cloud send persistence", () => {
  it("stores the original request before dispatch and restores it after restart", async () => {
    const pending = {
      accountId: "account",
      taskId: "task",
      idempotencyKey: "immutable-key",
      prompt: "Fix the bug",
      createdAt: "2026-10-16T10:00:00.000Z",
      disposition: "uncertain" as const,
    };
    await updatePendingCloudSend("account", "task", pending);
    expect(await loadPendingCloudSend("account", "task")).toEqual(pending);
    expect(await loadPendingCloudSend("other", "task")).toBeNull();
    await updatePendingCloudSend("account", "task", null);
    expect(await loadPendingCloudSend("account", "task")).toBeNull();
  });

  it("treats an interrupted in-flight request as delivery uncertain", async () => {
    const pending = {
      accountId: "account",
      taskId: "task",
      idempotencyKey: "send-once",
      prompt: "Check the tests",
      createdAt: "2026-10-16T10:00:00.000Z",
      disposition: "submitting" as const,
    };
    await updatePendingCloudSend("account", "task", pending);
    expect(await loadPendingCloudSend("account", "task")).toEqual({
      ...pending,
      disposition: "uncertain",
    });
  });

  it("does not let a late response replace a newer request", async () => {
    const first = {
      accountId: "account",
      taskId: "task",
      idempotencyKey: "first",
      prompt: "First",
      createdAt: "2026-10-16T10:00:00.000Z",
      disposition: "submitting" as const,
    };
    const second = { ...first, idempotencyKey: "second", prompt: "Second" };
    await updatePendingCloudSend("account", "task", first);
    await updatePendingCloudSend("account", "task", second);
    expect(await transitionPendingCloudSend("account", "task", "first", null)).toBe(false);
    expect(await loadPendingCloudSend("account", "task")).toMatchObject({
      idempotencyKey: "second",
      prompt: "Second",
    });
  });
});
