import { describe, expect, it, vi } from "vite-plus/test";
import {
  deploymentAllowed,
  lastSuccessfulDeployment,
  relayChanges,
  validateRelayConfiguration,
} from "./relay.ts";

const allowed = {
  enabled: "true",
  event: "push",
  ref: "refs/heads/main",
  result: "success",
  candidate: "commit",
  sha: "commit",
};
const configuration = {
  RELAY_STACK_NAME: "ExistingVitreRelay",
  RELAY_STAGE: "existing-stage",
  RELAY_PERSONAL_DEPLOYMENT: "true",
  RELAY_MOBILE_ENABLED: "false",
  VITRE_CLOUD_ENABLED: "false",
  CLOUDFLARE_ACCOUNT_ID: "account",
  CLOUDFLARE_API_TOKEN: "private-token",
  AXIOM_ORG_ID: "org",
  AXIOM_TOKEN: "private-token",
  RELAY_API_ZONE_NAME: "example.com",
  RELAY_TUNNEL_ZONE_NAME: "workers.example.com",
  RELAY_DATABASE_ADMIN_URL: "private-admin-url",
  RELAY_DATABASE_URL: "private-runtime-url",
  CLERK_PUBLISHABLE_KEY: "public-key",
  CLERK_SECRET_KEY: "private-clerk-key",
  CLERK_JWT_AUDIENCE: "existing-audience",
};

describe("deployment eligibility", () => {
  it("allows only the exact validated main push", () => {
    expect(deploymentAllowed(allowed)).toBe(true);
    for (const override of [
      { enabled: "false" },
      { event: "pull_request" },
      { event: "workflow_dispatch" },
      { ref: "refs/heads/feature" },
      { result: "failure" },
      { result: "cancelled" },
      { result: "skipped" },
      { candidate: "another-commit" },
      { sha: undefined },
    ])
      expect(deploymentAllowed({ ...allowed, ...override })).toBe(false);
  });

  it("deploys validated main by default and supports an explicit emergency pause", () => {
    expect(deploymentAllowed({ ...allowed, enabled: undefined })).toBe(true);
    expect(deploymentAllowed({ ...allowed, enabled: "" })).toBe(true);
    expect(deploymentAllowed({ ...allowed, enabled: "false" })).toBe(false);
  });

  it("coordinates runtime updates for worker and backend changes", () => {
    for (const path of [
      "scripts/vitre/cloud/lens.mjs",
      "apps/server/src/cloud.ts",
      "packages/contracts/src/model.ts",
    ]) {
      const result = relayChanges("head", "deployed", (args) =>
        args[0] === "merge-base" ? "deployed" : `${path}\0`,
      );
      expect(result).toMatchObject({ deploy: true, runtime: true });
    }
    expect(
      relayChanges("head", "deployed", (args) =>
        args[0] === "merge-base" ? "deployed" : "infra/relay/src/worker.ts\0",
      ),
    ).toMatchObject({ deploy: true, runtime: false });
  });

  it("compares cumulatively to the deployed revision, including after unrelated pushes", () => {
    const runGit = vi.fn((args: string[]) =>
      args[0] === "merge-base" ? "deployed\n" : "infra/relay/src/worker.ts\0README.md\0",
    );
    expect(relayChanges("docs-after-relay-change", "deployed", runGit).deploy).toBe(true);
    expect(runGit).toHaveBeenCalledWith([
      "diff",
      "--name-only",
      "--no-renames",
      "-z",
      "deployed",
      "docs-after-relay-change",
      "--",
    ]);
  });

  it("skips unchanged relay inputs and superseded or already deployed commits", () => {
    expect(
      relayChanges("head", "deployed", (args) =>
        args[0] === "merge-base" ? "deployed" : "docs/release.md\0",
      ).deploy,
    ).toBe(false);
    expect(relayChanges("older", "newer", () => "older").deploy).toBe(false);
    expect(
      relayChanges("same", "same", () => {
        throw new Error("should not inspect Git");
      }).deploy,
    ).toBe(false);
  });

  it("requires deployment without a baseline and fails closed for missing or divergent history", () => {
    expect(relayChanges("head", null).deploy).toBe(true);
    expect(() => relayChanges("head", "deployed", () => "unrelated-base")).toThrow("diverges");
    expect(() =>
      relayChanges("head", "missing", () => {
        throw new Error("missing history");
      }),
    ).toThrow("missing history");
  });

  it("ignores failed and active deployments and accepts a previously successful inactive deployment", async () => {
    const request = vi
      .fn()
      .mockResolvedValueOnce([
        { id: 3, sha: "active" },
        { id: 2, sha: "failed" },
        { id: 1, sha: "good" },
      ])
      .mockResolvedValueOnce([{ state: "in_progress" }])
      .mockResolvedValueOnce([{ state: "failure" }])
      .mockResolvedValueOnce([{ state: "inactive" }, { state: "success" }]);
    expect(await lastSuccessfulDeployment({ request }, "owner/repo")).toBe("good");
  });

  it("paginates deployments instead of losing an older successful baseline", async () => {
    const request = vi.fn(async (_method: string, path: string) => {
      if (path.includes("/statuses"))
        return path.includes("/101/") ? [{ state: "success" }] : [{ state: "failure" }];
      if (path.endsWith("page=1"))
        return Array.from({ length: 100 }, (_, id) => ({ id, sha: `failed-${id}` }));
      return [{ id: 101, sha: "baseline" }];
    });
    expect(await lastSuccessfulDeployment({ request: request as never }, "owner/repo")).toBe(
      "baseline",
    );
  });

  it("does not treat an API failure as a missing baseline", async () => {
    expect(
      await lastSuccessfulDeployment({ request: vi.fn().mockResolvedValue([]) }, "owner/repo"),
    ).toBeNull();
    await expect(
      lastSuccessfulDeployment(
        { request: vi.fn().mockRejectedValue(new Error("HTTP 403")) },
        "owner/repo",
      ),
    ).rejects.toThrow("403");
  });
});

