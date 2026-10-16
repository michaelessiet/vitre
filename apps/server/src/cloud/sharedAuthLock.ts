import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

export class SharedCloudAuthLockError extends Schema.TaggedErrorClass<SharedCloudAuthLockError>()(
  "SharedCloudAuthLockError",
  { busy: Schema.Boolean, cause: Schema.Defect() },
) {}

const isSharedCloudAuthLockError = Schema.is(SharedCloudAuthLockError);

/** Scope the OS-visible lock to the complete read/refresh/write or interactive login. */
export const withSharedCloudAuthLock = <A, E, R>(
  directory: string | undefined,
  effect: Effect.Effect<A, E, R>,
): Effect.Effect<A, E | SharedCloudAuthLockError, R> => {
  if (!directory) return effect;
  const acquire = (): Effect.Effect<() => Promise<void>, SharedCloudAuthLockError> =>
    Effect.tryPromise({
      try: async () => {
        const lockfile = await import("proper-lockfile");
        return lockfile.lock(directory, {
          realpath: false,
          lockfilePath: `${directory}/cloud-cli-oauth-token.lock`,
          retries: 0,
          stale: 30_000,
          update: 10_000,
        });
      },
      catch: (cause) =>
        new SharedCloudAuthLockError({
          busy:
            typeof cause === "object" &&
            cause !== null &&
            "code" in cause &&
            cause.code === "ELOCKED",
          cause,
        }),
    });
  return Effect.acquireUseRelease(
    acquire(),
    () => effect,
    (release) => Effect.promise(() => release()).pipe(Effect.ignore),
  ).pipe(
    Effect.catch((error) =>
      isSharedCloudAuthLockError(error) && error.busy
        ? Effect.sleep("100 millis").pipe(
            Effect.andThen(Effect.suspend(() => withSharedCloudAuthLock(directory, effect))),
          )
        : Effect.fail(error),
    ),
  );
};
