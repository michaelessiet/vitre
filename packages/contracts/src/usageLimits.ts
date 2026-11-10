/**
 * Provider plan limits: how much of each subscription window is used and
 * when it resets, as the providers report them. Schema only.
 */
import * as Schema from "effect/Schema";

import { IsoDateTime, TrimmedNonEmptyString } from "./baseSchemas.ts";
import { ProviderDriverKind, ProviderInstanceId } from "./providerInstance.ts";

export const UsageLimitStatus = Schema.Literals(["ok", "warning", "exceeded"]);
export type UsageLimitStatus = typeof UsageLimitStatus.Type;

/** One limit window, e.g. Claude's 5-hour session or Codex's weekly limit. */
export const UsageLimitWindow = Schema.Struct({
  /** Stable per provider, e.g. `five_hour`, `seven_day`, `primary`. */
  id: TrimmedNonEmptyString,
  label: TrimmedNonEmptyString,
  /** 0–100, when the provider reports it. */
  usedPercent: Schema.optional(Schema.Number),
  resetsAt: Schema.optional(IsoDateTime),
  status: UsageLimitStatus,
});
export type UsageLimitWindow = typeof UsageLimitWindow.Type;

export const ProviderUsageLimits = Schema.Struct({
  instanceId: ProviderInstanceId,
  driver: ProviderDriverKind,
  displayName: TrimmedNonEmptyString,
  /** The subscription, e.g. `Max` or `Pro`, when reported. */
  planLabel: Schema.optional(TrimmedNonEmptyString),
  /** Whether the provider reports limit windows at all. */
  reportsWindows: Schema.Boolean,
  windows: Schema.Array(UsageLimitWindow),
  /** Set when a turn failed on a limit; cleared when a later turn succeeds. */
  limitReached: Schema.optional(
    Schema.Struct({
      at: IsoDateTime,
      message: TrimmedNonEmptyString,
    }),
  ),
  /** Where the person can see the provider's own usage page. */
  dashboardUrl: Schema.optional(TrimmedNonEmptyString),
  /** Why there are no windows, e.g. "Cursor doesn't report plan limits to apps." */
  note: Schema.optional(TrimmedNonEmptyString),
  updatedAt: Schema.optional(IsoDateTime),
});
export type ProviderUsageLimits = typeof ProviderUsageLimits.Type;

export const ServerConfigUsageLimitsPayload = Schema.Struct({
  limits: Schema.Array(ProviderUsageLimits),
});
export type ServerConfigUsageLimitsPayload = typeof ServerConfigUsageLimitsPayload.Type;
