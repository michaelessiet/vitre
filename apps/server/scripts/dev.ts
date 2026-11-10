// @effect-diagnostics nodeBuiltinImport:off - Dev entrypoint that only chooses arguments and supervises one child.
/**
 * `vp run dev:server`: run the server from source in watch mode. Inside a
 * linked git worktree the server's data defaults to that worktree's gitignored
 * `.t3`, so feature work never shares a database with the main checkout.
 * `--home-dir <path>` chooses another directory; `--base-dir` passes through.
 */
import * as NodeChildProcess from "node:child_process";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

import { resolveDevHome, takeHomeDirArgument } from "../../../scripts/lib/worktree-home.ts";

const serverRoot = NodePath.resolve(NodePath.dirname(NodeURL.fileURLToPath(import.meta.url)), "..");
const { homeDir, rest } = takeHomeDirArgument(process.argv.slice(2));
const hasBaseDir = rest.some((arg) => arg === "--base-dir" || arg.startsWith("--base-dir="));
// `INIT_CWD` is where `vp run`/pnpm was invoked; the script itself runs in apps/server.
const invokedFrom = process.env.INIT_CWD ?? process.cwd();
const home = hasBaseDir ? undefined : resolveDevHome(invokedFrom, homeDir);
const args = ["--watch", "src/bin.ts", ...(home ? ["--base-dir", home] : []), ...rest];

if (home) console.log(`[dev:server] data directory: ${home}`);
const child = NodeChildProcess.spawn(process.execPath, args, { cwd: serverRoot, stdio: "inherit" });
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => child.kill(signal));
}
child.on("exit", (code, signal) => {
  process.exitCode = code ?? (signal ? 1 : 0);
});
