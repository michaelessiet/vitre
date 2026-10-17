#!/usr/bin/env node
// Dev runner for the native Vitre shell: ensure the server bundle exists,
// then `cargo run -p vitre-app` against it. The Rust shell spawns and
// supervises the sidecar itself (same model as the packaged app). Rebuild the
// bundle (`pnpm --filter t3 build:bundle` or `--rebuild`) to pick up server
// changes.

import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeOS from "node:os";
import * as NodeURL from "node:url";
import { splitRunArguments, vitreExecutable } from "./cargo-artifact.mjs";
import { loadRepoEnv } from "../../scripts/lib/public-config.ts";

const repoRoot = NodePath.resolve(
  NodePath.dirname(NodeURL.fileURLToPath(import.meta.url)),
  "..",
  "..",
);
const devEnv = loadRepoEnv({ repoRoot });
const serverEntry = NodePath.join(repoRoot, "apps/server/dist/bin.mjs");
const rebuild = process.argv.includes("--rebuild");

if (rebuild || !NodeFS.existsSync(serverEntry)) {
  console.log("[dev:vitre] building server bundle (vp pack)…");
  const result = NodeChildProcess.spawnSync("pnpm", ["--filter", "t3", "run", "build:bundle"], {
    cwd: repoRoot,
    stdio: "inherit",
  });
  if (result.status !== 0) process.exit(result.status ?? 1);
}

const extra = process.argv.slice(2).filter((arg) => arg !== "--rebuild");
const signingIdentity = devEnv.VITRE_SIGNING_IDENTITY;
let command = "cargo";
let args = ["run", "-p", "vitre-app", ...extra];

if (!signingIdentity) {
  console.warn(
    "[dev:vitre] this cargo run uses an ad-hoc identity; set VITRE_SIGNING_IDENTITY to retain macOS Screen Recording access across rebuilds",
  );
}

if (signingIdentity) {
  // Standalone launcher: no Effect service context exists at this entrypoint.
  // oxlint-disable-next-line t3code/no-global-process-runtime
  if (NodeOS.platform() !== "darwin") {
    console.error("[dev:vitre] VITRE_SIGNING_IDENTITY is only supported on macOS");
    process.exit(1);
  }
  const runArguments = splitRunArguments(extra);
  const build = NodeChildProcess.spawnSync(
    "cargo",
    [
      "build",
      "-p",
      "vitre-app",
      "--bin",
      "vitre",
      ...runArguments.cargo,
      "--message-format=json-render-diagnostics",
    ],
    {
      cwd: repoRoot,
      stdio: ["inherit", "pipe", "inherit"],
      encoding: "utf8",
      maxBuffer: 64 * 1024 * 1024,
      env: devEnv,
    },
  );
  if (build.status !== 0) {
    if (build.stdout) process.stderr.write(build.stdout);
    if (build.error) console.error(build.error);
    process.exit(build.status ?? 1);
  }
  const builtExecutable = vitreExecutable(build.stdout, (message) => process.stderr.write(message));

  const app = NodePath.join(repoRoot, "target", "vitre-dev", "Vitre.app");
  const contents = NodePath.join(app, "Contents");
  const executable = NodePath.join(contents, "MacOS", "Vitre");
  NodeFS.mkdirSync(NodePath.dirname(executable), { recursive: true });
  NodeFS.copyFileSync(builtExecutable, executable);
  NodeFS.copyFileSync(
    NodePath.join(repoRoot, "scripts", "vitre", "Info.plist"),
    NodePath.join(contents, "Info.plist"),
  );
  const sign = NodeChildProcess.spawnSync("codesign", ["--force", "--sign", signingIdentity, app], {
    cwd: repoRoot,
    stdio: "inherit",
  });
  if (sign.status !== 0) process.exit(sign.status ?? 1);
  // Launch Services gives TCC the app's signed bundle identity. Running the
  // executable directly from this Node process attributes capture to the CLI.
  const appEnvironment = Object.fromEntries(
    Object.entries(devEnv).filter(([name]) => name.startsWith("VITRE_")),
  );
  appEnvironment.VITRE_SERVER_ENTRY = serverEntry;
  command = "open";
  const stdoutLog = NodePath.join(repoRoot, "target", "vitre-dev", "stdout.log");
  const stderrLog = NodePath.join(repoRoot, "target", "vitre-dev", "stderr.log");
  args = ["-W", "-n", "-a", app, "-o", stdoutLog, "--stderr", stderrLog];
  for (const [name, value] of Object.entries(appEnvironment)) {
    args.push("--env", `${name}=${value}`);
  }
  if (runArguments.app.length > 0) args.push("--args", ...runArguments.app);
  console.log(`[dev:vitre] signed development app at ${app}`);
  console.log("[dev:vitre] launching through macOS Launch Services");
  console.log(`[dev:vitre] logs: ${stdoutLog}, ${stderrLog}`);
}

if (!signingIdentity) console.log(`[dev:vitre] ${command} ${args.join(" ")}`);
const child = NodeChildProcess.spawn(command, args, {
  cwd: repoRoot,
  stdio: "inherit",
  env: {
    ...devEnv,
    VITRE_SERVER_ENTRY: serverEntry,
  },
});
child.on("exit", (code) => process.exit(code ?? 0));
for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    if (signingIdentity) {
      const executable = NodePath.join(
        repoRoot,
        "target",
        "vitre-dev",
        "Vitre.app",
        "Contents",
        "MacOS",
        "Vitre",
      );
      NodeChildProcess.spawnSync("pkill", ["-f", "-x", executable]);
    }
    child.kill(signal);
  });
}
