/**
 * SubagentSummaryReactor - one-line progress summaries for running subagents.
 *
 * @module SubagentSummaryReactor
 */
import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";
import type * as Scope from "effect/Scope";

export interface SubagentSummaryReactorShape {
  /** Start watching task activities. Run in a scope; summaries in flight end with it. */
  readonly start: () => Effect.Effect<void, never, Scope.Scope>;
  /** Resolves when no activity is waiting to be observed. For tests. */
  readonly drain: Effect.Effect<void>;
}

export class SubagentSummaryReactor extends Context.Service<
  SubagentSummaryReactor,
  SubagentSummaryReactorShape
>()("t3/orchestration/Services/SubagentSummaryReactor") {}
