// @effect-diagnostics nodeBuiltinImport:off
// @effect-diagnostics globalDate:off
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { afterEach, expect, it } from "vite-plus/test";
import { cachedStartupPath, startupPathKey } from "./startupPathCache.ts";

const directories: string[] = [];
async function directory() {
  const dir = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "vitre-path-"));
  directories.push(dir);
  return dir;
}
afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((dir) => NodeFSP.rm(dir, { recursive: true, force: true })),
  );
});

it("skips shell discovery for a warm cache, invalidates keys and expires", async () => {
  const file = NodePath.join(await directory(), "path.json");
  let calls = 0;
  const discover = async () => {
    calls++;
    return "/tool/bin:/usr/bin";
  };
  expect(await cachedStartupPath(file, "a", discover, 1000)).toBe("/tool/bin:/usr/bin");
  await cachedStartupPath(file, "a", discover, 1001);
  expect(calls).toBe(1);
  await cachedStartupPath(file, "b", discover, 1002);
  expect(calls).toBe(2);
  await cachedStartupPath(file, "b", discover, 301002);
  expect(calls).toBe(3);
});

it("recovers from corrupt caches without caching failed discovery", async () => {
  const file = NodePath.join(await directory(), "path.json");
  await NodeFSP.writeFile(file, "broken");
  expect(await cachedStartupPath(file, "a", async () => undefined)).toBeUndefined();
  expect(await cachedStartupPath(file, "a", async () => "/bin")).toBe("/bin");
});

it("invalidates when the inherited PATH or shell configuration changes", async () => {
  const home = await directory();
  const env = { HOME: home, SHELL: "/bin/zsh", PATH: "/bin" };
  const initial = await startupPathKey(env, "darwin");
  expect(await startupPathKey({ ...env, PATH: "/usr/bin" }, "darwin")).not.toBe(initial);
  await NodeFSP.writeFile(NodePath.join(home, ".zshrc"), "export PATH=/tools:$PATH");
  expect(await startupPathKey(env, "darwin")).not.toBe(initial);
});
