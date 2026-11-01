import { describe, expect, it } from "vite-plus/test";
import * as NodeCrypto from "node:crypto";
import { GitHubCloudClient } from "./github.ts";
import type { CloudRepository } from "@t3tools/contracts/cloud";
const privateKey = NodeCrypto.generateKeyPairSync("rsa", { modulusLength: 2048 })
  .privateKey.export({ format: "pem", type: "pkcs8" })
  .toString();
const repository: CloudRepository = {
  id: "42",
  installationId: "123",
  githubAccountId: "work",
  owner: "org",
  name: "repo",
  defaultBranch: "main",
  setupCommand: "",
  testCommand: "",
  revision: 0,
};
function fixture({ push = true, identity = 2, id = 42 } = {}) {
  const minted: unknown[] = [],
    requested: string[] = [];
  const client = new GitHubCloudClient(
    {
      appId: "999",
      privateKey,
      installationIds: [],
      accounts: {
        list: async () => [
          { id: "personal", login: "person", state: "connected" },
          { id: "work", login: "work", state: "connected" },
        ],
        credential: async (userId, accountId) => {
          expect(userId).toBe("vitre");
          return {
            id: accountId,
            providerUserId: accountId === "work" ? "2" : "1",
            token: accountId,
          };
        },
      },
    },
    async (url, init) => {
      const path = new URL(String(url)).pathname;
      const token = new Headers(init?.headers).get("authorization");
      requested.push(path);
      const value =
        path === "/user"
          ? { id: token === "Bearer work" ? identity : 1 }
          : path === "/repos/org/repo"
            ? { id, permissions: { pull: true, push } }
            : path === "/user/repos"
              ? [{ id: token === "Bearer work" ? 42 : 43, permissions: { pull: true } }]
              : path === "/app/installations"
                ? [{ id: 123, suspended_at: null }]
                : path === "/installation/repositories"
                  ? {
                      repositories: [
                        { id: 42, owner: { login: "org" }, name: "repo", default_branch: "main" },
                        {
                          id: 44,
                          owner: { login: "secret" },
                          name: "unrelated",
                          default_branch: "main",
                        },
                      ],
                    }
                  : path.endsWith("/access_tokens")
                    ? (minted.push(JSON.parse(String(init?.body))), { token: "scoped-token" })
                    : null;
      if (!value) throw new Error(`Unexpected request ${path}`);
      return Response.json(value);
    },
    "vitre",
  );
  return { client, minted, requested };
}
describe("linked repository access", () => {
  it("rejects an account attached to an anonymous public repository", async () => {
    const { client, requested } = fixture();
    await expect(
      client.verifyRepository({ ...repository, installationId: "public" }, 0),
    ).rejects.toThrow("Select a GitHub installation");
    expect(requested).toEqual([]);
  });
  it("intersects each user's repositories with Vitre installations", async () => {
    const { client } = fixture();
    expect(await client.repositories(0)).toEqual([repository]);
  });
  it("loads paginated user and installation access concurrently before intersecting them", async () => {
    let releaseInstallation = () => {};
    const installationStarted = new Promise<void>((resolve) => {
      releaseInstallation = resolve;
    });
    const pages: string[] = [];
    const client = new GitHubCloudClient(
      {
        appId: "999",
        privateKey,
        installationIds: [],
        accounts: {
          list: async () => [{ id: "work", login: "work", state: "connected" }],
          credential: async () => ({ id: "work", providerUserId: "2", token: "user-token" }),
        },
      },
      async (url) => {
        const request = new URL(String(url));
        const path = request.pathname;
        const page = request.searchParams.get("page");
        if (path === "/user") return Response.json({ id: 2 });
        if (path === "/app/installations") return Response.json([{ id: 123, suspended_at: null }]);
        if (path.endsWith("/access_tokens")) return Response.json({ token: "app-token" });
        pages.push(path + ":" + page);
        if (path === "/user/repos") {
          // A serial implementation cannot reach the installation fetch that releases this.
          await installationStarted;
          return Response.json(
            page === "1"
              ? Array.from({ length: 100 }, (_, index) => ({
                  id: 1000 + index,
                  permissions: { pull: true },
                }))
              : [{ id: 42, permissions: { pull: true } }],
          );
        }
        if (path === "/installation/repositories") {
          releaseInstallation();
          return Response.json({
            repositories: (page === "1"
              ? Array.from({ length: 100 }, (_, i) => 2000 + i)
              : [42, 44]
            ).map((id) => ({ id, owner: { login: "org" }, name: "repo", default_branch: "main" })),
          });
        }
        throw new Error("Unexpected request " + path);
      },
      "vitre",
    );
    expect(await client.repositories(0)).toEqual([repository]);
    expect(pages).toEqual(
      expect.arrayContaining([
        "/user/repos:1",
        "/user/repos:2",
        "/installation/repositories:1",
        "/installation/repositories:2",
      ]),
    );
  });
  it("does not expose installation results when concurrent identity verification fails", async () => {
    await expect(fixture({ identity: 3 }).client.repositories(0)).rejects.toMatchObject({
      code: "github_identity_changed",
    });
  });
  it("rechecks the selected account and issues a repository-scoped read token", async () => {
    const { client, minted } = fixture();
    expect(await client.repositoryToken(repository, 0)).toBe("scoped-token");
    expect(minted).toEqual([
      {
        repository_ids: [42],
        permissions: { contents: "read", metadata: "read", issues: "read", pull_requests: "read" },
      },
    ]);
  });
  it("refuses publishing without user push permission, even if the app can write", async () => {
    const { client, minted } = fixture({ push: false });
    await expect(client.repositoryToken(repository, 0, "write")).rejects.toThrow(
      "required repository access",
    );
    expect(minted).toEqual([]);
  });
  it.each([{ identity: 3 }, { id: 99 }])(
    "rejects a changed immutable identity before minting tokens: %j",
    async (options) => {
      const { client, minted } = fixture(options);
      await expect(client.repositoryToken(repository, 0)).rejects.toThrow();
      expect(minted).toEqual([]);
    },
  );
  it("does not silently select a different account when saving", async () => {
    await expect(
      fixture().client.verifyRepository({ ...repository, githubAccountId: "personal" }, 0),
    ).rejects.toThrow("unavailable");
  });
});
