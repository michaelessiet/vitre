import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { computeExecutor, PersistentMachineClient } from "./compute.ts";
import * as Effect from "effect/Effect";
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});
const attemptId = "00000000-0000-4000-8000-000000000001-1";
const id = `machine-${attemptId}`;
const config = { url: "https://machine.example", token: "a".repeat(64), ownerId: "user-a" };
describe("provider-independent machine execution", () => {
  it.each([true, false, undefined])("preserves optional process state %s", async (running) => {
    const expected = { id, ...(running === undefined ? {} : { running }) };
    const client = new PersistentMachineClient(config, async () => Response.json(expected));
    expect(await client.get(id)).toEqual(expected);
  });
  it("works with runtimes that do not implement URL.parse", async () => {
    vi.spyOn(URL, "parse").mockImplementation(() => {
      throw new TypeError("URL.parse is unavailable");
    });
    const client = new PersistentMachineClient(config, async () => Response.json({ port: 20000 }));
    expect(await client.prepare(attemptId)).toEqual({ port: 20000 });
  });
  it("authenticates the assigned owner and stops only the attempt", async () => {
    const paths: string[] = [];
    const client = new PersistentMachineClient(config, async (input, init) => {
      paths.push(new URL(String(input)).pathname);
      expect(init?.headers).toMatchObject({
        "x-vitre-owner": "user-a",
        authorization: `Bearer ${config.token}`,
      });
      expect(init?.redirect).toBe("manual");
      return Response.json({ id, port: 20001 });
    });
    expect(await client.prepare(attemptId)).toEqual({ port: 20001 });
    await client.stop(id);
    await client.delete(id);
    expect(paths).toEqual([
      `/v1/attempts/${attemptId}/prepare`,
      `/v1/attempts/${attemptId}/stop`,
      `/v1/attempts/${attemptId}`,
    ]);
  });
  it("rejects insecure endpoints and mismatched attempt identities", async () => {
    const insecure = new PersistentMachineClient(
      { ...config, url: "http://machine.example" },
      async () => {
        throw Error("must not fetch");
      },
    );
    await expect(insecure.get(id)).rejects.toMatchObject({ code: "machine_not_configured" });
    const client = new PersistentMachineClient(config, async () =>
      Response.json({ id: "machine-other" }),
    );
    await expect(client.get(id)).rejects.toMatchObject({ code: "machine_identity_conflict" });
  });
  it("rejects redirects without forwarding the machine credential", async () => {
    const fetcher = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      expect(init?.redirect).toBe("manual");
      return new Response(null, { status: 302, headers: { location: "https://other.example" } });
    });
    const client = new PersistentMachineClient(config, fetcher);
    await expect(client.prepare(attemptId)).rejects.toMatchObject({ code: "machine_unavailable" });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it("treats absence as absence without swallowing failures", async () => {
    const missing = new PersistentMachineClient(
      config,
      async () => new Response(null, { status: 404 }),
    );
    expect(await missing.get(id)).toBeNull();
    const unavailable = new PersistentMachineClient(
      config,
      async () => new Response(null, { status: 503 }),
    );
    await expect(unavailable.get(id)).rejects.toMatchObject({ code: "machine_unavailable" });
  });
});

const cloudConfig = {
  enabled: true,
  allowedUserId: "user-a",
  controlUrl: "https://relay.example",
  encryptionKey: "unused",
  machine: config,
  github: { appId: "", privateKey: "", installationIds: [] },
  wake: () => Effect.void,
};

it("routes preparation, launch, inventory, and cleanup directly to the assigned machine", async () => {
  const calls: string[] = [];
  vi.stubGlobal("fetch", async (input: string | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    expect(url.hostname).toBe("machine.example");
    calls.push(`${init?.method ?? "GET"} ${url.pathname}`);
    if (url.pathname.endsWith("/prepare")) return Response.json({ port: 20000 });
    if (url.pathname === "/v1/attempts") return Response.json([{ id, attemptId }]);
    return Response.json({ id });
  });
  const executor = computeExecutor(cloudConfig);
  expect(await executor.prepare!(attemptId)).toEqual({ port: 20000 });
  expect(
    await executor.ensure(attemptId.slice(0, 36), {
      controlUrl: "https://relay.example",
      attemptId,
      token: "worker-token",
      deadlineAt: "2099-01-01T00:00:00Z",
    }),
  ).toEqual({ id });
  expect(await executor.owned()).toEqual([{ id, attemptId }]);
  await executor.stop(id);
  await executor.delete(id);
  expect(calls).toEqual([
    `POST /v1/attempts/${attemptId}/prepare`,
    `PUT /v1/attempts/${attemptId}`,
    "GET /v1/attempts",
    `POST /v1/attempts/${attemptId}/stop`,
    `DELETE /v1/attempts/${attemptId}`,
  ]);
});

it("fails closed without a machine and rejects unsupported executor identities without fetching", async () => {
  const fetcher = vi.fn();
  vi.stubGlobal("fetch", fetcher);
  const { machine: _assignedMachine, ...withoutMachine } = cloudConfig;
  const unconfigured = computeExecutor(withoutMachine);
  await expect(unconfigured.prepare!(attemptId)).rejects.toMatchObject({
    code: "machine_not_configured",
  });
  const assigned = computeExecutor(cloudConfig);
  await expect(assigned.get(`retired-${attemptId}`)).rejects.toMatchObject({
    code: "invalid_attempt",
  });
  expect(fetcher).not.toHaveBeenCalled();
});
