import * as NodeTest from "node:test";
import * as NodeAssert from "node:assert/strict";
import { splitRunArguments, vitreExecutable } from "./cargo-artifact.mjs";

NodeTest.test("uses Cargo's executable for release, custom profiles and target directories", () => {
  for (const path of [
    "/repo/target/debug/vitre",
    "/repo/target/release/vitre",
    "/custom/aarch64-apple-darwin/profiling/vitre",
  ]) {
    const diagnostics = [];
    const output = [
      { reason: "compiler-message", message: { rendered: "warning: example\n" } },
      {
        reason: "compiler-artifact",
        target: { name: "other", kind: ["bin"] },
        executable: "/other",
      },
      {
        reason: "compiler-artifact",
        target: { name: "vitre", kind: ["bin"] },
        executable: path,
        fresh: true,
      },
      { reason: "build-finished", success: true },
    ]
      .map(JSON.stringify)
      .join("\n");
    NodeAssert.equal(
      vitreExecutable(output, (message) => diagnostics.push(message)),
      path,
    );
    NodeAssert.deepEqual(diagnostics, ["warning: example\n"]);
  }
});

NodeTest.test("never falls back to a stale binary when Cargo reports no executable", () => {
  NodeAssert.throws(
    () => vitreExecutable('{"reason":"build-finished","success":true}'),
    /did not report/,
  );
});

NodeTest.test("keeps application arguments out of cargo build", () => {
  NodeAssert.deepEqual(splitRunArguments(["--release", "--", "--example"]), {
    cargo: ["--release"],
    app: ["--example"],
  });
  NodeAssert.deepEqual(splitRunArguments(["--profile", "dev"]), {
    cargo: ["--profile", "dev"],
    app: [],
  });
});
