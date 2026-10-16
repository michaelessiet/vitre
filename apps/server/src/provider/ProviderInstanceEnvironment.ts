import type { ProviderInstanceEnvironment } from "@t3tools/contracts";
import { withManagedWorkspaceGitCeiling } from "../vcs/managedWorkspaceGitEnv.ts";

export function managedProviderInstanceEnvironment(
  environment: ProviderInstanceEnvironment | undefined,
  stateDir: string | undefined,
): ProviderInstanceEnvironment {
  if (!stateDir) return environment ?? [];
  const env = withManagedWorkspaceGitCeiling(
    stateDir,
    mergeProviderInstanceEnvironment(environment),
  );
  return [
    ...(environment ?? []).filter((variable) => variable.name !== "GIT_CEILING_DIRECTORIES"),
    { name: "GIT_CEILING_DIRECTORIES", value: env.GIT_CEILING_DIRECTORIES!, sensitive: false },
  ];
}

export function mergeProviderInstanceEnvironment(
  environment: ProviderInstanceEnvironment | undefined,
  baseEnv: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  if (!environment || environment.length === 0) {
    return baseEnv;
  }

  const next: NodeJS.ProcessEnv = { ...baseEnv };
  for (const variable of environment) {
    next[variable.name] = variable.value;
  }
  return next;
}
