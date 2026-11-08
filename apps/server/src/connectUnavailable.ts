import { EnvironmentHttpApi, EnvironmentHttpForbiddenError } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as HttpApiBuilder from "effect/unstable/httpapi/HttpApiBuilder";

const removed = Effect.fail(
  new EnvironmentHttpForbiddenError({
    message: "Vitre Cloud has been removed.",
  }),
);

export const connectHttpApiLayer = HttpApiBuilder.group(EnvironmentHttpApi, "connect", (handlers) =>
  Effect.succeed(
    handlers
      .handle("linkProof", () => removed)
      .handle("relayConfig", () => removed)
      .handle("linkState", () => removed)
      .handle("unlink", () => removed)
      .handle("preferences", () => removed)
      .handle("health", () => removed)
      .handle("mintCredential", () => removed)
      .handle("t3MintCredential", () => removed),
  ),
);
