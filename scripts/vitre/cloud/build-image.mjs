import * as NodeChildProcess from "node:child_process";
import * as NodeURL from "node:url";
import * as NodePath from "node:path";

const [image, codexVersion, claudeVersion] = process.argv.slice(2);
if (
  !image ||
  !/:[a-zA-Z0-9_.-]+$/.test(image) ||
  /:(latest|lts|stable)$/.test(image) ||
  !/^\d+\.\d+\.\d+(?:-[a-zA-Z0-9.-]+)?$/.test(codexVersion ?? "") ||
  !/^\d+\.\d+\.\d+(?:-[a-zA-Z0-9.-]+)?$/.test(claudeVersion ?? "")
) {
  console.error(
    "Usage: node scripts/vitre/cloud/build-image.mjs registry/image:version CODEX_VERSION CLAUDE_VERSION",
  );
  process.exit(1);
}
const root = NodePath.resolve(NodePath.dirname(NodeURL.fileURLToPath(import.meta.url)), "../../..");
const child = NodeChildProcess.spawn(
  "docker",
  [
    "buildx",
    "build",
    "--platform",
    "linux/amd64",
    "--load",
    "--file",
    "scripts/vitre/cloud/Dockerfile",
    "--tag",
    image,
    "--build-arg",
    `CODEX_VERSION=${codexVersion}`,
    "--build-arg",
    `CLAUDE_VERSION=${claudeVersion}`,
    ".",
  ],
  { cwd: root, stdio: "inherit" },
);
child.once("error", () => {
  console.error("Docker buildx is required to build the worker image.");
  process.exitCode = 1;
});
child.once("exit", (code) => {
  process.exitCode = code ?? 1;
});
