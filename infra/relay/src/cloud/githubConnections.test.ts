import { expect, vi } from "vite-plus/test";
import { it } from "@effect/vitest";
import * as NodeCrypto from "node:crypto";
import { GitHubConnections, githubConnectionsForRequest } from "./githubConnections.ts";
import { githubForRequest } from "./github.ts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import { CloudError } from "./policy.ts";
import { CredentialVault } from "./crypto.ts";
import { emptyDocument, type CloudAccountDocument } from "./store.ts";

it.effect(
  "binds database operations to each calling request instead of a cached configuration context",
  () =>
    Effect.gen(function* () {
      const RequestName = Context.Reference("test/github/request-name", {
        defaultValue: () => "outside-request",
      });
      const seen: string[] = [];
      const clerk = {
        list: async () => [],
        credential: async () => ({ id: "primary", providerUserId: "1", token: "token" }),
      };
      const store = {
        read: () =>
          Effect.map(RequestName, (name) => {
            seen.push(name);
            return emptyDocument();
          }),
        mutate: <A>(_user: string, reduce: (doc: CloudAccountDocument) => A) =>
          Effect.map(RequestName, (name) => {
            seen.push(name);
            return reduce(emptyDocument());
          }),
        users: Effect.succeed([]),
      };
      const base = { appId: "42", privateKey: "unused", installationIds: [] };
      const config = {
        ...base,
        accounts: clerk,
        accountsForRequest: githubConnectionsForRequest(
          clerk,
          base,
          store,
          new CredentialVault(btoa("x".repeat(32))),
        ),
      };
      const request = (name: string) =>
        Effect.gen(function* () {
          const resolved = yield* githubForRequest(config);
          yield* Effect.promise(() => resolved.accounts!.list("owner"));
          yield* Effect.promise(() =>
            resolved.accounts!.connection!("owner", { type: "disconnect", accountId: "gha_123" }),
          );
        }).pipe(Effect.provideService(RequestName, name));
      yield* request("first");
      yield* request("second");
      expect(seen).toEqual(["first", "first", "second", "second"]);
    }),
);
it.effect("preserves typed persistence failures across the request-bound Promise adapter", () =>
  Effect.gen(function* () {
    const failure = new CloudError("persistence_unavailable", "Try again", 503);
    const accounts = yield* githubConnectionsForRequest(
      {
        list: async () => [],
        credential: async () => ({ id: "primary", providerUserId: "1", token: "token" }),
      },
      { appId: "42", privateKey: "unused", installationIds: [] },
      {
        read: () => Effect.fail(failure),
        mutate: () => Effect.fail(failure),
        users: Effect.succeed([]),
      },
      new CredentialVault(btoa("x".repeat(32))),
    );
    yield* Effect.promise(() => expect(accounts.list("owner")).rejects.toBe(failure));
  }),
);
const privateKey = NodeCrypto.generateKeyPairSync("rsa", { modulusLength: 2048 })
  .privateKey.export({ format: "pem", type: "pkcs1" })
  .toString();
