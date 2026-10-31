import { CloudOverview, CloudTask } from "@t3tools/contracts/cloud";
import { OrchestrationThread } from "@t3tools/contracts";
import { makeCloudClient, type CloudClient } from "@t3tools/client-runtime/cloud";
import * as Schema from "effect/Schema";

const decodeTask = Schema.decodeUnknownSync(CloudTask);
const decodeOverview = Schema.decodeUnknownSync(CloudOverview);
const decodeThread = Schema.decodeUnknownSync(OrchestrationThread);

/** Development-only acceptance fixture. Never connects to or impersonates a cloud account. */
export function makeShowcaseClient(): CloudClient {
  const now = new Date().toISOString();
  const repository = {
    id: "42",
    installationId: "public",
    owner: "vitre",
    name: "parlay",
    defaultBranch: "main",
    setupCommand: "",
    testCommand: "",
    revision: 1,
  };
  const task = decodeTask({
    id: "session",
    projectId: "parlay",
    title: "Fix Unauthenticated Session Loading",
    repository,
    baseBranch: "main",
    baseSha: "a".repeat(40),
    provider: "codex",
    model: "GPT-6-Astra",
    modelOptions: [{ id: "reasoningEffort", value: "extra high" }],
    runtimeMode: "approval-required",
    kind: "build",
    prompt: "Fix the loading state for signed-out users",
    issueNumber: null,
    state: "completed",
    branch: "vitre/session",
    createdAt: now,
    updatedAt: now,
    attempt: null,
    worker: null,
    checkpoint: null,
    result: {
      id: "result",
      taskId: "session",
      checkpointId: "checkpoint",
      sha256: "b".repeat(64),
      summary: "Fixed startup",
      createdAt: now,
    },
    error: null,
  });
  const snapshot = {
    id: "snapshot",
    projectId: "parlay",
    revision: 1,
    sourceTaskId: "session",
    sourceTitle: task.title!,
    savedAt: now,
    sourceKind: "github",
    workspace: { id: "c".repeat(64), sha256: "c".repeat(64) },
    checkpoint: null,
    baseBranch: "vitre/session",
    baseSha: task.baseSha,
    roots: [{ id: "primary", name: "parlay" }],
  };
  let overview = decodeOverview({
    enabled: true,
    githubAccounts: [
      { id: "personal", login: "personal-example", state: "connected" },
      { id: "work", login: "work-example", state: "connected" },
    ],
    revision: 1,
    tasks: [
      task,
      ...["Vitre Cloud Functions", "Assess Parlay Architecture", "Set Up Parlay Staging"].map(
        (title, index) => ({
          ...task,
          id: `parlay-${index}`,
          title,
          updatedAt: new Date(Date.now() - (index + 2) * 86400000).toISOString(),
        }),
      ),
      ...[
        "Fix Conversation Scroll",
        "Start a Coding Session",
        "Improve Vitre Startup",
        "Check Conversation State",
        "Streamline Vitre Deploys",
      ].map((title, index) => ({
        ...task,
        id: `vitre-${index}`,
        projectId: "vitre",
        repository: { ...repository, id: "43", name: "vitre" },
        title,
      })),
    ],
    repositories: [repository],
    projects: [
      { id: "parlay", title: "parlay", repository, revision: 1, latestSnapshot: snapshot },
      {
        id: "vitre",
        title: "vitre",
        repository: null,
        revision: 1,
        latestSnapshot: {
          ...snapshot,
          id: "uploaded",
          projectId: "vitre",
          sourceKind: "local",
          roots: [
            { id: "primary", name: "vitre" },
            { id: "assets", name: "Assets" },
          ],
        },
      },
    ],
    accounts: [
      { provider: "codex", state: "connected", credentialVersion: 1, leasedBy: null },
      { provider: "claude", state: "connected", credentialVersion: 1, leasedBy: null },
    ],
    publications: [],
    usage: {
      month: "2026-10",
      spentMicroDollars: 0,
      reservedMicroDollars: 0,
      limitMicroDollars: 10000000,
      warning: false,
    },
    capabilities: { projectCreation: true, followUpSettings: true, mobileNotifications: false },
  });
  const message = (id: string, role: "user" | "assistant", text: string, turnId: string) => ({
    id,
    role,
    text,
    turnId,
    streaming: false,
    createdAt: now,
    updatedAt: now,
  });
  const thread = (
    task: CloudTask,
    messages: readonly {
      id: string;
      role: string;
      text: string;
      turnId: string | null;
      streaming: boolean;
      createdAt: string;
      updatedAt: string;
    }[] = [
      message("one", "user", "run locally let me test", "turn-one"),
      message(
        "two",
        "assistant",
        "Running at [http://localhost:3000](http://localhost:3000) and responding successfully.\n\nOpen it in an incognito window to test the logged-out startup.",
        "turn-one",
      ),
      message("three", "user", "Ok, push to staging", "turn-two"),
      message(
        "four",
        "assistant",
        "Pushed to `staging`: `9ccdbec` — `fix: show welcome while checking authentication`.\n\nWorking tree is clean.",
        "turn-two",
      ),
    ],
  ) =>
    decodeThread({
      id: `cloud-${task.id}`,
      projectId: task.projectId ?? "parlay",
      title: task.title ?? task.prompt,
      modelSelection: { instanceId: "codex", model: task.model ?? "Cloud default" },
      runtimeMode: "approval-required",
      branch: task.branch,
      worktreePath: null,
      latestTurn: null,
      createdAt: now,
      updatedAt: new Date().toISOString(),
      deletedAt: null,
      messages,
      activities: [
        {
          id: "activity-one",
          tone: "tool",
          kind: "tool.completed",
          summary: "Checked the signed-out startup and verified the response",
          payload: {},
          turnId: "turn-one",
          createdAt: now,
        },
      ],
      checkpoints: [
        {
          turnId: "turn-one",
          checkpointTurnCount: 1,
          checkpointRef: "refs/vitre/checkpoint",
          status: "ready",
          files: [{ path: "src/auth.ts", kind: "modified", additions: 91, deletions: 4 }],
          assistantMessageId: "two",
          completedAt: now,
        },
      ],
      session: null,
    });
  const histories = new Map(overview.tasks.map((task) => [task.id, thread(task)]));
  const receipts = new Map<string, string>();
  let sequence = 0;
  return {
    ...makeCloudClient({ baseUrl: "https://preview.invalid", accessToken: async () => "" }),
    overview: async () => overview,
    repositories: async () => overview.repositories,
    publicRepository: async (owner, name) => ({ ...repository, owner, name, revision: 0 }),
    projectSnapshots: async (id) =>
      overview.projects?.find((project) => project.id === id)?.latestSnapshot
        ? [overview.projects.find((project) => project.id === id)!.latestSnapshot!]
        : [],
    events: async (id) => ({
      cursor: 0,
      reset: false,
      events: [],
      conversation: histories.get(id) ?? null,
    }),
    result: async () => ({
      revision: task.result,
      result: {
        summary: "Saved changes",
        diff: "diff --git a/src/auth.ts b/src/auth.ts\n--- a/src/auth.ts\n+++ b/src/auth.ts\n@@ -1 +1,2 @@\n-return loading;\n+if (session === undefined) return welcome;\n+return loading;",
        conversation: null,
        testOutput: "Checks passed",
        testExitCode: 0,
      },
    }),
    command: async (command) => {
      const previous = receipts.get(command.idempotencyKey);
      if (previous) return { entityId: previous, overview };
      let id = "";
      if (command.type === "repository.save") {
        id = command.repository.id;
        overview = {
          ...overview,
          repositories: [
            ...overview.repositories.filter((entry) => entry.id !== id),
            { ...command.repository, revision: command.repository.revision + 1 },
          ],
        };
      } else if (command.type === "task.create" || command.type === "task.createFromProject") {
        id = `preview-${++sequence}`;
        const project =
          command.type === "task.createFromProject"
            ? overview.projects?.find((project) => project.id === command.projectId)
            : null;
        const created = {
          ...task,
          id,
          title: command.prompt,
          prompt: command.prompt,
          provider: command.provider,
          branch: `vitre/${id}`,
          projectId: project?.id ?? id,
          repository:
            project?.repository ??
            (command.type === "task.create"
              ? overview.repositories.find((repo) => repo.id === command.repositoryId)!
              : { ...repository, name: project?.title ?? "Uploaded project" }),
          result: null,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        };
        overview = { ...overview, tasks: [...overview.tasks, created] };
        histories.set(
          id,
          thread(created, [
            message(`${id}-user`, "user", command.prompt, id),
            message(
              `${id}-assistant`,
              "assistant",
              "This is an interface preview. In your connected build, Vitre starts a new cloud workspace here with fresh conversation history.",
              id,
            ),
          ]),
        );
      } else if (command.type === "task.continue") {
        id = command.taskId;
        const found = overview.tasks.find((task) => task.id === id)!;
        overview = {
          ...overview,
          tasks: overview.tasks.map((task) =>
            task.id === id ? { ...task, turnRequestId: command.idempotencyKey } : task,
          ),
        };
        histories.set(
          id,
          thread(found, [
            ...histories.get(id)!.messages,
            message(`${command.idempotencyKey}-message`, "user", command.prompt, id),
            message(
              `${++sequence}-assistant`,
              "assistant",
              "Your draft was submitted in this interface preview.",
              id,
            ),
          ]),
        );
      } else throw new Error("This action needs a connected cloud deployment.");
      overview = { ...overview, revision: (overview.revision ?? 0) + 1 };
      receipts.set(command.idempotencyKey, id);
      return { entityId: id, overview };
    },
  };
}
