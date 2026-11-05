import { EnvironmentHttpApi, EnvironmentHttpForbiddenError } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as HttpApiBuilder from "effect/unstable/httpapi/HttpApiBuilder";

const removed = Effect.fail(
  new EnvironmentHttpForbiddenError({
    message: "Cloud has been removed from this desktop build.",
  }),
);

export const connectHttpApiLayer = HttpApiBuilder.group(
  EnvironmentHttpApi,
  "connect",
  Effect.fnUntraced(function* (handlers) {
    return handlers
      .handle("linkProof", () => removed)
      .handle("relayConfig", () => removed)
      .handle("linkState", () => removed)
      .handle("unlink", () => removed)
      .handle("preferences", () => removed)
      .handle("health", () => removed)
      .handle("mintCredential", () => removed)
      .handle("t3MintCredential", () => removed);
  }),
);
