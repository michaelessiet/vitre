import { describe, expect, it, vi } from "vite-plus/test";
import { clerkGitHubAccounts } from "./githubAccounts.ts";

describe("GitHub identities on one Vitre account", () => {
  const externalAccounts = [
    {
      id: "personal",
      provider: "github",
      providerUserId: "10",
      username: "personal-login",
      verification: { status: "verified" },
    },
    {
      id: "work",
      provider: "oauth_github",
      providerUserId: "20",
      username: "work-login",
      verification: { status: "verified" },
    },
    { id: "google", provider: "google", verification: { status: "verified" } },
  ];
  function fixture(accounts = externalAccounts) {
    const users = {
      getUser: vi.fn(async () => ({ externalAccounts: accounts })),
      getUserOauthAccessToken: vi.fn(async () => ({
        data: [
          { externalAccountId: "work", token: "work-secret" },
          { externalAccountId: "personal", token: "personal-secret" },
        ],
      })),
    };
    return {
      users,
      service: clerkGitHubAccounts(users as unknown as Parameters<typeof clerkGitHubAccounts>[0]),
    };
  }
  it("lists both identities by the canonical Vitre user, without credentials", async () => {
    const { users, service } = fixture();
    expect(await service.list("vitre-user")).toEqual([
      { id: "personal", login: "personal-login", state: "connected" },
      { id: "work", login: "work-login", state: "connected" },
    ]);
    expect(users.getUser).toHaveBeenCalledWith("vitre-user");
    expect(users.getUserOauthAccessToken).not.toHaveBeenCalled();
  });
  it("selects the exact linked identity independent of token order or sign-in method", async () => {
    const { service, users } = fixture();
    expect(await service.credential("vitre-user", "personal")).toEqual({
      id: "personal",
      providerUserId: "10",
      token: "personal-secret",
    });
    expect(await service.credential("vitre-user", "work")).toEqual({
      id: "work",
      providerUserId: "20",
      token: "work-secret",
    });
    expect(users.getUserOauthAccessToken).toHaveBeenCalledWith("vitre-user", "github");
  });
  it("never falls back to another identity when the selected one was unlinked or unverified", async () => {
    const { service, users } = fixture(externalAccounts.filter((account) => account.id !== "work"));
    await expect(service.credential("vitre-user", "work")).rejects.toThrow("Reconnect");
    expect(users.getUserOauthAccessToken).not.toHaveBeenCalled();
    const pending = fixture([{ ...externalAccounts[0]!, verification: { status: "unverified" } }]);
    await expect(pending.service.credential("vitre-user", "personal")).rejects.toThrow("Reconnect");
  });
});
