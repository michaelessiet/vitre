import {
  ServerSelfUpdateError,
  type ServerSelfUpdateInput,
  type ServerSelfUpdateResult,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as ServerConfig from "./config.ts";

export const resolveServerSelfUpdateCapability = (input: { readonly desktopManaged: boolean }) =>
  Effect.succeed(input.desktopManaged ? ("desktop-managed" as const) : null);

export class ServerSelfUpdate extends Context.Service<
  ServerSelfUpdate,
  {
    readonly update: (
      input: ServerSelfUpdateInput,
    ) => Effect.Effect<ServerSelfUpdateResult, ServerSelfUpdateError>;
  }
>()("t3/serverSelfUpdate") {}

const make = Effect.gen(function* () {
  const serverConfig = yield* ServerConfig.ServerConfig;
  const capability = yield* resolveServerSelfUpdateCapability({
    desktopManaged: serverConfig.mode === "desktop",
  });
  return ServerSelfUpdate.of({
    update: () =>
      Effect.fail(
        new ServerSelfUpdateError({
          reason:
            capability === "desktop-managed"
              ? "This server is managed by the Vitre desktop app on its machine; update the desktop app to update it."
              : "This server cannot update itself; relaunch it manually with the new version.",
        }),
      ),
  });
});

export const layer = Layer.effect(ServerSelfUpdate, make);
