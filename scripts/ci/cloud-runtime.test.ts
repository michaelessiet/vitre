// @effect-diagnostics nodeBuiltinImport:off - Focused runtime deployment command validation.
import { describe, expect, it } from "vite-plus/test";
import {
  runtimeKey,
  runtimeUrl,
  upgradeCommand,
  validateRuntimeConfiguration,
  verifiedInvocation,
} from "./cloud-runtime.ts";

const revision = "a".repeat(40);
const sha256 = "b".repeat(64);

describe("cloud runtime deployment", () => {
  it("uses immutable versioned artifacts and rejects invalid revisions and URLs", () => {
    expect(runtimeUrl("https://artifacts.example.com/releases", revision, sha256)).toBe(
      `https://artifacts.example.com/releases/${runtimeKey(revision, sha256)}`,
    );
    expect(() => runtimeKey("main; echo bad", sha256)).toThrow();
    for (const url of [
      "http://example.com",
      "https://token@example.com",
      "https://example.com?token=secret",
    ])
      expect(() => runtimeUrl(url, revision, sha256)).toThrow();
  });
  it("requires the existing host and short-lived CI role before publishing", () => {
    expect(validateRuntimeConfiguration({})).toHaveLength(5);
    expect(
      validateRuntimeConfiguration({
        VITRE_CLOUD_AWS_ROLE_ARN: "role",
        VITRE_CLOUD_AWS_REGION: "eu-north-1",
        VITRE_CLOUD_INSTANCE_ID: "i-0123456789abcdef0",
        VITRE_CLOUD_RUNTIME_BUCKET: "runtime",
        VITRE_CLOUD_RUNTIME_URL: "https://artifacts.example.com",
      }),
    ).toEqual([]);
  });
  it("quotes the artifact URL and encodes the installer instead of interpolating its shell syntax", () => {
    const script = "print('$(do-not-run)')";
    const command = upgradeCommand("https://example.com/a'b", sha256, revision, script, 1000);
    expect(command).toContain("https://example.com/a'\\''b");
    expect(command).not.toContain("$(do-not-run)");
    expect(command).toContain(Buffer.from(script).toString("base64"));
    expect(command).toContain("flock -n");
    expect(command).toContain("--max-filesize 1000");
    expect(() => upgradeCommand("https://example.com", sha256, revision, script, -1)).toThrow();
  });
  it("does not report success for failed, unhealthy, or wrong-revision installations", () => {
    const result = { revision, sha256, health: "ready", warmWorkersPreserved: 2 };
    expect(
      verifiedInvocation(
        { Status: "Success", StandardOutputContent: JSON.stringify(result) },
        revision,
        sha256,
      ),
    ).toEqual(result);
    for (const invocation of [
      { Status: "Failed", StandardOutputContent: JSON.stringify(result) },
      {
        Status: "Success",
        StandardOutputContent: JSON.stringify({ ...result, revision: "c".repeat(40) }),
      },
      { Status: "Success", StandardOutputContent: JSON.stringify({ ...result, health: "failed" }) },
      { Status: "Success" },
    ])
      expect(() => verifiedInvocation(invocation, revision, sha256)).toThrow();
  });
});
