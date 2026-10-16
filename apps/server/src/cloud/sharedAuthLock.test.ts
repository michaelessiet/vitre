import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Deferred from "effect/Deferred";
import * as Fiber from "effect/Fiber";
import { withSharedCloudAuthLock } from "./sharedAuthLock.ts";

it.layer(NodeServices.layer, { excludeTestServices: true })("shared account lock", (it) => {
  it.effect("serializes independent windows and releases after failure", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const directory = yield* fs.makeTempDirectoryScoped({ prefix: "vitre-auth-lock-" });
      let active = 0;
      let peak = 0;
      const operation = Effect.gen(function* () {
        active++;
        peak = Math.max(peak, active);
        yield* Effect.sleep("30 millis");
        active--;
      });
      yield* Effect.all(
        Array.from({ length: 3 }, () => withSharedCloudAuthLock(directory, operation)),
        { concurrency: 3 },
      );
      assert.equal(peak, 1);
      yield* withSharedCloudAuthLock(directory, Effect.fail("expected")).pipe(Effect.flip);
      yield* withSharedCloudAuthLock(directory, operation);
      assert.equal(active, 0);
    }).pipe(Effect.scoped),
  );
  it.effect("cancels a waiting window without waiting for the owner", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const directory = yield* fs.makeTempDirectoryScoped({ prefix: "vitre-auth-cancel-" });
      const acquired = yield* Deferred.make<void>();
      const owner = yield* withSharedCloudAuthLock(
        directory,
        Deferred.succeed(acquired, undefined).pipe(Effect.andThen(Effect.never)),
      ).pipe(Effect.forkScoped);
      yield* Deferred.await(acquired);
      const waiting = yield* withSharedCloudAuthLock(directory, Effect.void).pipe(
        Effect.forkScoped,
      );
      yield* Effect.sleep("150 millis");
      yield* Fiber.interrupt(waiting);
      yield* Fiber.interrupt(owner);
      yield* withSharedCloudAuthLock(directory, Effect.void);
    }).pipe(Effect.scoped),
  );
});
