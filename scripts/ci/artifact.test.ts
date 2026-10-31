// @effect-diagnostics nodeBuiltinImport:off - Artifact test uses a disposable local file.
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { expect, it } from "vite-plus/test";
import { writeArtifactMetadata } from "./artifact.ts";

it("writes independently verifiable checksum and build provenance alongside the DMG", async () => {
  const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "vitre-ci-artifact-"));
  try {
    const file = NodePath.join(root, "Vitre-0.0.28-arm64.dmg");
    NodeFS.writeFileSync(file, "test image bytes");
    const sha256 = NodeCrypto.createHash("sha256").update("test image bytes").digest("hex");
    await writeArtifactMetadata(file, {
      version: "0.0.28",
      commit: "abc123",
      architecture: "arm64",
      workflowRun: "123",
      workflowAttempt: "2",
      signing: "ad-hoc",
      dirty: false,
    });
    expect(NodeFS.readFileSync(`${file}.sha256`, "utf8")).toBe(
      `${sha256}  Vitre-0.0.28-arm64.dmg\n`,
    );
    expect(JSON.parse(NodeFS.readFileSync(`${file}.metadata.json`, "utf8"))).toMatchObject({
      sha256,
      commit: "abc123",
      workflowRun: "123",
      workflowAttempt: "2",
      signing: "ad-hoc",
      architecture: "arm64",
      dirty: false,
    });
  } finally {
    NodeFS.rmSync(root, { recursive: true, force: true });
  }
});
