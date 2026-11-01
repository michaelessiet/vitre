// @effect-diagnostics nodeBuiltinImport:off - Verify the CLI exits with its actual status despite retained handles.
import * as NodeChildProcess from "node:child_process";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
import { describe, expect, it } from "vite-plus/test";

describe("deployment CLI teardown", () => {
  it.each([
    ["Effect.void", 0],
    ["Effect.fail('failed deployment')", 1],
  ] as const)("exits after scoped finalizers for %s", (effect, status) => {
    const result = NodeChildProcess.spawnSync(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        `
      import * as Effect from 'effect/Effect';
      import * as NodeRuntime from '@effect/platform-node/NodeRuntime';
      import { deploymentTeardown } from './teardown.ts';
      setInterval(() => {}, 1000);
      Effect.gen(function*() {
        yield* Effect.addFinalizer(() => Effect.sync(() => process.stdout.write('scoped cleanup finished')));
        yield* ${effect};
      }).pipe(Effect.scoped, NodeRuntime.runMain({ disableErrorReporting: true, teardown: deploymentTeardown }));
    `,
      ],
      {
        cwd: NodePath.dirname(NodeURL.fileURLToPath(import.meta.url)),
        encoding: "utf8",
        timeout: 10_000,
      },
    );
    expect(result.error).toBeUndefined();
    expect(result.status).toBe(status);
    expect(result.stdout).toContain("scoped cleanup finished");
  });
});
