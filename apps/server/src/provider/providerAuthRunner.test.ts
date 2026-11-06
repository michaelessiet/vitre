import { assert, describe, it } from "@effect/vitest";
import {
  ProviderDriverKind,
  ProviderInstanceId,
  ServerProviderAuthError,
  type ServerProvider,
  type ServerProviderAuthEvent,
} from "@t3tools/contracts";
import { HostProcessPlatform } from "@t3tools/shared/hostProcess";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";

import type { ProviderAccountCommands, ProviderInstance } from "./ProviderDriver.ts";
import * as ProviderAuthRunner from "./providerAuthRunner.ts";
import { ProviderInstanceRegistry } from "./Services/ProviderInstanceRegistry.ts";
import { ProviderRegistry, type ProviderRegistryShape } from "./Services/ProviderRegistry.ts";

const isAuthError = Schema.is(ServerProviderAuthError);
const encoder = new TextEncoder();
const WORK = ProviderInstanceId.make("claudeAgent_work");

const refreshedProvider: ServerProvider = {
  instanceId: WORK,
  driver: ProviderDriverKind.make("claudeAgent"),
  enabled: true,
  installed: true,
  version: null,
  status: "ready",
  auth: { status: "authenticated", email: "work@example.com" },
  checkedAt: "2026-11-06T00:00:00.000Z",
  models: [],
  slashCommands: [],
  skills: [],
};

const workCommands: ProviderAccountCommands = {
  signIn: {
    command: "claude",
    args: ["auth", "login"],
    env: { CLAUDE_CONFIG_DIR: "/accounts/work" },
    credentialDirectory: "/accounts/work",
  },
};

interface Spawned {
  readonly command: string;
  readonly args: ReadonlyArray<string>;
  readonly env: Record<string, string | undefined> | undefined;
  readonly stdin: unknown;
}

function makeHarness(options: {
  readonly accountCommands?: ProviderAccountCommands | undefined;
  readonly stdout?: string;
  readonly stderr?: string;
  readonly code?: number;
}) {
  const spawned: Array<Spawned> = [];
  const directories: Array<string> = [];
  const refreshed: Array<ProviderInstanceId> = [];
  const instance = {
    instanceId: WORK,
    ...(options.accountCommands
      ? { accountCommands: Effect.succeed(options.accountCommands) }
      : {}),
  } as unknown as ProviderInstance;
  const registry: Partial<ProviderRegistryShape> = {
    refreshInstance: (instanceId) =>
      Effect.sync(() => {
        refreshed.push(instanceId);
        return [refreshedProvider];
      }),
  };
  const layer = ProviderAuthRunner.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        Layer.mock(ProviderInstanceRegistry)({
          getInstance: (id) => Effect.succeed(id === WORK ? instance : undefined),
        }),
        Layer.mock(ProviderRegistry)(registry),
        FileSystem.layerNoop({
          makeDirectory: (path) => Effect.sync(() => void directories.push(path)),
        }),
        Layer.succeed(
          ChildProcessSpawner.ChildProcessSpawner,
          ChildProcessSpawner.make((command) => {
            const standard = command as ChildProcess.StandardCommand;
            spawned.push({
              command: standard.command,
              args: standard.args,
              env: standard.options.env,
              stdin: standard.options.stdin,
            });
            return Effect.succeed(
              ChildProcessSpawner.makeHandle({
                pid: ChildProcessSpawner.ProcessId(1),
                exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(options.code ?? 0)),
                isRunning: Effect.succeed(false),
                kill: () => Effect.void,
                unref: Effect.succeed(Effect.void),
                stdin: Sink.drain,
                stdout: Stream.make(encoder.encode(options.stdout ?? "")),
                stderr: Stream.make(encoder.encode(options.stderr ?? "")),
                all: Stream.empty,
                getInputFd: () => Sink.drain,
                getOutputFd: () => Stream.empty,
              }),
            );
          }),
        ),
        Layer.succeed(HostProcessPlatform, "linux"),
      ),
    ),
  );
  const run = (action: "signIn" | "signOut", instanceId = WORK) =>
    Effect.gen(function* () {
      const events: Array<ServerProviderAuthEvent> = [];
      const runner = yield* ProviderAuthRunner.ProviderAuthRunner;
      const exit = yield* runner
        .run({ instanceId, action }, (event) => Effect.sync(() => void events.push(event)))
        .pipe(Effect.exit);
      return { exit, events };
    }).pipe(Effect.provide(layer));
  return { run, spawned, directories, refreshed };
}

