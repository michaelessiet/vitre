import { expect, it } from "vite-plus/test";
import { OrchestrationReadModel, type OrchestrationThreadShell } from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { localLensInventory } from "./LensSync.ts";

const now = "2026-10-31T12:00:00.000Z";
const decode = Schema.decodeUnknownSync(OrchestrationReadModel);
function fixture() {
  const snapshot = decode({
    snapshotSequence: 1,
    updatedAt: now,
    projects: [
      {
        id: "p",
        title: "Project",
        workspaceRoot: "/tmp/lens-test",
        additionalRoots: [],
        defaultModelSelection: null,
        scripts: [],
        createdAt: now,
        updatedAt: now,
        deletedAt: null,
      },
    ],
    threads: ["local", "cloud-remote", "handed-off"].map((id) => ({
      id,
      projectId: "p",
      title: id,
      modelSelection: { instanceId: "codex", model: "test-model" },
      runtimeMode: "approval-required",
      branch: null,
      worktreePath: null,
      additionalRoots: [],
      latestTurn: null,
      createdAt: now,
      updatedAt: now,
      deletedAt: null,
      session: null,
      activities: [],
      checkpoints: [],
      messages: [
        {
          id: `${id}-user`,
          role: "user",
          text: "Recent work",
          createdAt: now,
          updatedAt: now,
          turnId: null,
          streaming: false,
          attachments: [],
        },
        {
          id: `${id}-assistant`,
          role: "assistant",
          text: "x".repeat(5000),
          createdAt: now,
          updatedAt: now,
          turnId: null,
          streaming: false,
          attachments: [],
        },
      ],
    })),
  });
  const shells: OrchestrationThreadShell[] = snapshot.threads.map((thread) => ({
    ...thread,
    latestUserMessageAt: now,
    hasPendingApprovals: false,
    hasPendingUserInput: thread.id === "local",
    hasActionableProposedPlan: false,
  }));
  return { snapshot, shells };
}

it("omits cloud aliases and handed-off conversations and prevents cleanup of a partial project", () => {
  const { snapshot, shells } = fixture();
  const inventory = localLensInventory(
    snapshot,
    shells,
    "local:test",
    "Desktop",
    now,
    new Set(["handed-off"]),
  );
  expect(inventory.conversations.map((thread) => thread.id)).toEqual(["local"]);
  expect(inventory.projects).toEqual([]);
});

it("keeps pending input, model usage and the last completed reply while bounding excerpts", () => {
  const { snapshot, shells } = fixture();
  const inventory = localLensInventory(snapshot, shells, "local:test", "Desktop", now);
  const conversation = inventory.conversations[0]!;
  expect(conversation.needsInput).toBe(true);
  expect(conversation.lastAssistantAt).toBe(now);
  expect(conversation.model).toEqual({ provider: "codex", model: "test-model" });
  expect(conversation.turns).toBe(1);
  expect(conversation.excerpt.length).toBeLessThanOrEqual(4000);
});

it("fails explicitly instead of silently truncating a workspace into unsafe cleanup candidates", () => {
  const { snapshot, shells } = fixture();
  expect(() =>
    localLensInventory(
      { ...snapshot, projects: Array.from({ length: 501 }, () => snapshot.projects[0]!) },
      shells,
      "local:test",
      "Desktop",
      now,
    ),
  ).toThrow("inventory limit");
});
