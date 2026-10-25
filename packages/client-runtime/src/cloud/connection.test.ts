import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { bootstrapRemoteBearerSession } from "../authorization/remote.ts";
import {
  RemoteEnvironmentAuthFetchError,
  RemoteEnvironmentAuthInvalidJsonError,
  RemoteEnvironmentAuthTimeoutError,
  remoteHttpClientLayer,
} from "../rpc/http.ts";
import { cloudEnvironmentConnectionError } from "./connection.ts";

const encodeJson = Schema.encodeSync(Schema.UnknownFromJsonString);

describe("cloud computer connection diagnostics", () => {
  it.effect("surfaces a rejected bootstrap credential without exposing it", () =>
    Effect.gen(function* () {
      const error = yield* bootstrapRemoteBearerSession({
        httpBaseUrl: "https://worker.example.test",
        credential: "private-bootstrap-token",
      }).pipe(
        Effect.mapError((error) => cloudEnvironmentConnectionError(error, "authentication")),
        Effect.flip,
        Effect.provide(
          remoteHttpClientLayer(async () =>
            Response.json(
              {
                _tag: "EnvironmentAuthInvalidError",
                code: "auth_invalid",
                reason: "invalid_credential",
                traceId: "request-123",
              },
              { status: 401 },
            ),
          ),
        ),
      );
      expect(error.detail).toContain("HTTP 401; invalid_credential");
      expect(error.traceId).toBe("request-123");
      expect(encodeJson(error)).not.toContain("private-bootstrap-token");
    }),
  );

  it.effect("distinguishes a tunnel HTTP failure from invalid credentials", () =>
    Effect.gen(function* () {
      const error = yield* bootstrapRemoteBearerSession({
        httpBaseUrl: "https://worker.example.test",
        credential: "private-bootstrap-token",
      }).pipe(
        Effect.mapError((error) => cloudEnvironmentConnectionError(error, "authentication")),
        Effect.flip,
        Effect.provide(
          remoteHttpClientLayer(async () => new Response("private upstream body", { status: 502 })),
        ),
      );
      expect(error.detail).toContain("HTTP 502");
      expect(encodeJson(error)).not.toContain("private");
    }),
  );

  it("does not include raw response, network cause, or endpoint credentials", () => {
    const errors = [
      new RemoteEnvironmentAuthFetchError({
        message: "private request body",
        cause: new Error("private request headers"),
      }),
      new RemoteEnvironmentAuthInvalidJsonError({
        message: "private response body",
        cause: new Error("private access_token"),
      }),
      new RemoteEnvironmentAuthTimeoutError("https://private@example.test", 10000),
    ];
    const mapped = errors.map((error) => cloudEnvironmentConnectionError(error, "connection"));
    expect(mapped.map((error) => error.reason)).toEqual([
      "network",
      "remote-unavailable",
      "timeout",
    ]);
    for (const error of mapped) expect(encodeJson(error)).not.toContain("private");
  });
});