function fixture(responses: Record<string, Response> = {}) {
  let now = 2_000_000_000_000;
  const documents = new Map<string, CloudAccountDocument>();
  const store = {
    async read(user: string) {
      return structuredClone(documents.get(user) ?? emptyDocument());
    },
    async mutate<A>(user: string, reduce: (doc: CloudAccountDocument) => A) {
      const next = structuredClone(documents.get(user) ?? emptyDocument());
      const result = reduce(next);
      documents.set(user, next);
      return structuredClone(result);
    },
  };
  let oauth: () => Promise<Record<string, unknown>> = async () => ({
    access_token: "github-access-secret",
    expires_in: 28800,
    refresh_token: "github-refresh-secret",
    refresh_token_expires_in: 15897600,
  });
  const fetcher = vi.fn<typeof fetch>(async (url, init) => {
    // Match the Workers runtime rather than Node's broader Fetch implementation.
    if (init?.redirect === "error") throw new TypeError("Unsupported redirect mode");
    if (responses[String(url)]) return responses[String(url)]!.clone();
    if (String(url) === "https://api.github.com/app")
      return Response.json({ id: 42, client_id: "Iv1example" });
    if (String(url).endsWith("/device/code")) {
      expect(new URLSearchParams(init!.body as URLSearchParams).get("scope")).toBe(
        "offline_access",
      );
      return Response.json({
        device_code: "private-device-code",
        user_code: "ABCD-EFGH",
        verification_uri: "https://github.com/login/device",
        expires_in: 900,
        interval: 5,
      });
    }
    if (String(url).endsWith("/oauth/access_token")) return Response.json(await oauth());
    if (String(url) === "https://api.github.com/user")
      return Response.json({ id: 123, login: "personal" });
    throw Error("Unexpected request: " + String(url));
  });
  const clerk = {
    list: vi.fn(async () => [
      { id: "eac-primary", login: "personal", state: "connected" as const },
    ]),
    credential: vi.fn(async () => ({
      id: "eac-primary",
      providerUserId: "123",
      token: "clerk-token",
    })),
  };
  const service = new GitHubConnections(
    clerk,
    { appId: "42", privateKey, installationIds: [] },
    store,
    new CredentialVault(btoa("x".repeat(32))),
    fetcher,
    () => now,
  );
  const advance = (ms: number) => {
    now += ms;
  };
  const connect = async () => {
    await service.connection("owner", { type: "start", requestId: "request" });
    advance(5000);
    return service.connection("owner", { type: "poll", requestId: "request" });
  };
  return {
    service,
    documents,
    fetcher,
    clerk,
    advance,
    connect,
    setOAuth: (fn: typeof oauth) => {
      oauth = fn;
    },
  };
}
it("starts once per request and exposes only the user-facing code, with encrypted device credentials", async () => {
  const f = fixture();
  const first = await f.service.connection("owner", { type: "start", requestId: "request" });
  expect(first).toMatchObject({
    status: "pending",
    userCode: "ABCD-EFGH",
    verificationUri: "https://github.com/login/device",
  });
  expect(await f.service.connection("owner", { type: "start", requestId: "request" })).toEqual(
    first,
  );
  expect(f.fetcher).toHaveBeenCalledTimes(2);
  expect(JSON.stringify(first)).not.toContain("private-device-code");
  expect(JSON.stringify(f.documents.get("owner"))).not.toContain("private-device-code");
});
it("rejects an OAuth redirect without following it or leaving a stuck connection", async () => {
  const f = fixture({
    "https://github.com/login/device/code": new Response("Redirect", {
      status: 302,
      headers: { Location: "https://untrusted.example/authorize" },
    }),
  });
  await expect(
    f.service.connection("owner", { type: "start", requestId: "request" }),
  ).rejects.toMatchObject({ code: "github_invalid_response", status: 502 });
  expect(f.documents.get("owner")?.private.githubConnectionFlows?.request).toBeUndefined();
  expect(f.fetcher.mock.calls.map(([url]) => String(url))).toEqual([
    "https://api.github.com/app",
    "https://github.com/login/device/code",
  ]);
  expect(f.fetcher.mock.calls[1]![1]?.redirect).toBe("manual");
});
it.each(["https://github.com/login/oauth/access_token", "https://api.github.com/user"])(
  "rejects a redirect from %s without connecting an account",
  async (url) => {
    const f = fixture({
      [url]: new Response("Redirect", {
        status: 302,
        headers: { Location: "https://untrusted.example/token" },
      }),
    });
    await expect(f.connect()).rejects.toMatchObject({ status: 502 });
    expect(f.documents.get("owner")?.private.githubConnections).toBeUndefined();
    expect(f.fetcher.mock.calls.at(-1)?.[0]).toBe(url);
    expect(f.fetcher.mock.calls.at(-1)?.[1]?.redirect).toBe("manual");
  },
);
it("refuses cross-user polling and credentials and rejects expired device codes", async () => {
  const f = fixture();
  await f.service.connection("owner", { type: "start", requestId: "request" });
  await expect(
    f.service.connection("other", { type: "poll", requestId: "request" }),
  ).rejects.toMatchObject({ code: "github_connection_expired" });
  await expect(f.service.credential("other", "gha_123")).rejects.toMatchObject({
    code: "github_account_unlinked",
  });
  f.advance(900_001);
  await expect(
    f.service.connection("owner", { type: "poll", requestId: "request" }),
  ).rejects.toMatchObject({ code: "github_connection_expired" });
  expect(f.fetcher).toHaveBeenCalledTimes(2);
});
it("honors the polling interval and GitHub slow_down without duplicate OAuth requests", async () => {
  const f = fixture();
  await f.service.connection("owner", { type: "start", requestId: "request" });
  await f.service.connection("owner", { type: "poll", requestId: "request" });
  expect(f.fetcher).toHaveBeenCalledTimes(2);
  f.advance(5000);
  f.setOAuth(async () => ({ error: "slow_down" }));
  expect(await f.service.connection("owner", { type: "poll", requestId: "request" })).toMatchObject(
    { pollAfterMs: 10_000 },
  );
  await f.service.connection("owner", { type: "poll", requestId: "request" });
  expect(f.fetcher).toHaveBeenCalledTimes(3);
});
it("verifies the GitHub identity, returns repeatable completion, and keeps sign-in separate", async () => {
  const f = fixture();
  const result = await f.connect();
  expect(result).toMatchObject({
    status: "connected",
    account: { id: "gha_123", login: "personal" },
  });
  const calls = f.fetcher.mock.calls.length;
  expect(await f.service.connection("owner", { type: "poll", requestId: "request" })).toEqual(
    result,
  );
  expect(f.fetcher).toHaveBeenCalledTimes(calls);
  expect(await f.service.credential("owner", "gha_123")).toMatchObject({
    providerUserId: "123",
    token: "github-access-secret",
  });
  expect(await f.service.credential("owner", "eac-primary")).toMatchObject({
    token: "clerk-token",
  });
  expect(await f.service.list("owner")).toHaveLength(2);
  expect(JSON.stringify(f.documents.get("owner"))).not.toContain("github-access-secret");
  expect(JSON.stringify(f.documents.get("owner"))).not.toContain("github-refresh-secret");
  await f.service.connection("owner", { type: "disconnect", accountId: "gha_123" });
  await expect(f.service.credential("owner", "gha_123")).rejects.toMatchObject({
    code: "github_account_unlinked",
  });
  expect(await f.service.list("owner")).toHaveLength(1);
});
it("refreshes an expiring device-flow credential without a client secret", async () => {
  const f = fixture();
  await f.connect();
  f.advance(28800_000);
  f.setOAuth(async () => ({
    access_token: "new-access",
    expires_in: 28800,
    refresh_token: "new-refresh",
    refresh_token_expires_in: 15897600,
  }));
  expect(await f.service.credential("owner", "gha_123")).toMatchObject({ token: "new-access" });
  const params = new URLSearchParams(f.fetcher.mock.calls.at(-1)![1]!.body as URLSearchParams);
  expect(Object.fromEntries(params)).toEqual({
    client_id: "Iv1example",
    grant_type: "refresh_token",
    refresh_token: "github-refresh-secret",
  });
  expect(JSON.stringify(f.documents.get("owner"))).not.toContain("new-refresh");
});
it("serializes refresh and never resurrects a disconnected account after a response arrives", async () => {
  const f = fixture();
  await f.connect();
  f.advance(28800_000);
  let release!: (value: Record<string, unknown>) => void;
  let entered!: () => void;
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  f.setOAuth(() => {
    entered();
    return new Promise((resolve) => {
      release = resolve;
    });
  });
  const pending = f.service.credential("owner", "gha_123");
  await started;
  await expect(f.service.credential("owner", "gha_123")).rejects.toMatchObject({
    code: "github_refresh_in_progress",
  });
  await f.service.connection("owner", { type: "disconnect", accountId: "gha_123" });
  release({
    access_token: "new-access",
    expires_in: 28800,
    refresh_token: "new-refresh",
    refresh_token_expires_in: 15897600,
  });
  await expect(pending).rejects.toMatchObject({ code: "github_account_unlinked" });
  expect(f.documents.get("owner")!.private.githubConnections).toEqual({});
});
it("binds encrypted credentials to their owner and limits uncompleted authorizations", async () => {
  const f = fixture();
  await f.connect();
  f.documents.set("other", structuredClone(f.documents.get("owner")!));
  await expect(f.service.credential("other", "gha_123")).rejects.toMatchObject({
    code: "credential_unavailable",
  });
  for (let i = 0; i < 4; i++)
    await f.service.connection("owner", { type: "start", requestId: "request-" + i });
  await expect(
    f.service.connection("owner", { type: "start", requestId: "overflow" }),
  ).rejects.toMatchObject({ code: "github_connection_limit" });
});
it("does not accept an untrusted verification URL or an unexpected GitHub App identity", async () => {
  const f = fixture();
  f.fetcher.mockImplementation(async (url) =>
    String(url).endsWith("/app")
      ? Response.json({ id: 42, client_id: "Iv1example" })
      : Response.json({
          device_code: "secret",
          user_code: "ABCD",
          verification_uri: "https://attacker.example",
          expires_in: 900,
          interval: 5,
        }),
  );
  await expect(
    f.service.connection("owner", { type: "start", requestId: "request" }),
  ).rejects.toMatchObject({ code: "github_invalid_response" });
  expect(f.documents.get("owner")!.private.githubConnectionFlows).toEqual({});
  f.fetcher.mockImplementation(async () => Response.json({ id: 43, client_id: "Iv1different" }));
  await expect(
    f.service.connection("owner", { type: "start", requestId: "request" }),
  ).rejects.toMatchObject({ code: "github_invalid_response" });
});
