import { describe, expect, it } from "vite-plus/test";
import * as NodeCrypto from "node:crypto";
import { GitHubCloudClient } from "./github.ts";
import type { CloudTask, CloudPublication } from "@t3tools/contracts/cloud";

const repository = {
  id: "123",
  installationId: "456",
  owner: "owner",
  name: "repo",
  defaultBranch: "main",
  setupCommand: "",
  testCommand: "",
  revision: 1,
};
describe("cloud GitHub credentials", () => {
  it("validates canonical identity at registration and returns an actionable invalid-branch error", async () => {
    const client = new GitHubCloudClient(
      { appId: "", privateKey: "", installationIds: [] },
      async (url) =>
        String(url).includes("/commits/")
          ? new Response(null, { status: 404 })
          : Response.json({
              id: 123,
              private: false,
              owner: { login: "Owner" },
              name: "Repo",
              default_branch: "trunk",
            }),
    );
    const publicRepo = { ...repository, installationId: "public" };
    expect(await client.verifyRepository(publicRepo, 0)).toMatchObject({
      id: "123",
      owner: "Owner",
      name: "Repo",
      defaultBranch: "trunk",
    });
    await expect(client.verifyRepository({ ...publicRepo, id: "999" }, 0)).rejects.toMatchObject({
      code: "repository_access",
    });
    await expect(
      client.verifyRepository({ ...publicRepo, name: "different" }, 0),
    ).rejects.toMatchObject({ code: "repository_access" });
    await expect(client.resolve(publicRepo, "missing/branch", 0)).rejects.toMatchObject({
      code: "invalid_branch",
      status: 400,
    });
    await expect(client.verifyRepository(repository, 0)).rejects.toMatchObject({
      code: "repository_access",
    });
  });
  it("reconciles a successful PR after its response was lost without publishing twice", async () => {
    const keys = NodeCrypto.generateKeyPairSync("rsa", { modulusLength: 2048 });
    let writes = 0;
    const pulls: unknown[] = [];
    const commit = "a".repeat(40);
    const client = new GitHubCloudClient(
      {
        appId: "789",
        privateKey: keys.privateKey.export({ format: "pem", type: "pkcs1" }).toString(),
        installationIds: ["456"],
      },
      async (url, init) => {
        if (String(url).includes("access_tokens")) return Response.json({ token: "write-token" });
        if (init?.method === "GET") return Response.json(pulls);
        writes++;
        expect(JSON.parse(init!.body as string)).toMatchObject({
          draft: true,
          body: "Approved body",
        });
        pulls.push({
          html_url: "https://github.com/owner/repo/pull/1",
          head: { sha: commit },
          base: { ref: "main" },
          title: "Approved title",
          body: "Approved body",
        });
        throw new Error("Response lost");
      },
    );
    const task = { repository, branch: "vitre/task", baseBranch: "main" } as CloudTask;
    const publication = {
      kind: "pull_request",
      title: "Approved title",
      body: "Approved body",
    } as CloudPublication;
    await expect(client.publish(task, publication, commit, 0, true)).rejects.toThrow(
      "Response lost",
    );
    expect(await client.publish(task, publication, commit, 0, false)).toContain("pull/1");
    expect(await client.publish(task, publication, commit, 0, true)).toContain("pull/1");
    expect(writes).toBe(1);
  });
  it("does not retry an ambiguous comment write when reconciliation finds nothing", async () => {
    const keys = NodeCrypto.generateKeyPairSync("rsa", { modulusLength: 2048 });
    let writes = 0;
    const client = new GitHubCloudClient(
      {
        appId: "789",
        privateKey: keys.privateKey.export({ format: "pem", type: "pkcs1" }).toString(),
        installationIds: ["456"],
      },
      async (url, init) => {
        if (String(url).includes("access_tokens")) return Response.json({ token: "write-token" });
        if (init?.method === "POST") writes++;
        return Response.json([]);
      },
    );
    await expect(
      client.publish(
        { repository, issueNumber: 1 } as CloudTask,
        { kind: "issue_comment", body: "exact approved body" } as CloudPublication,
        null,
        0,
        false,
      ),
    ).rejects.toThrow("uncertain");
    expect(writes).toBe(0);
  });
  it("accepts GitHub's PKCS#1 keys and scopes execution tokens to read-only access to one repository", async () => {
    const keys = NodeCrypto.generateKeyPairSync("rsa", { modulusLength: 2048 });
    const client = new GitHubCloudClient(
      {
        appId: "789",
        privateKey: keys.privateKey.export({ format: "pem", type: "pkcs1" }).toString(),
        installationIds: ["456"],
      },
      async (_, init) => {
        expect(JSON.parse(init!.body as string)).toEqual({
          repository_ids: [123],
          permissions: {
            contents: "read",
            metadata: "read",
            issues: "read",
            pull_requests: "read",
          },
        });
        const jwt = new Headers(init!.headers).get("authorization")!.slice(7);
        const [header, claims, signature] = jwt.split(".");
        expect(
          NodeCrypto.verify(
            "RSA-SHA256",
            Buffer.from(`${header}.${claims}`),
            keys.publicKey,
            Buffer.from(signature!, "base64url"),
          ),
        ).toBe(true);
        expect(init!.redirect).toBe("manual");
        return Response.json({ token: "read-only-installation-token" });
      },
    );
    expect(await client.repositoryToken(repository, 1_000_000)).toBe(
      "read-only-installation-token",
    );
  });
  it("rejects installations outside the personal allowlist before requesting credentials", async () => {
    const client = new GitHubCloudClient(
      { appId: "789", privateKey: "", installationIds: [] },
      async () => {
        throw new Error("Must not make a request");
      },
    );
    await expect(client.repositoryToken(repository, 1_000_000)).rejects.toThrow("not allowlisted");
  });
});

