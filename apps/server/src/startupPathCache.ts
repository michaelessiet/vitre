// @effect-diagnostics nodeBuiltinImport:off
// @effect-diagnostics globalDate:off
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";

const MAX_AGE_MS = 5 * 60 * 1000;

/** Short-lived cache of shell discovery, scoped to the environment and shell files. */
export async function startupPathKey(env: NodeJS.ProcessEnv, platform: string): Promise<string> {
  const home = env.HOME ?? "";
  const zdotdir = env.ZDOTDIR ?? home;
  const files = [
    "/etc/profile",
    "/etc/zshenv",
    "/etc/zshrc",
    "/etc/zprofile",
    "/etc/zlogin",
    ...[".profile", ".bash_profile", ".bash_login", ".bashrc"].map((file) =>
      NodePath.join(home, file),
    ),
    ...[".zshenv", ".zshrc", ".zprofile", ".zlogin"].map((file) => NodePath.join(zdotdir, file)),
    NodePath.join(env.XDG_CONFIG_HOME ?? NodePath.join(home, ".config"), "fish", "config.fish"),
  ];
  const stamps = await Promise.all(
    files.map(async (file) => {
      const info = await NodeFSP.stat(file).catch(() => undefined);
      return [file, info?.mtimeMs, info?.ctimeMs, info?.size];
    }),
  );
  return NodeCrypto.createHash("sha256")
    .update(JSON.stringify([platform, env.SHELL, home, env.PATH, zdotdir, stamps]))
    .digest("hex");
}

export async function cachedStartupPath(
  file: string,
  key: string,
  resolve: () => Promise<string | undefined>,
  now = Date.now(),
): Promise<string | undefined> {
  try {
    const entry: unknown = JSON.parse(await NodeFSP.readFile(file, "utf8"));
    if (
      typeof entry === "object" &&
      entry !== null &&
      "key" in entry &&
      entry.key === key &&
      "at" in entry &&
      typeof entry.at === "number" &&
      now >= entry.at &&
      now - entry.at < MAX_AGE_MS &&
      "path" in entry &&
      typeof entry.path === "string" &&
      entry.path.length > 0
    ) {
      return entry.path;
    }
  } catch {
    /* Missing, expired, or corrupt caches are ordinary cold starts. */
  }
  const path = await resolve();
  if (path) {
    const temporary = `${file}.${process.pid}.tmp`;
    try {
      await NodeFSP.mkdir(NodePath.dirname(file), { recursive: true });
      await NodeFSP.writeFile(temporary, JSON.stringify({ key, at: now, path }), { mode: 0o600 });
      await NodeFSP.rename(temporary, file);
    } catch {
      /* Discovery must work with a read-only cache directory too. */
    }
  }
  return path;
}
