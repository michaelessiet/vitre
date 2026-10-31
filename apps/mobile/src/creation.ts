import { type CloudClient, parseGithubRepository } from "@t3tools/client-runtime/cloud";
import type { CloudCommand, CloudRepository } from "@t3tools/contracts/cloud";
import type { AccountStorage } from "./storage";

export type CreationCommand = Extract<
  CloudCommand,
  { type: "task.create" | "task.createFromProject" }
>;
export interface PendingCreation {
  registration?: Extract<CloudCommand, { type: "repository.save" }>;
  command: CreationCommand;
}

export async function resolveRepository(
  client: CloudClient,
  url: string,
  configured: readonly CloudRepository[],
  githubAccountId?: string,
) {
  const { owner, name } = parseGithubRepository(url);
  // Public repositories remain usable when installed-repository discovery is unavailable.
  let discoveryError: unknown;
  const installed = await client.repositories().catch((error: unknown) => {
    discoveryError = error;
    return [];
  });
  const matches = (repository: CloudRepository) =>
    repository.owner.toLowerCase() === owner.toLowerCase() &&
    repository.name.toLowerCase() === name.toLowerCase();
  const candidates = installed.filter(matches);
  const previousChoice = configured.find(matches)?.githubAccountId;
  const chosen = githubAccountId ?? previousChoice;
  if (!chosen && candidates.length > 1)
    throw new Error("Choose which GitHub account to use for this repository.");
  const selected = chosen
    ? candidates.find((repo) => repo.githubAccountId === chosen)
    : candidates[0];
  if (chosen && !selected)
    throw new Error(
      "The selected GitHub account cannot access this repository. Reconnect it or choose another account.",
    );
  const resolved =
    selected ??
    (await client.publicRepository(owner, name).catch((error: unknown) => {
      throw discoveryError ?? error;
    }));
  if (!resolved)
    throw new Error(
      "Repository unavailable. Check the URL, or grant access through your existing GitHub connection.",
    );
  const previous = configured.find((repository) => repository.id === resolved.id);
  return {
    ...resolved,
    ...(previous
      ? {
          setupCommand: previous.setupCommand,
          testCommand: previous.testCommand,
          revision: previous.revision,
        }
      : {}),
  };
}

/** Persist both keys before either mutation. An explicit retry replays these exact requests. */
export async function createConversation(
  client: CloudClient,
  storage: AccountStorage,
  pending: PendingCreation,
) {
  await storage.set("pending-creation", pending);
  if (pending.registration) await client.command(pending.registration);
  const result = await client.command(pending.command);
  await storage.set("pending-creation", null);
  await storage.set("new-draft", null);
  return result;
}
