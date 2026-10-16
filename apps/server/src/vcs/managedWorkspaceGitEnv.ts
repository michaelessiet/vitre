// @effect-diagnostics nodeBuiltinImport:off - Pure native-path boundary for managed cloud returns.
import * as NodePath from "node:path";

/** Shared provider processes may later run a shell in any conversation directory. */
export function withManagedWorkspaceGitCeiling(
  stateDir: string,
  env?: NodeJS.ProcessEnv,
): NodeJS.ProcessEnv {
  const boundary = NodePath.resolve(stateDir, "cloud-workspaces");
  const existing = env?.GIT_CEILING_DIRECTORIES ?? process.env.GIT_CEILING_DIRECTORIES;
  return {
    ...env,
    GIT_CEILING_DIRECTORIES: existing?.split(NodePath.delimiter).includes(boundary)
      ? existing
      : existing
        ? `${existing}${NodePath.delimiter}${boundary}`
        : boundary,
  };
}

/** A plain returned workspace must not discover the repository containing app state. */
export function managedWorkspaceGitEnv(
  cwd: string,
  stateDir: string | undefined,
  env?: NodeJS.ProcessEnv,
): NodeJS.ProcessEnv | undefined {
  if (!stateDir) return env;
  const boundary = NodePath.resolve(stateDir, "cloud-workspaces");
  const relative = NodePath.relative(boundary, NodePath.resolve(cwd));
  if (
    relative === ".." ||
    relative.startsWith(`..${NodePath.sep}`) ||
    NodePath.isAbsolute(relative)
  )
    return env;
  return withManagedWorkspaceGitCeiling(stateDir, env);
}
