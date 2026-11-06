// @effect-diagnostics nodeBuiltinImport:off - Tests exercise root env file precedence directly.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { afterEach, describe, expect, it } from "vite-plus/test";

import { loadRepoEnv } from "./public-config.ts";

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    NodeFS.rmSync(directory, { recursive: true, force: true });
  }
});

describe("loadRepoEnv", () => {
  it("returns only the process environment for a clone without env files", () => {
    expect(loadRepoEnv({ baseEnv: { FOO: "bar" }, repoRoot: makeTemporaryDirectory() })).toEqual({
      FOO: "bar",
    });
  });

  it("applies process, root local, and root precedence in that order", () => {
    const repoRoot = makeTemporaryDirectory();
    NodeFS.writeFileSync(
      NodePath.join(repoRoot, ".env"),
      "VITRE_SIGNING_IDENTITY=root\nROOT_ONLY=root\n",
    );
    NodeFS.writeFileSync(NodePath.join(repoRoot, ".env.local"), "VITRE_SIGNING_IDENTITY=local\n");

    expect(loadRepoEnv({ baseEnv: {}, repoRoot })).toEqual({
      VITRE_SIGNING_IDENTITY: "local",
      ROOT_ONLY: "root",
    });
    expect(
      loadRepoEnv({ baseEnv: { VITRE_SIGNING_IDENTITY: "ci" }, repoRoot }).VITRE_SIGNING_IDENTITY,
    ).toBe("ci");
  });
});

function makeTemporaryDirectory() {
  const directory = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3code-public-config-"));
  temporaryDirectories.push(directory);
  return directory;
}
