import { CloudDesktopAuthError, type CloudDesktopSession } from "@t3tools/contracts/cloud";
import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { CloudCliTokenManager } from "./CliTokenManager.ts";
import { relayUrlConfig } from "./publicConfig.ts";

export const desktopCloudSession = Effect.fn("cloud.desktop_session")(function* (
  authorize: boolean,
  cancel = false,
): Effect.fn.Return<typeof CloudDesktopSession.Type, CloudDesktopAuthError> {
  const enabled = yield* Config.boolean("VITRE_CLOUD_DESKTOP_ENABLED").pipe(
    Config.withDefault(false),
    Effect.mapError(
      () => new CloudDesktopAuthError({ message: "Cloud desktop configuration is invalid" }),
    ),
  );
  if (!enabled)
    return { enabled: false, relayUrl: null, accessToken: null, expiresAtEpochMs: null };
  const relayUrl = yield* relayUrlConfig.pipe(
    Effect.mapError(
      () =>
        new CloudDesktopAuthError({
          message: "Configure the personal cloud deployment before signing in",
        }),
    ),
  );
  const manager = yield* Effect.serviceOption(CloudCliTokenManager);
  if (Option.isNone(manager))
    return yield* new CloudDesktopAuthError({
      message: "Cloud login is not available in this environment",
    });
  if (cancel) {
    yield* manager.value.cancelLogin ?? Effect.void;
    return { enabled, relayUrl, accessToken: null, expiresAtEpochMs: null };
  }
  const authError = () =>
    new CloudDesktopAuthError({
      message: "Cloud sign-in failed. Check the personal deployment configuration and try again.",
    });
  const existing = yield* (
    authorize ? Effect.succeed(Option.none()) : manager.value.getExisting
  ).pipe(
    Effect.catch(() => (authorize ? Effect.succeed(Option.none()) : Effect.fail(authError()))),
  );
  if (Option.isSome(existing))
    return {
      enabled,
      relayUrl,
      accessToken: existing.value.accessToken,
      expiresAtEpochMs: existing.value.expiresAtEpochMs,
    };
  if (!authorize) return { enabled, relayUrl, accessToken: null, expiresAtEpochMs: null };
  if (!manager.value.getInBrowser) return yield* authError();
  const result = yield* manager.value.getInBrowser.pipe(Effect.mapError(authError));
  if (result._tag !== "Authorized") return yield* authError();
  return {
    enabled,
    relayUrl,
    accessToken: result.token.accessToken,
    expiresAtEpochMs: result.token.expiresAtEpochMs,
  };
});
