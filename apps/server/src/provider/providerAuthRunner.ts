/**
 * ProviderAuthRunner — signs one provider instance in or out.
 *
 * Each instance owns its credential directory (`CLAUDE_CONFIG_DIR`, a Codex
 * shadow `CODEX_HOME`, …), which is what lets a user keep several accounts of
 * the same driver side by side. The driver supplies the exact CLI command and
 * environment; this runner spawns it, relays its output and any sign-in URL,
 * then refreshes that instance's snapshot so the new account is reported.
 *
 * Closing the caller's stream interrupts the run and kills the CLI, which is
 * how a pending browser sign-in is cancelled.
 *
 * @module provider/providerAuthRunner
 */
import {
  ServerProviderAuthError,
  type ProviderInstanceId,
  type ServerProvider,
  type ServerProviderAuthEvent,
  type ServerProviderAuthInput,
} from "@t3tools/contracts";
import { resolveSpawnCommand } from "@t3tools/shared/shell";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";

import { ProviderInstanceRegistry } from "./Services/ProviderInstanceRegistry.ts";
import { ProviderRegistry } from "./Services/ProviderRegistry.ts";

/** Browser sign-in waits on the user; give them time but never hang forever. */
const AUTH_TIMEOUT = Duration.minutes(10);
const MAX_OUTPUT_LINE_CHARS = 2_000;
const FAILURE_TAIL_LINES = 6;

// oxlint-disable-next-line no-control-regex
const ANSI_PATTERN = /\u001b\[[0-9;?]*[ -/]*[@-~]|\u001b\][^\u0007]*(?:\u0007|\u001b\\)/g;
const URL_PATTERN = /https?:\/\/[^\s"'<>`]+/g;

export function stripAnsi(text: string): string {
  return text.replace(ANSI_PATTERN, "");
}

/** Sign-in links printed by provider CLIs, without trailing punctuation. */
export function extractUrls(line: string): ReadonlyArray<string> {
  return (stripAnsi(line).match(URL_PATTERN) ?? []).map((url) => url.replace(/[).,;:!?\]]+$/, ""));
}

export interface ProviderAuthRunnerShape {
  readonly run: (
    input: ServerProviderAuthInput,
    emit: (event: ServerProviderAuthEvent) => Effect.Effect<void>,
  ) => Effect.Effect<ReadonlyArray<ServerProvider>, ServerProviderAuthError>;
}

export class ProviderAuthRunner extends Context.Service<
  ProviderAuthRunner,
  ProviderAuthRunnerShape
>()("t3/provider/providerAuthRunner") {}

export const make = Effect.fn("ProviderAuthRunner.make")(function* () {
  const instances = yield* ProviderInstanceRegistry;
  const providers = yield* ProviderRegistry;
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const fileSystem = yield* FileSystem.FileSystem;
  const running = yield* Ref.make<ReadonlySet<ProviderInstanceId>>(new Set());

  const fail = (instanceId: ProviderInstanceId, reason: string) =>
    new ServerProviderAuthError({ instanceId, reason });

  const run: ProviderAuthRunnerShape["run"] = Effect.fn("ProviderAuthRunner.run")(
    function* (input, emit) {
      const { instanceId, action } = input;
      const instance = yield* instances.getInstance(instanceId);
      if (!instance) {
        return yield* fail(instanceId, "This provider instance is not available.");
      }
      if (!instance.accountCommands) {
        return yield* fail(
          instanceId,
          "This provider does not support signing in from Vitre. Add an API key to its environment instead.",
        );
      }
      const commands = yield* instance.accountCommands;
      const command = action === "signIn" ? commands.signIn : commands.signOut;
      if (!command) {
        return yield* fail(instanceId, "This provider does not support signing out from Vitre.");
      }

      const claimed = yield* Ref.modify(running, (current) =>
        current.has(instanceId)
          ? [false, current]
          : [true, new Set([...current, instanceId]) as ReadonlySet<ProviderInstanceId>],
      );
      if (!claimed) {
        return yield* fail(instanceId, "An account action is already running for this provider.");
      }
      const release = Ref.update(running, (current) => {
        const next = new Set(current);
        next.delete(instanceId);
        return next;
      });

      const execute = Effect.gen(function* () {
        if (command.credentialDirectory) {
          yield* fileSystem
            .makeDirectory(command.credentialDirectory, { recursive: true })
            .pipe(
              Effect.mapError((cause) =>
                fail(
                  instanceId,
                  `Could not create ${command.credentialDirectory}: ${cause.message}`,
                ),
              ),
            );
        }
        const resolved = yield* resolveSpawnCommand(command.command, command.args, {
          env: command.env,
          extendEnv: true,
        });
        const child = yield* spawner
          .spawn(
            ChildProcess.make(resolved.command, resolved.args, {
              env: command.env,
              extendEnv: true,
              shell: resolved.shell,
              // No terminal to answer prompts: give the CLI EOF so an
              // interactive fallback exits instead of waiting forever.
              stdin: "ignore",
            }),
          )
          .pipe(
            Effect.mapError((cause) =>
              fail(instanceId, `Could not run ${command.command}: ${cause.message}`),
            ),
          );
        yield* Effect.addFinalizer(() => child.kill().pipe(Effect.ignore));

        const seenUrls = new Set<string>();
        const tail: Array<string> = [];
        const relay = (stream: Stream.Stream<Uint8Array, unknown>) =>
          stream.pipe(
            Stream.decodeText(),
            Stream.splitLines,
            Stream.runForEach((raw) => {
              const line = stripAnsi(raw).trimEnd().slice(0, MAX_OUTPUT_LINE_CHARS);
              if (line.trim().length === 0) return Effect.void;
              tail.push(line);
              if (tail.length > FAILURE_TAIL_LINES) tail.shift();
              const urls = extractUrls(line).filter((url) => !seenUrls.has(url));
              for (const url of urls) seenUrls.add(url);
              return emit({ type: "output", text: line }).pipe(
                Effect.andThen(
                  Effect.forEach(urls, (url) => emit({ type: "url", url }), { discard: true }),
                ),
              );
            }),
            Effect.ignore,
          );

        const [, , exitCode] = yield* Effect.all(
          [relay(child.stdout), relay(child.stderr), child.exitCode],
          { concurrency: "unbounded" },
        ).pipe(Effect.mapError((cause) => fail(instanceId, cause.message)));
        if (Number(exitCode) !== 0) {
          const detail = tail.length > 0 ? `\n${tail.join("\n")}` : "";
          return yield* fail(
            instanceId,
            `${action === "signIn" ? "Sign-in" : "Sign-out"} exited with code ${Number(exitCode)}.${detail}`,
          );
        }
      }).pipe(
        Effect.scoped,
        Effect.timeoutOption(AUTH_TIMEOUT),
        Effect.flatMap((result) =>
          Option.isSome(result)
            ? Effect.void
            : Effect.fail(fail(instanceId, "Sign-in timed out. Try again.")),
        ),
      );

      yield* execute.pipe(Effect.ensuring(release));
      const refreshed = yield* providers.refreshInstance(instanceId);
      yield* emit({ type: "completed", providers: refreshed });
      return refreshed;
    },
  );

  return ProviderAuthRunner.of({ run });
});

export const layer = Layer.effect(ProviderAuthRunner, make());
