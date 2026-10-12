import { HostProcessEnvironment, HostProcessPlatform } from "@t3tools/shared/hostProcess";
import {
  listLoginShellCandidates,
  mergePathEntries,
  readPathFromLoginShellAsync,
  readPathFromLaunchctl,
  resolveWindowsEnvironment,
} from "@t3tools/shared/shell";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as NodeOS from "node:os";
import { cachedStartupPath, startupPathKey } from "./startupPathCache.ts";

function logPathHydrationWarning(message: string, error?: unknown): void {
  process.stderr.write(
    `[server] ${message} ${error instanceof Error ? error.message : (error ?? "")}\n`,
  );
}

async function hydratePosixPath(
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform,
  cacheFile?: string,
): Promise<void> {
  const discover = async () => {
    let shellPath: string | undefined;
    for (const shell of listLoginShellCandidates(platform, env.SHELL)) {
      try {
        shellPath = await readPathFromLoginShellAsync(shell);
      } catch (error) {
        logPathHydrationWarning(`Failed to read PATH from login shell ${shell}.`, error);
      }

      if (shellPath) break;
    }
    return shellPath;
  };
  const shellPath = cacheFile
    ? await cachedStartupPath(cacheFile, await startupPathKey(env, platform), discover)
    : await discover();
  const launchctlPath = platform === "darwin" && !shellPath ? readPathFromLaunchctl() : undefined;
  const mergedPath = mergePathEntries(shellPath ?? launchctlPath, env.PATH, platform);
  if (mergedPath) {
    env.PATH = mergedPath;
  }
}

export const fixPath = Effect.fn("fixPath")(function* (
  cacheDir?: string,
): Effect.fn.Return<void, never, FileSystem.FileSystem | Path.Path> {
  const platform = yield* HostProcessPlatform;
  const env = yield* HostProcessEnvironment;

  if (platform === "win32") {
    const repairedEnvironment = yield* resolveWindowsEnvironment(env).pipe(
      Effect.catchDefect((defect) =>
        Effect.sync(() => {
          logPathHydrationWarning("Failed to hydrate PATH from the user environment.", defect);
          return {} as Partial<NodeJS.ProcessEnv>;
        }),
      ),
    );
    for (const [key, value] of Object.entries(repairedEnvironment)) {
      if (value !== undefined) {
        env[key] = value;
      }
    }
    return;
  }

  if (platform !== "darwin" && platform !== "linux") return;

  const path = yield* Path.Path;
  const cacheFile = cacheDir ? path.join(cacheDir, "startup-path.json") : undefined;
  yield* Effect.promise(() => hydratePosixPath(env, platform, cacheFile)).pipe(
    Effect.catchDefect((defect) =>
      Effect.sync(() => {
        logPathHydrationWarning("Failed to hydrate PATH from the user environment.", defect);
      }),
    ),
  );
});

export const expandHomePath = Effect.fn(function* (input: string) {
  const { join } = yield* Path.Path;
  if (input === "~") {
    return NodeOS.homedir();
  }
  if (input.startsWith("~/") || input.startsWith("~\\")) {
    return join(NodeOS.homedir(), input.slice(2));
  }
  return input;
});

export const resolveBaseDir = Effect.fn(function* (raw: string | undefined) {
  const { join, resolve } = yield* Path.Path;
  if (!raw || raw.trim().length === 0) {
    return join(NodeOS.homedir(), ".t3");
  }
  return resolve(yield* expandHomePath(raw.trim()));
});
