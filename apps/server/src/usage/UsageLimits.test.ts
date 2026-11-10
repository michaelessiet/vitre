import * as NodeServices from "@effect/platform-node/NodeServices";
import { it } from "@effect/vitest";
import type { ProviderRuntimeEvent } from "@t3tools/contracts";
import { EventId, ProviderDriverKind, ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as PubSub from "effect/PubSub";
import * as Stream from "effect/Stream";
import { describe, expect } from "vite-plus/test";

import { ServerConfig } from "../config.ts";
import type { ProviderInstance } from "../provider/ProviderDriver.ts";
import { ProviderInstanceRegistry } from "../provider/Services/ProviderInstanceRegistry.ts";
import { ProviderService } from "../provider/Services/ProviderService.ts";
import * as UsageLimits from "./UsageLimits.ts";

const instance = (id: string, driver: string) =>
  ({
    instanceId: ProviderInstanceId.make(id),
    driverKind: ProviderDriverKind.make(driver),
    displayName: undefined,
  }) as unknown as ProviderInstance;

const claudeEvent: ProviderRuntimeEvent = {
  eventId: EventId.make("evt"),
  provider: ProviderDriverKind.make("claudeAgent"),
  providerInstanceId: ProviderInstanceId.make("claudeAgent"),
  threadId: ThreadId.make("thread-1"),
  createdAt: "2026-11-10T12:00:00.000Z",
  type: "account.rate-limits.updated",
  payload: {
    rateLimits: {
      rate_limit_info: {
        status: "allowed",
        rateLimitType: "seven_day",
        utilization: 0.3,
        resetsAt: 4_102_444_800,
      },
    },
  } as never,
};

const makeLayer = (events: PubSub.PubSub<ProviderRuntimeEvent>, prefix: string) =>
  UsageLimits.layer.pipe(
    Layer.provideMerge(
      Layer.succeed(ProviderService, {
        get streamEvents() {
          return Stream.fromPubSub(events);
        },
      } as unknown as ProviderService["Service"]),
    ),
    Layer.provideMerge(
      Layer.succeed(ProviderInstanceRegistry, {
        listInstances: Effect.succeed([
          instance("claudeAgent", "claudeAgent"),
          instance("cursor", "cursor"),
        ]),
      } as unknown as ProviderInstanceRegistry["Service"]),
    ),
    Layer.provideMerge(ServerConfig.layerTest(process.cwd(), { prefix })),
    Layer.provideMerge(NodeServices.layer),
  );

describe("UsageLimits", () => {
  it.effect("lists every instance, applies limit events and streams the change", () =>
    Effect.gen(function* () {
      const events = yield* PubSub.unbounded<ProviderRuntimeEvent>();
      yield* Effect.gen(function* () {
        const usage = yield* UsageLimits.UsageLimits;
        const initial = yield* usage.snapshot;
        expect(initial.map((limits) => [limits.displayName, limits.reportsWindows])).toEqual([
          ["Claude", true],
          ["Cursor", false],
        ]);

        const next = yield* Stream.runHead(usage.changes).pipe(Effect.forkChild);
        yield* Effect.yieldNow;
        yield* PubSub.publish(events, claudeEvent);
        const changed = yield* Fiber.join(next);
        expect(changed._tag).toBe("Some");
        const claude = (yield* usage.snapshot)[0];
        expect(claude?.windows).toEqual([
          {
            id: "seven_day",
            label: "Current week (all models)",
            usedPercent: 30,
            resetsAt: "2100-01-01T00:00:00.000Z",
            status: "ok",
          },
        ]);
      }).pipe(Effect.provide(makeLayer(events, "t3-usage-limits-")));
    }),
  );
});
