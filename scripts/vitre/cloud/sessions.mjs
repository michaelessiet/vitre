import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";

const LIMIT = 128 * 1024 * 1024;
const allowed = (name) =>
  /^(codex\/sessions|claude\/projects)\/[a-zA-Z0-9_./-]+\.jsonl$/.test(name) &&
  name.split("/").every((part) => part !== "." && part !== ".." && part !== "");

/** Export only provider conversation records, never homes, settings or auth caches. */
export async function exportSessions(homes, secrets = []) {
  const files = [];
  let bytes = 0;
  for (const [provider, home] of Object.entries(homes)) {
    const folder = provider === "codex" ? "sessions" : provider === "claude" ? "projects" : null;
    if (!folder) throw new Error("Unsupported session provider");
    const walk = async (directory, relative) => {
      const stat = await NodeFSP.lstat(directory).catch((error) => {
        if (error.code === "ENOENT") return null;
        throw error;
      });
      if (!stat) return;
      if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("Unsafe session directory");
      for (const item of await NodeFSP.readdir(directory, { withFileTypes: true })) {
        if (item.isSymbolicLink()) throw new Error("Unsafe session symlink");
        const name = `${relative}/${item.name}`;
        const path = NodePath.join(directory, item.name);
        if (item.isDirectory()) await walk(path, name);
        else if (item.isFile() && allowed(name)) {
          const size = (await NodeFSP.stat(path)).size;
          bytes += size;
          if (bytes > LIMIT || files.length >= 10000)
            throw new Error("Provider session checkpoint exceeds limit");
          let content = await NodeFSP.readFile(path, "utf8");
          // Serialize parsed records after replacement so escaped credential values are removed too.
          content =
            content
              .split("\n")
              .filter(Boolean)
              .map((line) =>
                JSON.stringify(JSON.parse(line), (_key, value) => {
                  if (typeof value !== "string") return value;
                  for (const secret of secrets.filter((secret) => secret.length >= 8))
                    value = value.split(secret).join("[redacted]");
                  return value;
                }),
              )
              .join("\n") + "\n";
          files.push({ name, content });
        }
      }
    };
    const homeStat = await NodeFSP.lstat(home).catch((error) => {
      if (error.code === "ENOENT") return null;
      throw error;
    });
    if (homeStat?.isSymbolicLink()) throw new Error("Unsafe provider home");
    await walk(NodePath.join(home, folder), `${provider}/${folder}`);
  }
  return { version: 1, files };
}

/** The supervisor calls this only in a replacement VM before any untrusted process starts. */
export async function restoreSessions(bundle, homes) {
  if (bundle.version !== 1 || !Array.isArray(bundle.files) || bundle.files.length > 10000)
    throw new Error("Invalid provider session bundle");
  let bytes = 0;
  const seen = new Set();
  for (const file of bundle.files) {
    if (!allowed(file.name) || seen.has(file.name) || typeof file.content !== "string")
      throw new Error("Invalid provider session path");
    seen.add(file.name);
    bytes += Buffer.byteLength(file.content);
    if (bytes > LIMIT) throw new Error("Provider session checkpoint exceeds limit");
    const [provider, ...parts] = file.name.split("/");
    const home = homes[provider];
    if (!home) throw new Error("Provider home missing");
    await NodeFSP.mkdir(home, { recursive: true, mode: 0o700 });
    let directory = home;
    for (const part of parts.slice(0, -1)) {
      if (!(await NodeFSP.lstat(directory)).isDirectory())
        throw new Error("Unsafe session directory");
      directory = NodePath.join(directory, part);
      await NodeFSP.mkdir(directory, { recursive: true, mode: 0o700 });
    }
    if (!(await NodeFSP.lstat(directory)).isDirectory())
      throw new Error("Unsafe session directory");
    await NodeFSP.writeFile(NodePath.join(directory, parts.at(-1)), file.content, {
      flag: "wx",
      mode: 0o600,
    });
  }
}