it("resolves public repositories without app credentials or Authorization headers", async () => {
  const calls: string[] = [];
  const client = new GitHubCloudClient(
    { appId: "", privateKey: "", installationIds: [] },
    async (url, init) => {
      calls.push(String(url));
      expect(new Headers(init?.headers).has("authorization")).toBe(false);
      return Response.json(
        String(url).includes("/commits/")
          ? { sha: "a".repeat(40) }
          : {
              id: 123,
              private: false,
              owner: { login: "owner" },
              name: "repo",
              default_branch: "main",
            },
      );
    },
  );
  const publicRepo = await client.publicRepository("owner", "repo");
  expect(publicRepo?.installationId).toBe("public");
  expect(await client.resolve(publicRepo!, "main", 0)).toEqual({ sha: "a".repeat(40), token: "" });
  await expect(client.resolve(repository, "main", 0)).rejects.toThrow("not allowlisted");
  expect(calls.some((url) => url.includes("/app/"))).toBe(false);
  await expect(client.repositoryToken(publicRepo!, 0, "write")).rejects.toThrow("not allowlisted");
});

it("does not treat private, missing or unverified repositories as public", async () => {
  const client = new GitHubCloudClient(
    { appId: "", privateKey: "", installationIds: [] },
    async () => new Response(null, { status: 404 }),
  );
  expect(await client.publicRepository("owner", "private")).toBeNull();
  await expect(
    client.resolve({ ...repository, installationId: "public" }, "main", 0),
  ).rejects.toThrow("no longer public");
  const invalid = new GitHubCloudClient(
    { appId: "", privateKey: "", installationIds: [] },
    async () => Response.json({ id: 123, private: true }),
  );
  await expect(invalid.publicRepository("owner", "private")).rejects.toThrow("did not verify");
});

it("still uses an installation token for private repository access", async () => {
  const keys = NodeCrypto.generateKeyPairSync("rsa", { modulusLength: 2048 });
  let anonymous = 0;
  const client = new GitHubCloudClient(
    {
      appId: "789",
      privateKey: keys.privateKey.export({ format: "pem", type: "pkcs1" }).toString(),
      installationIds: ["456"],
    },
    async (url, init) => {
      const auth = new Headers(init?.headers).get("authorization");
      if (!auth) {
        anonymous++;
        return new Response(null, { status: 404 });
      }
      if (String(url).includes("/access_tokens"))
        return Response.json({ token: "private-read-token" });
      expect(auth).toBe("Bearer private-read-token");
      return Response.json(
        String(url).includes("/commits/") ? { sha: "b".repeat(40) } : { id: 123 },
      );
    },
  );
  expect(await client.resolve(repository, "main", 0)).toEqual({
    sha: "b".repeat(40),
    token: "private-read-token",
  });
  expect(anonymous).toBe(0);
});

it("uses connected access even when anonymous GitHub requests are rate limited", async () => {
  const keys = NodeCrypto.generateKeyPairSync("rsa", { modulusLength: 2048 });
  const client = new GitHubCloudClient(
    {
      appId: "789",
      privateKey: keys.privateKey.export({ format: "pem", type: "pkcs1" }).toString(),
      installationIds: ["456"],
    },
    async (url, init) => {
      const auth = new Headers(init?.headers).get("authorization");
      if (!auth) throw new Error("Anonymous GitHub quota exhausted");
      if (String(url).includes("access_tokens")) return Response.json({ token: "scoped-read" });
      expect(auth).toBe("Bearer scoped-read");
      return Response.json(
        String(url).includes("/commits/") ? { sha: "c".repeat(40) } : { id: 123 },
      );
    },
  );
  expect(await client.resolve(repository, "main", 1_000_000)).toEqual({
    sha: "c".repeat(40),
    token: "scoped-read",
  });
  await expect(client.readAccess({ ...repository, id: "999" }, 1_000_000)).rejects.toMatchObject({
    code: "repository_changed",
  });
});