describe("providerAuthRunner", () => {
  it("extracts sign-in links without trailing punctuation or terminal escapes", () => {
    assert.deepStrictEqual(
      ProviderAuthRunner.extractUrls(
        "\u001b[1mVisit\u001b[0m https://claude.ai/oauth/authorize?code=true&state=abc). Then return.",
      ),
      ["https://claude.ai/oauth/authorize?code=true&state=abc"],
    );
    assert.deepStrictEqual(ProviderAuthRunner.extractUrls("No link here"), []);
  });

  it.effect("signs in with the instance's isolated environment and refreshes only it", () => {
    const harness = makeHarness({
      accountCommands: workCommands,
      stdout:
        "Opening browser to sign in…\nIf the browser didn't open, visit: https://claude.ai/oauth?x=1\n",
      stderr: "Retrying https://claude.ai/oauth?x=1\n",
    });
    return Effect.gen(function* () {
      const { exit, events } = yield* harness.run("signIn");
      assert.isTrue(Exit.isSuccess(exit));
      assert.deepStrictEqual(harness.directories, ["/accounts/work"]);
      assert.strictEqual(harness.spawned.length, 1);
      assert.strictEqual(harness.spawned[0]?.command, "claude");
      assert.deepStrictEqual(harness.spawned[0]?.args, ["auth", "login"]);
      assert.strictEqual(harness.spawned[0]?.env?.CLAUDE_CONFIG_DIR, "/accounts/work");
      assert.strictEqual(harness.spawned[0]?.stdin, "ignore");
      assert.deepStrictEqual(harness.refreshed, [WORK]);
      assert.deepStrictEqual(
        events.filter((event) => event.type === "url"),
        [{ type: "url", url: "https://claude.ai/oauth?x=1" }],
      );
      assert.deepStrictEqual(events.at(-1), { type: "completed", providers: [refreshedProvider] });
    });
  });

  it.effect("reports the CLI's last output when sign-in fails and does not refresh", () => {
    const harness = makeHarness({
      accountCommands: workCommands,
      stderr: "Login cancelled\n",
      code: 1,
    });
    return Effect.gen(function* () {
      const { exit } = yield* harness.run("signIn");
      assert.isTrue(Exit.isFailure(exit));
      const failure = Exit.isFailure(exit) ? Cause.squash(exit.cause) : undefined;
      assert.isTrue(isAuthError(failure));
      assert.include(isAuthError(failure) ? failure.reason : "", "Login cancelled");
      assert.deepStrictEqual(harness.refreshed, []);
    });
  });

  it.effect("rejects drivers without account isolation and unsupported sign-out", () => {
    const withoutCommands = makeHarness({});
    const signInOnly = makeHarness({ accountCommands: workCommands });
    return Effect.gen(function* () {
      const missing = yield* withoutCommands.run("signIn");
      assert.isTrue(Exit.isFailure(missing.exit));
      const signOut = yield* signInOnly.run("signOut");
      assert.isTrue(Exit.isFailure(signOut.exit));
      const unknown = yield* signInOnly.run("signIn", ProviderInstanceId.make("missing"));
      assert.isTrue(Exit.isFailure(unknown.exit));
      assert.strictEqual(withoutCommands.spawned.length + signInOnly.spawned.length, 0);
    });
  });
});
