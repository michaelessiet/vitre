// @effect-diagnostics nodeBuiltinImport:off - Standalone packaging metadata writer.
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import { git } from "./changes.ts";

export interface ArtifactMetadata {
  version: string;
  commit: string;
  architecture: "arm64";
  workflowRun: string | null;
  workflowAttempt: string | null;
  signing: "ad-hoc" | "certificate";
  dirty: boolean;
}

export async function writeArtifactMetadata(dmg: string, metadata: ArtifactMetadata) {
  const hash = NodeCrypto.createHash("sha256");
  for await (const chunk of NodeFS.createReadStream(dmg)) hash.update(chunk);
  const sha256 = hash.digest("hex");
  const filename = NodePath.basename(dmg);
  NodeFS.writeFileSync(`${dmg}.sha256`, `${sha256}  ${filename}\n`);
  NodeFS.writeFileSync(
    `${dmg}.metadata.json`,
    `${JSON.stringify({ ...metadata, filename, sha256 }, null, 2)}\n`,
  );
  return sha256;
}

if (import.meta.main) {
  const dmg = process.argv[2];
  if (!dmg) throw new Error("Expected a DMG path");
  const { version } = JSON.parse(
    NodeFS.readFileSync(new URL("../../apps/server/package.json", import.meta.url), "utf8"),
  );
  await writeArtifactMetadata(dmg, {
    version,
    commit: git(["rev-parse", "HEAD"]).trim(),
    architecture: "arm64",
    workflowRun: process.env.GITHUB_RUN_ID ?? null,
    workflowAttempt: process.env.GITHUB_RUN_ATTEMPT ?? null,
    signing: process.env.VITRE_SIGNING_IDENTITY === "-" ? "ad-hoc" : "certificate",
    dirty: git(["status", "--porcelain", "--untracked-files=normal"]).trim().length > 0,
  });
}
