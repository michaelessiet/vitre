import { describe, expect, it } from "vite-plus/test";
import { makeCloudClient } from "./index.ts";

describe("cloud client", () => {
  it("resolves current login credentials for every request and disables redirects", async () => {
    let version = 0;
    const headers: string[] = [];
    const client = makeCloudClient({
      baseUrl: "https://cloud.example.com",
      accessToken: async () => `token-${++version}`,
      fetch: async (_, init) => {
        expect(init?.redirect).toBe("error");
        expect(init?.cache).toBe("no-store");
        headers.push(new Headers(init?.headers).get("authorization")!);
        return Response.json({
          environmentId: "cloud-task",
          httpBaseUrl: "https://worker.example.com/",
          bootstrapToken: "bootstrap",
        });
      },
    });
    await client.connection("task");
    await client.connection("task");
    expect(headers).toEqual(["Bearer token-1", "Bearer token-2"]);
  });
  it("rejects insecure endpoints, local filesystem paths and path traversal", async () => {
    expect(() =>
      makeCloudClient({ baseUrl: "http://localhost", accessToken: async () => "token" }),
    ).toThrow("HTTPS");
    const client = makeCloudClient({
      baseUrl: "https://cloud.example.com",
      accessToken: async () => "token",
      fetch: async () =>
        Response.json({
          environmentId: "task",
          httpBaseUrl: "file:///tmp/project",
          bootstrapToken: "secret",
        }),
    });
    await expect(client.connection("task")).rejects.toThrow("HTTPS");
    await expect(client.result("../local")).rejects.toThrow("task ID");
  });
  it("preserves the mutation idempotency key and server error code", async () => {
    const client = makeCloudClient({
      baseUrl: "https://cloud.example.com",
      accessToken: async () => "token",
      fetch: async (_, init) => {
        expect(JSON.parse(init?.body as string).idempotencyKey).toBe("cancel-once");
        return Response.json(
          {
            code: "worker_busy",
            message: "Worker is stopping",
            requestDisposition: "rejected",
            retryable: true,
          },
          { status: 409 },
        );
      },
    });
    await expect(
      client.command({ type: "task.cancel", taskId: "task", idempotencyKey: "cancel-once" }),
    ).rejects.toMatchObject({
      code: "worker_busy",
      status: 409,
      requestDisposition: "rejected",
      retryable: true,
    });
  });
  it("treats missing delivery disposition as unknown", async () => {
    const client = makeCloudClient({
      baseUrl: "https://cloud.example.com",
      accessToken: async () => "token",
      fetch: async () =>
        Response.json({ code: "gateway", message: "Disconnected" }, { status: 502 }),
    });
    await expect(client.repositories()).rejects.toMatchObject({ requestDisposition: "unknown" });
  });
  it("looks up public GitHub repositories through the relay without an installation", async () => {
    const calls: string[] = [];
    const client = makeCloudClient({
      baseUrl: "https://cloud.example.com",
      accessToken: async () => "token",
      fetch: async (url) => {
        calls.push(String(url));
        return Response.json(null);
      },
    });
    expect(await client.publicRepository("vercel-labs", "scriptc")).toBeNull();
    expect(calls).toEqual([
      "https://cloud.example.com/v1/cloud/repositories/public/vercel-labs/scriptc",
    ]);
  });
  it("starts and checks Codex device sign-in with the same cloud account", async () => {
    const calls: string[] = [];
    const client = makeCloudClient({
      baseUrl: "https://cloud.example.com",
      accessToken: async () => "token",
      fetch: async (url, init) => {
        calls.push(`${init?.method} ${String(url)}`);
        return Response.json(
          init?.method === "POST"
            ? { id: "login-1" }
            : {
                id: "login-1",
                state: "running",
                verificationUrl: "https://example.com/device",
                userCode: "ABCD-1234",
                error: null,
              },
        );
      },
    });
    expect((await client.startCodexLogin("login-key")).id).toBe("login-1");
    expect((await client.loginStatus("login-1")).userCode).toBe("ABCD-1234");
    expect(calls).toEqual([
      "POST https://cloud.example.com/v1/cloud/provider-login",
      "GET https://cloud.example.com/v1/cloud/provider-login/login-1",
    ]);
  });
});
