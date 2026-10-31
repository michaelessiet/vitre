import { describe, expect, it, vi } from "vite-plus/test";
import { CloudClientError, type CloudClient } from "@t3tools/client-runtime/cloud";
import { createConversation, resolveRepository, type PendingCreation } from "./creation";
import type { AccountStorage } from "./storage";

const repository = {
  id: "42",
  installationId: "public",
  owner: "Owner",
  name: "Repo",
  defaultBranch: "main",
  setupCommand: "",
  testCommand: "",
  revision: 0,
};
describe("mobile cloud creation", () => {
  it("resolves an unconfigured public URL without a GitHub connection", async () => {
    const client = {
      repositories: async () => [],
      publicRepository: vi.fn(async () => repository),
    } as unknown as CloudClient;
    expect(await resolveRepository(client, "https://github.com/owner/repo.git/", [])).toEqual(
      repository,
    );
    expect(client.publicRepository).toHaveBeenCalledWith("owner", "repo");
  });
  it("resolves installed private repositories and explains missing access", async () => {
    const privateRepo = { ...repository, installationId: "installation" };
    const client = {
      repositories: async () => [privateRepo],
      publicRepository: async () => null,
    } as unknown as CloudClient;
    expect(await resolveRepository(client, "owner/repo", [])).toEqual(privateRepo);
    await expect(resolveRepository(client, "missing/private", [])).rejects.toThrow(
      "GitHub connection",
    );
  });
  it("can resolve public repositories while installed discovery is unavailable", async () => {
    const client = {
      repositories: async () => {
        throw new Error("GitHub connection unavailable");
      },
      publicRepository: async () => repository,
    } as unknown as CloudClient;
    expect(await resolveRepository(client, "owner/repo", [])).toEqual(repository);
  });
  it("keeps a saved account, allows explicit selection, and never silently switches identities", async () => {
    const personal = { ...repository, installationId: "installation", githubAccountId: "personal" };
    const work = { ...personal, githubAccountId: "work" };
    const client = {
      repositories: async () => [work, personal],
      publicRepository: async () => repository,
    } as unknown as CloudClient;
    await expect(resolveRepository(client, "owner/repo", [])).rejects.toThrow(
      "Choose which GitHub account",
    );
    expect((await resolveRepository(client, "owner/repo", [personal])).githubAccountId).toBe(
      "personal",
    );
    expect(
      (await resolveRepository(client, "owner/repo", [personal], "work")).githubAccountId,
    ).toBe("work");
    await expect(resolveRepository(client, "owner/repo", [], "unlinked")).rejects.toThrow(
      "selected GitHub account",
    );
  });
  it("replays distinct stable keys when registration succeeded and the task response was lost", async () => {
    const persisted = new Map<string, unknown>();
    const storage = {
      get: async (key: string) => persisted.get(key) ?? null,
      set: async (key: string, value: unknown) => {
        persisted.set(key, value);
      },
      clear: async () => {
        persisted.clear();
      },
    } as AccountStorage;
    const pending: PendingCreation = {
      registration: { type: "repository.save", idempotencyKey: "register", repository },
      command: {
        type: "task.create",
        idempotencyKey: "create",
        repositoryId: "42",
        baseBranch: "main",
        provider: "codex",
        prompt: "Explain this project",
        kind: "build",
        issueNumber: null,
      },
    };
    let lost = false;
    const calls: string[] = [];
    const client = {
      command: async (command: { type: string; idempotencyKey: string }) => {
        expect(persisted.get("pending-creation")).toEqual(pending);
        calls.push(command.idempotencyKey);
        if (command.type === "task.create" && !lost) {
          lost = true;
          throw new CloudClientError(0, "network", "Response lost");
        }
        return { entityId: command.type === "task.create" ? "same-task" : "42", overview: {} };
      },
    } as unknown as CloudClient;
    await expect(createConversation(client, storage, pending)).rejects.toThrow("Response lost");
    expect(persisted.get("pending-creation")).toEqual(pending);
    expect((await createConversation(client, storage, pending)).entityId).toBe("same-task");
    expect(calls).toEqual(["register", "create", "register", "create"]);
    expect(persisted.get("pending-creation")).toBeNull();
  });
});
