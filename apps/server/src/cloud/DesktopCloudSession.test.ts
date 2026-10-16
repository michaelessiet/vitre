import { assert, it } from "@effect/vitest";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { CloudCliTokenManager, CloudCliCredentialRefreshError } from "./CliTokenManager.ts";
import { desktopCloudSession } from "./DesktopCloudSession.ts";

const token = { accessToken: "access", refreshToken: "never-expose", expiresAtEpochMs: 12345 };
const manager = (overrides: Partial<typeof CloudCliTokenManager.Service> = {}) =>
  CloudCliTokenManager.of({
    get: Effect.die("CLI prompt must not run"),
    getExisting: Effect.succeed(Option.none()),
    getInBrowser: Effect.succeed({ _tag: "Authorized", token }),
    hasCredential: Effect.succeed(false),
    store: () => Effect.void,
    clear: Effect.void,
    ...overrides,
  });
const config = (enabled = true) =>
  Effect.provide(
    ConfigProvider.layer(
      ConfigProvider.fromEnv({
        env: {
          VITRE_CLOUD_DESKTOP_ENABLED: String(enabled),
          T3CODE_RELAY_URL: "https://cloud.example.test",
        },
      }),
    ),
  );

it.effect("disabled capability never accesses credentials", () =>
  Effect.gen(function* () {
    assert.deepEqual(yield* desktopCloudSession(true).pipe(config(false)), {
      enabled: false,
      relayUrl: null,
      accessToken: null,
      expiresAtEpochMs: null,
    });
  }),
);

it.effect("status does not start interactive login", () =>
  Effect.gen(function* () {
    const result = yield* desktopCloudSession(false).pipe(
      config(),
      Effect.provideService(
        CloudCliTokenManager,
        manager({ getInBrowser: Effect.die("status must not open browser") }),
      ),
    );
    assert.isNull(result.accessToken);
  }),
);

it.effect("returns only access credentials for an existing session", () =>
  Effect.gen(function* () {
    const result = yield* desktopCloudSession(false).pipe(
      config(),
      Effect.provideService(
        CloudCliTokenManager,
        manager({ getExisting: Effect.succeed(Option.some(token)) }),
      ),
    );
    assert.deepEqual(result, {
      enabled: true,
      relayUrl: "https://cloud.example.test",
      accessToken: "access",
      expiresAtEpochMs: 12345,
    });
  }),
);

it.effect("explicit sign-in recovers a rejected refresh using the browser flow", () =>
  Effect.gen(function* () {
    const result = yield* desktopCloudSession(true).pipe(
      config(),
      Effect.provideService(
        CloudCliTokenManager,
        manager({
          getExisting: Effect.fail(
            new CloudCliCredentialRefreshError({ cause: "secret refresh response" }),
          ),
        }),
      ),
    );
    assert.equal(result.accessToken, "access");
  }),
);

it.effect("status failure does not expose credential errors", () =>
  Effect.gen(function* () {
    const result = yield* desktopCloudSession(false).pipe(
      config(),
      Effect.provideService(
        CloudCliTokenManager,
        manager({
          getExisting: Effect.fail(
            new CloudCliCredentialRefreshError({ cause: "secret refresh response" }),
          ),
        }),
      ),
      Effect.flip,
    );
    assert.equal(result._tag, "CloudDesktopAuthError");
    assert.notInclude(result.message, "secret");
  }),
);

it.effect("cancel bypasses credential reads and never starts a browser", () =>
  Effect.gen(function* () {
    let cancelled = false;
    const result = yield* desktopCloudSession(false, true).pipe(
      config(),
      Effect.provideService(
        CloudCliTokenManager,
        manager({
          getExisting: Effect.die("must not wait behind pending login"),
          getInBrowser: Effect.die("must not reopen browser"),
          cancelLogin: Effect.sync(() => {
            cancelled = true;
          }),
        }),
      ),
    );
    assert.isTrue(cancelled);
    assert.isNull(result.accessToken);
  }),
);
