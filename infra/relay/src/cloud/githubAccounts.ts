import { createClerkClient } from "@clerk/backend";
import type { CloudGitHubAccount } from "@t3tools/contracts/cloud";
import { CloudError } from "./policy.ts";

export interface GitHubIdentity {
  id: string;
  providerUserId: string;
  token: string;
}
export interface GitHubAccounts {
  list(userId: string): Promise<CloudGitHubAccount[]>;
  credential(userId: string, accountId: string): Promise<GitHubIdentity>;
}

type ClerkUsers = Pick<
  ReturnType<typeof createClerkClient>["users"],
  "getUser" | "getUserOauthAccessToken"
>;
const isGitHub = (provider: string) => provider === "github" || provider === "oauth_github";

/** Clerk owns verified sign-in identities and refreshes their OAuth credentials.
 * Always select by external account ID, never by email, login, or token order.
 */
export function clerkGitHubAccounts(users: ClerkUsers): GitHubAccounts {
  return {
    async list(userId) {
      const user = await users.getUser(userId);
      return user.externalAccounts
        .filter((account) => isGitHub(account.provider))
        .map((account) => ({
          id: account.id,
          login: account.username || account.providerUserId,
          state: account.verification?.status === "verified" ? "connected" : "needs_auth",
        }));
    },
    async credential(userId, accountId) {
      const user = await users.getUser(userId);
      const account = user.externalAccounts.find(
        (candidate) => candidate.id === accountId && isGitHub(candidate.provider),
      );
      if (!account || account.verification?.status !== "verified")
        throw new CloudError(
          "github_account_unlinked",
          "Reconnect the GitHub account selected for this repository",
          403,
        );
      const { data } = await users.getUserOauthAccessToken(userId, "github");
      const credential = data.find((candidate) => candidate.externalAccountId === account.id);
      if (!credential?.token)
        throw new CloudError(
          "github_needs_auth",
          "Reconnect this GitHub account to restore repository access",
          403,
        );
      return { id: account.id, providerUserId: account.providerUserId, token: credential.token };
    },
  };
}

export function createGitHubAccounts(secretKey: string): GitHubAccounts {
  return clerkGitHubAccounts(createClerkClient({ secretKey }).users);
}
