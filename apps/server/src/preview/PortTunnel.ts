// @effect-diagnostics nodeBuiltinImport:off - Authenticated loopback TCP bridge.
import * as NodeStream from "@effect/platform-node/NodeStream";
import * as NodeNet from "node:net";
import { AuthTerminalOperateScope } from "@t3tools/contracts";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/unstable/http";
import { EnvironmentAuth } from "../auth/EnvironmentAuth.ts";
import { ServerConfig } from "../config.ts";

class PreviewTunnelError extends Data.TaggedError("PreviewTunnelError")<{
  readonly cause: unknown;
}> {}

export function previewPort(path: string, backendPort: number): number | null {
  const match = /^\/api\/preview\/tunnel\/(\d+)$/.exec(path.split("?")[0]!);
  if (!match) return null;
  const port = Number(match[1]);
  return port >= 1024 && port <= 65535 && port !== backendPort ? port : null;
}

export const previewPortTunnelLayer = HttpRouter.add(
  "GET",
  "/api/preview/tunnel/:port",
  Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest;
    const auth = yield* EnvironmentAuth;
    const session = yield* auth.authenticateWebSocketUpgrade(request);
    if (!session.scopes.includes(AuthTerminalOperateScope))
      return HttpServerResponse.empty({ status: 403 });
    const config = yield* ServerConfig;
    const port = previewPort(request.url, config.port);
    if (!port) return HttpServerResponse.empty({ status: 400 });
    return yield* Effect.scoped(
      Effect.gen(function* () {
        const tcp = yield* Effect.acquireRelease(
          Effect.tryPromise({
            try: (signal) =>
              new Promise<NodeNet.Socket>((resolve, reject) => {
                const socket = NodeNet.createConnection({ host: "127.0.0.1", port, signal });
                socket.setTimeout(30_000, () =>
                  socket.destroy(new Error("Preview connection timed out")),
                );
                socket.once("error", reject);
                socket.once("connect", () => {
                  socket.setTimeout(0);
                  resolve(socket);
                });
              }),
            catch: (cause) => new PreviewTunnelError({ cause }),
          }),
          (socket) =>
            Effect.sync(() => {
              socket.destroy();
            }),
        );
        const websocket = yield* request.upgrade;
        const write = yield* websocket.writer;
        const incoming = websocket.run((bytes) =>
          Effect.tryPromise(
            () =>
              new Promise<void>((resolve, reject) => {
                tcp.write(bytes, (error) => (error ? reject(error) : resolve()));
              }),
          ),
        );
        const outgoing = NodeStream.fromReadable<Uint8Array, PreviewTunnelError>({
          evaluate: () => tcp,
          onError: (cause) => new PreviewTunnelError({ cause }),
        }).pipe(Stream.runForEach((bytes) => write(new Uint8Array(bytes as Buffer))));
        yield* Effect.raceFirst(incoming, outgoing);
        return HttpServerResponse.empty();
      }),
    );
  }).pipe(Effect.orElseSucceed(() => HttpServerResponse.empty({ status: 502 }))),
);
