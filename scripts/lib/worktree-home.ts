// @effect-diagnostics nodeBuiltinImport:off - Dev entrypoints resolve their state directory before any Effect runtime exists.
/**
 * Where development state lives, and how to keep it away from the shared home
 * that a user's installed Vitre runs against.
 *
 * A linked git worktree gets its own (gitignored) `.t3`: feature work in a
 * throwaway branch must not share a database with the real app. An explicit
 * `--home-dir` still wins, and so does nothing else: an ambient `T3CODE_HOME`
 * or `VITRE_HOME` outside a worktree is left to the caller.
 */
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

/**
 * A `.git` file points at the real git directory. A linked worktree's lives at
 * `<common-dir>/worktrees/<name>`; a submodule's at
 * `<super-git-dir>/modules/<name>`. Both are files, so the pointer, not the
 * file-vs-directory distinction alone, is what identifies a worktree.
 *
 * The common dir is not necessarily named `.git` (a bare repo's is
 * `<repo>.git`, and `$GIT_COMMON_DIR` can be anything), so match on the
 * `worktrees/<name>` tail, which git always uses.
 */
function pointsAtLinkedWorktree(gitFileContents: string): boolean {
  const gitdir = gitFileContents
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find((line) => line.startsWith("gitdir:"))
    ?.slice("gitdir:".length)
    .trim();
  if (!gitdir) return false;
  // Compare path segments so a directory merely named `…worktrees…` cannot match.
  const segments = NodePath.posix
    .normalize(gitdir.replaceAll("\\", "/"))
    .split("/")
    .filter((segment) => segment.length > 0);
  return segments.length >= 3 && segments.at(-2) === "worktrees";
}

/**
 * The root of the linked git worktree containing `cwd`, or undefined when `cwd`
 * is in a main checkout, a submodule, or no repository at all.
 */
export function resolveGitWorktreePath(cwd: string): string | undefined {
  let directory = NodePath.resolve(cwd);
  for (;;) {
    const gitPath = NodePath.join(directory, ".git");
    let stat: NodeFS.Stats | undefined;
    try {
      stat = NodeFS.statSync(gitPath);
    } catch {
      stat = undefined;
    }
    if (stat) {
      // A directory means the main checkout. Stop either way: nesting one
      // repository inside another does not make the outer one this root.
      if (!stat.isFile()) return undefined;
      let contents = "";
      try {
        contents = NodeFS.readFileSync(gitPath, "utf8");
      } catch {
        contents = "";
      }
      return pointsAtLinkedWorktree(contents) ? directory : undefined;
    }
    const parent = NodePath.dirname(directory);
    if (parent === directory) return undefined;
    directory = parent;
  }
}

/**
 * The development home for `cwd`: an explicit (non-blank) choice, otherwise the
 * worktree-local `.t3`, otherwise undefined so the caller keeps its default.
 * The worktree directory need not exist yet; falling back because it is
 * missing would send the caller to the shared home.
 */
export function resolveDevHome(cwd: string, explicit?: string): string | undefined {
  const chosen = explicit?.trim();
  if (chosen) return NodePath.resolve(cwd, chosen);
  const worktree = resolveGitWorktreePath(cwd);
  return worktree === undefined ? undefined : NodePath.join(worktree, ".t3");
}

/**
 * Removes `--home-dir <path>` / `--home-dir=<path>` from `args`, returning the
 * value (the last one wins) and the remaining arguments.
 */
export function takeHomeDirArgument(args: readonly string[]): {
  readonly homeDir: string | undefined;
  readonly rest: string[];
} {
  let homeDir: string | undefined;
  const rest: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]!;
    if (arg === "--home-dir") {
      homeDir = args[index + 1];
      index += 1;
    } else if (arg.startsWith("--home-dir=")) {
      homeDir = arg.slice("--home-dir=".length);
    } else {
      rest.push(arg);
    }
  }
  return { homeDir, rest };
}
