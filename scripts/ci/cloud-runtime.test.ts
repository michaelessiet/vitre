// @effect-diagnostics nodeBuiltinImport:off - Focused runtime deployment verification.
import { describe, expect, it } from "vite-plus/test";
import {
  runtimeKey,
  runtimeUrl,
  runtimeHealthMatches,
  validateRuntimeConfiguration,
  waitForRuntime,
} from "./cloud-runtime.ts";

const revision = "a".repeat(40);
const sha256 = "b".repeat(64);
const ready = { ready: true, protocol: 1, runtime: { revision, sha256, verified: true } };

describe("cloud runtime deployment", () => {
  it("uses immutable artifacts on a single HTTPS origin", () => {
    expect(runtimeUrl("https://artifacts.example.com", revision, sha256)).toBe(
      `https://artifacts.example.com/${runtimeKey(revision, sha256)}`,
    );
    expect(() => runtimeKey("main; echo bad", sha256)).toThrow();
    for (const url of [
      "http://example.com",
      "https://token@example.com",
      "https://example.com?token=secret",
      "https://example.com/releases",
    ])
      expect(() => runtimeUrl(url, revision, sha256)).toThrow();
  });
  it("requires artifact distribution and authenticated health without AWS credentials", () => {
    expect(validateRuntimeConfiguration({})).toHaveLength(5);
    expect(
      validateRuntimeConfiguration({
        VITRE_CLOUD_MACHINE_URL: "https://machine.example.com",
        VITRE_CLOUD_MACHINE_TOKEN: "machine-token",
        VITRE_CLOUD_ALLOWED_USER_ID: "user-a",
        VITRE_CLOUD_RUNTIME_BUCKET: "runtime",
        VITRE_CLOUD_RUNTIME_URL: "https://artifacts.example.com",
      }),
    ).toEqual([]);
  });
  it("requires authenticated readiness at the exact revision and checksum", () => {
    expect(runtimeHealthMatches(ready, revision, sha256)).toBe(true);
    for (const body of [
      null,
      {},
      { ...ready, ready: false },
      { ...ready, protocol: 2 },
      { ...ready, runtime: { revision, sha256, verified: false } },
      { ...ready, runtime: { revision: "c".repeat(40), sha256 } },
      { ...ready, runtime: { revision, sha256: "d".repeat(64) } },
    ])
      expect(runtimeHealthMatches(body, revision, sha256)).toBe(false);
  });
  it("waits through restart and an old runtime without accepting generic health", async () => {
    const responses = [
      new Response("restarting", { status: 503 }),
      Response.json({ ready: true, protocol: 1 }),
      Response.json(ready),
    ];
    await waitForRuntime({
      origin: "https://machine.example.com",
      token: "secret",
      owner: "user-a",
      revision,
      sha256,
      intervalMs: 0,
      fetcher: async (url, options) => {
        expect(String(url)).toBe("https://machine.example.com/v1/health");
        expect(options?.headers).toEqual({
          authorization: "Bearer secret",
          "x-vitre-owner": "user-a",
        });
        expect(options?.redirect).toBe("error");
        return responses.shift()!;
      },
    });
    expect(responses).toHaveLength(0);
  });
  it("fails on invalid credentials or a release that never arrives", async () => {
    const input = {
      origin: "https://machine.example.com",
      token: "secret",
      owner: "user-a",
      revision,
      sha256,
      intervalMs: 0,
      timeoutMs: 0,
    };
    await expect(
      waitForRuntime({ ...input, fetcher: async () => new Response("", { status: 401 }) }),
    ).rejects.toThrow("credentials were rejected");
    await expect(
      waitForRuntime({
        ...input,
        fetcher: async () => Response.json({ ready: true, protocol: 1 }),
      }),
    ).rejects.toThrow("not installed");
  });
});
