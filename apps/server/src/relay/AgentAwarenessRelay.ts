import type { ThreadId } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type * as Scope from "effect/Scope";

/** Local desktop builds do not publish activity to a hosted relay. */
export class AgentAwarenessRelay extends Context.Service<
  AgentAwarenessRelay,
  {
    readonly publishThread: (threadId: ThreadId) => Effect.Effect<void>;
    readonly start: () => Effect.Effect<void, never, Scope.Scope>;
  }
>()("t3/relay/AgentAwarenessRelay") {}

export const layer = Layer.succeed(
  AgentAwarenessRelay,
  AgentAwarenessRelay.of({
    publishThread: () => Effect.void,
    start: () => Effect.void,
  }),
);
