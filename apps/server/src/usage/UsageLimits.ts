/**
 * UsageLimits - the latest plan limits for every provider instance.
 *
 * Watches provider runtime events for rate-limit snapshots and limit
 * failures, keeps one `ProviderUsageLimits` per instance, persists them so
 * the dock shows the last known state after a restart, and streams changes
 * to clients over `subscribeServerConfig`.
 *
 * @module UsageLimits
 */
import type { ProviderInstanceId, ProviderUsageLimits } from "@t3tools/contracts";
import { ProviderUsageLimits as ProviderUsageLimitsSchema } from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as PubSub from "effect/PubSub";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";

import { writeFileStringAtomically } from "../atomicWrite.ts";
import { ServerConfig } from "../config.ts";
import { ProviderInstanceRegistry } from "../provider/Services/ProviderInstanceRegistry.ts";
import { ProviderService } from "../provider/Services/ProviderService.ts";
import { applyUsageEvent, emptyLimits, expireWindows } from "./limitWindows.ts";

export interface UsageLimitsShape {
  /** Every provider instance's limits, in registry order. */
  readonly snapshot: Effect.Effect<ReadonlyArray<ProviderUsageLimits>>;
  /** The full list again whenever any instance's limits change. */
  readonly changes: Stream.Stream<ReadonlyArray<ProviderUsageLimits>>;
}

export class UsageLimits extends Context.Service<UsageLimits, UsageLimitsShape>()(
  "t3/usage/UsageLimits",
) {}

const PersistedLimits = Schema.Array(ProviderUsageLimitsSchema);
const PersistedLimitsJson = Schema.fromJsonString(PersistedLimits);
const decodePersisted = Schema.decodeUnknownOption(PersistedLimitsJson);
const encodePersisted = Schema.encodeEffect(PersistedLimitsJson);

const DRIVER_NAMES: Record<string, string> = {
  claudeAgent: "Claude",
  codex: "Codex",
  cursor: "Cursor",
  grok: "Grok",
  opencode: "OpenCode",
};

const make = Effect.gen(function* () {
  const providerService = yield* ProviderService;
  const instances = yield* ProviderInstanceRegistry;
  const config = yield* ServerConfig;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const filePath = path.join(config.stateDir, "usage-limits.json");

  const raw = yield* fs.readFileString(filePath).pipe(Effect.orElseSucceed(() => ""));
  const restored = raw ? decodePersisted(raw) : undefined;
  const stored = yield* Ref.make(
    new Map<string, ProviderUsageLimits>(
      (restored && restored._tag === "Some" ? restored.value : []).map((limits) => [
        limits.instanceId,
        limits,
      ]),
    ),
  );
  const pubsub = yield* PubSub.unbounded<ReadonlyArray<ProviderUsageLimits>>();

  /** One entry per registered instance, in registry order, with stored state applied. */
  const snapshot = Effect.gen(function* () {
    const registered = yield* instances.listInstances;
    const current = yield* Ref.get(stored);
    const now = yield* Clock.currentTimeMillis;
    return registered.map((instance) => {
      const base = emptyLimits({
        instanceId: instance.instanceId,
        driver: instance.driverKind,
        displayName:
          instance.displayName ?? DRIVER_NAMES[instance.driverKind] ?? instance.driverKind,
      });
      const known = current.get(instance.instanceId);
      // Capabilities and names come from the driver now; usage from what was seen.
      return expireWindows(
        known
          ? {
              ...base,
              ...(known.planLabel ? { planLabel: known.planLabel } : {}),
              windows: known.windows,
              ...(known.limitReached ? { limitReached: known.limitReached } : {}),
              ...(known.updatedAt ? { updatedAt: known.updatedAt } : {}),
            }
          : base,
        now,
      );
    });
  });

  const instanceFor = Effect.fn("instanceFor")(function* (
    instanceId: ProviderInstanceId | undefined,
    driver: string,
  ) {
    const registered = yield* instances.listInstances;
    return (
      registered.find((instance) => instance.instanceId === instanceId) ??
      registered.find((instance) => instance.driverKind === driver)
    );
  });

  yield* Stream.runForEach(providerService.streamEvents, (event) =>
    Effect.gen(function* () {
      if (
        event.type !== "account.rate-limits.updated" &&
        event.type !== "runtime.error" &&
        event.type !== "turn.completed"
      ) {
        return;
      }
      const instance = yield* instanceFor(event.providerInstanceId, event.provider);
      if (!instance) return;
      const all = yield* snapshot;
      const current = all.find((limits) => limits.instanceId === instance.instanceId);
      if (!current) return;
      const next = applyUsageEvent(current, event);
      if (!next) return;
      yield* Ref.update(stored, (map) => new Map(map).set(instance.instanceId, next));
      const updated = yield* snapshot;
      yield* PubSub.publish(pubsub, updated);
      const persisted = [...(yield* Ref.get(stored)).values()];
      yield* encodePersisted(persisted).pipe(
        Effect.flatMap((contents) => writeFileStringAtomically({ filePath, contents })),
        Effect.ignoreCause({ log: true }),
      );
    }).pipe(Effect.ignoreCause({ log: true })),
  ).pipe(Effect.forkScoped);

  return UsageLimits.of({
    snapshot,
    changes: Stream.fromPubSub(pubsub),
  });
});

export const layer = Layer.effect(UsageLimits, make);
