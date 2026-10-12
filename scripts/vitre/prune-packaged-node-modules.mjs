import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

const input = process.argv[2];
if (!input) throw new Error("usage: prune-packaged-node-modules.mjs <node_modules>");
const root = await NodeFSP.realpath(input);
if (
  NodePath.basename(root) !== "node_modules" ||
  !root
    .split(NodePath.sep)
    .some((part) => part.startsWith("vitre-dmg.") || part.startsWith("vitre-cloud."))
) {
  throw new Error(`refusing to prune non-Vitre temporary path: ${root}`);
}

// oxlint-disable-next-line t3code/no-global-process-runtime -- Standalone packaging utility inspects the actual build target.
const currentOs = process.platform;
// oxlint-disable-next-line t3code/no-global-process-runtime -- Standalone packaging utility inspects the actual build target.
const currentCpu = NodeOS.arch();
let removedPackages = 0;
let removedLinks = 0;

function supports(values, current) {
  if (!Array.isArray(values) || values.length === 0) return true;
  if (values.includes(`!${current}`)) return false;
  const positive = values.filter((value) => !value.startsWith("!"));
  return positive.length === 0 || positive.includes(current);
}

async function packageRoots(wrapper) {
  const modules = NodePath.join(wrapper, "node_modules");
  let entries;
  try {
    entries = await NodeFSP.readdir(modules, { withFileTypes: true });
  } catch {
    return [];
  }
  const roots = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const candidate = NodePath.join(modules, entry.name);
    if (!entry.name.startsWith("@")) {
      roots.push(candidate);
      continue;
    }
    for (const scoped of await NodeFSP.readdir(candidate, { withFileTypes: true })) {
      if (scoped.isDirectory()) roots.push(NodePath.join(candidate, scoped.name));
    }
  }
  return roots;
}

const virtualStore = NodePath.join(root, ".pnpm");
for (const wrapper of await NodeFSP.readdir(virtualStore, { withFileTypes: true })) {
  if (!wrapper.isDirectory() || wrapper.name === "node_modules") continue;
  for (const packageRoot of await packageRoots(NodePath.join(virtualStore, wrapper.name))) {
    let manifest;
    try {
      manifest = JSON.parse(
        await NodeFSP.readFile(NodePath.join(packageRoot, "package.json"), "utf8"),
      );
    } catch {
      continue;
    }
    if (!supports(manifest.os, currentOs) || !supports(manifest.cpu, currentCpu)) {
      await NodeFSP.rm(packageRoot, { recursive: true, force: true });
      removedPackages += 1;
    }
  }
}

// Legacy pnpm deploy adds a workspace self-link that escapes the application
// bundle. The built server entry is copied directly and never resolves it.
await NodeFSP.rm(NodePath.join(virtualStore, "node_modules", "t3"), { force: true });

async function removeBrokenLinks(directory) {
  for (const entry of await NodeFSP.readdir(directory, { withFileTypes: true })) {
    const candidate = NodePath.join(directory, entry.name);
    const stat = await NodeFSP.lstat(candidate);
    if (stat.isSymbolicLink()) {
      try {
        await NodeFSP.stat(candidate);
      } catch (error) {
        if (error?.code !== "ENOENT") throw error;
        await NodeFSP.unlink(candidate);
        removedLinks += 1;
      }
    } else if (stat.isDirectory()) {
      await removeBrokenLinks(candidate);
    }
  }
}

await removeBrokenLinks(root);
console.log(
  `[vitre-dmg] pruned ${removedPackages} incompatible packages and ${removedLinks} broken links`,
);