describe("deployment configuration", () => {
  it("accepts an explicit disabled-cloud deployment without APNs credentials", () => {
    expect(validateRelayConfiguration(configuration)).toEqual([]);
  });
  it("requires stack, stage, credentials, and explicit feature switches without printing values", () => {
    const errors = validateRelayConfiguration({
      ...configuration,
      RELAY_STAGE: "",
      RELAY_STACK_NAME: undefined,
      CLOUDFLARE_API_TOKEN: undefined,
      VITRE_CLOUD_ENABLED: "",
    });
    expect(errors.join("\n")).toContain("RELAY_STAGE");
    expect(errors.join("\n")).toContain("RELAY_STACK_NAME");
    expect(errors.join("\n")).toContain("CLOUDFLARE_API_TOKEN");
    expect(errors.join("\n")).not.toContain("private-clerk-key");
  });
  it("requires APNs only when mobile is enabled", () => {
    expect(
      validateRelayConfiguration({ ...configuration, RELAY_MOBILE_ENABLED: "true" }),
    ).toContain("APNS_PRIVATE_KEY is required");
  });
  it("requires cloud host, allowlist, token and encryption key when cloud is enabled", () => {
    const errors = validateRelayConfiguration({ ...configuration, VITRE_CLOUD_ENABLED: "true" });
    for (const key of [
      "VITRE_CLOUD_MACHINE_URL",
      "VITRE_CLOUD_MACHINE_TOKEN",
      "VITRE_CLOUD_ALLOWED_USER_ID",
      "VITRE_CLOUD_ENCRYPTION_KEY",
    ])
      expect(errors).toContain(`${key} is required`);
  });
  it("rejects partial private-CA, machine, and GitHub App settings", () => {
    const errors = validateRelayConfiguration({
      ...configuration,
      RELAY_DATABASE_CA_CERT: "private-ca",
      VITRE_CLOUD_MACHINE_URL: "https://machine.example.com",
      VITRE_GITHUB_APP_ID: "123",
    });
    for (const key of [
      "RELAY_DATABASE_CA_CERTIFICATE_ID",
      "VITRE_CLOUD_MACHINE_TOKEN",
      "VITRE_GITHUB_PRIVATE_KEY",
      "VITRE_GITHUB_INSTALLATION_IDS",
    ])
      expect(errors).toContain(`${key} is required`);
  });
});
