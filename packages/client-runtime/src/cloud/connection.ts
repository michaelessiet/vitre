import { EnvironmentId } from "@t3tools/contracts";
import type { CloudTask } from "@t3tools/contracts/cloud";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import { HttpClient } from "effect/unstable/http";
import {
  bootstrapRemoteBearerSession,
  resolveRemoteWebSocketConnectionUrl,
} from "../authorization/remote.ts";
import { ConnectionDriver } from "../connection/driver.ts";
import {
  ConnectionBlockedError,
  ConnectionTransientError,
  RelayConnectionTarget,
} from "../connection/model.ts";
import * as Supervisor from "../connection/supervisor.ts";
import * as Session from "../rpc/session.ts";
import type { CloudClient } from "./index.ts";

/** One foreground cloud task, using the same scoped transport/retry owner as desktop. */
export function cloudConversationLayer(client: CloudClient, task: CloudTask) {
  const target = new RelayConnectionTarget({
    environmentId: EnvironmentId.make(task.worker?.environmentId ?? `cloud-${task.id}`),
    label: task.title ?? task.repository.name,
  });
  const driver = Layer.effect(
    ConnectionDriver,
    Effect.gen(function* () {
      const sessions = yield* Session.RpcSessionFactory;
      const httpClient = yield* HttpClient.HttpClient;
      return ConnectionDriver.of({
        connect: (_entry, report) =>
          Effect.gen(function* () {
            yield* report({ stage: "preparing" });
            const connection = yield* Effect.tryPromise({
              try: () => client.connection(task.id),
              catch: (error) =>
                new ConnectionTransientError({
                  reason: "endpoint-unavailable",
                  detail: error instanceof Error ? error.message : "Cloud computer is unavailable",
                }),
            });
            if (connection.environmentId !== target.environmentId)
              return yield* new ConnectionBlockedError({
                reason: "configuration",
                detail: "Cloud computer changed. Refresh the conversation.",
              });
            const credentials = yield* bootstrapRemoteBearerSession({
              httpBaseUrl: connection.httpBaseUrl,
              credential: connection.bootstrapToken,
              clientMetadata: { label: "Vitre Mobile", deviceType: "mobile" },
            }).pipe(
              Effect.mapError(
                () =>
                  new ConnectionTransientError({
                    reason: "remote-unavailable",
                    detail: "Could not authenticate the cloud computer",
                  }),
              ),
            );
            const socketUrl = yield* resolveRemoteWebSocketConnectionUrl({
              httpBaseUrl: connection.httpBaseUrl,
              wsBaseUrl: connection.httpBaseUrl.replace(/^https:/, "wss:"),
              bearerToken: credentials.access_token,
            }).pipe(
              Effect.mapError(
                () =>
                  new ConnectionTransientError({
                    reason: "remote-unavailable",
                    detail: "Could not open the cloud connection",
                  }),
              ),
            );
            const prepared = {
              environmentId: target.environmentId,
              label: target.label,
              target,
              httpBaseUrl: connection.httpBaseUrl,
              socketUrl,
              httpAuthorization: { _tag: "Bearer" as const, token: credentials.access_token },
            };
            yield* report({ stage: "opening", prepared });
            const session = yield* sessions.connect(prepared);
            yield* report({ stage: "synchronizing", prepared });
            yield* session.ready;
            return { prepared, session };
          }).pipe(Effect.provideService(HttpClient.HttpClient, httpClient)),
      });
    }),
  ).pipe(Layer.provide(Session.layer));
  return Supervisor.layer({ target, profile: Option.none() }, { initiallyDesired: true }).pipe(
    Layer.provide(driver),
  );
}
