import { expect, it } from "@effect/vitest";
import { EnvironmentId, ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { McpSchema, McpServer } from "effect/unstable/ai";
import { McpInvocationContext, type McpCapability } from "../../McpInvocationContext.ts";
import {
  PreviewAutomationBroker,
  type PreviewAutomationInvokeInput,
} from "../../PreviewAutomationBroker.ts";
import { MobileToolkitRegistrationLive } from "./registration.ts";

it.effect("routes native device tools to the authorized thread and returns screenshot images", () =>
  Effect.gen(function* () {
    const calls: PreviewAutomationInvokeInput[] = [];
    const layer = MobileToolkitRegistrationLive.pipe(
      Layer.provideMerge(McpServer.McpServer.layer),
      Layer.provide(
        Layer.mock(PreviewAutomationBroker)({
          invoke: <A>(request: PreviewAutomationInvokeInput) =>
            Effect.sync(() => {
              calls.push(request);
              return { mimeType: "image/png", data: "AQID" } as A;
            }),
        }),
      ),
    );
    const scope = {
      environmentId: EnvironmentId.make("native-env"),
      threadId: ThreadId.make("authorized-thread"),
      providerSessionId: "native-provider",
      providerInstanceId: ProviderInstanceId.make("codex"),
      issuedAt: 0,
      expiresAt: Number.MAX_SAFE_INTEGER,
    };
    yield* Effect.gen(function* () {
      const server = yield* McpServer.McpServer;
      const invoke = (name: string, args: Record<string, unknown>, allowed = true) =>
        server.callTool({ name, arguments: args }).pipe(
          Effect.provideService(McpInvocationContext, {
            ...scope,
            capabilities: new Set<McpCapability>(allowed ? ["preview"] : []),
          }),
        );
      expect(server.tools.map(({ tool }) => tool.name)).toEqual([
        "mobile_devices",
        "mobile_open",
        "mobile_status",
        "mobile_screenshot",
        "mobile_tap",
        "mobile_swipe",
        "mobile_type",
        "mobile_press",
        "mobile_close",
      ]);
      expect((yield* invoke("mobile_devices", {}, false)).isError).toBe(true);
      expect(calls).toHaveLength(0);
      for (const args of [
        { x: -1, y: 0 },
        { x: 0, y: 2 },
        { x: NaN, y: 0 },
        { x: "0", y: 0 },
      ])
        expect((yield* invoke("mobile_tap", args)).isError).toBe(true);
      expect(
        (yield* invoke("mobile_swipe", {
          from: { x: 0, y: 0 },
          to: { x: 1, y: 1 },
          durationMs: 100000,
        })).isError,
      ).toBe(true);
      expect((yield* invoke("mobile_type", { text: "é" })).isError).toBe(true);
      expect(calls).toHaveLength(0);
      expect(
        (yield* invoke("mobile_open", { deviceId: "emulator-5554", threadId: "other-thread" }))
          .isError,
      ).toBe(false);
      expect(calls[0]).toMatchObject({
        scope: { threadId: "authorized-thread" },
        operation: "mobile",
        input: { action: "open", parameters: { deviceId: "emulator-5554" } },
      });
      expect(
        (calls[0]?.input as { parameters: unknown } | undefined)?.parameters,
      ).not.toHaveProperty("threadId");
      const screenshot = yield* invoke("mobile_screenshot", {});
      expect(screenshot.isError).toBe(false);
      expect(screenshot.content).toEqual([
        { type: "image", mimeType: "image/png", data: new Uint8Array([1, 2, 3]) },
      ]);
      expect((yield* invoke("mobile_tap", { x: 0.2, y: 0.8 })).isError).toBe(false);
      expect(calls.at(-1)?.input).toEqual({ action: "tap", parameters: { x: 0.2, y: 0.8 } });
    }).pipe(
      Effect.provide(layer),
      Effect.provideService(
        McpSchema.McpServerClient,
        McpSchema.McpServerClient.of({
          clientId: 1,
          initializePayload: {
            protocolVersion: "2025-03-26",
            capabilities: {},
            clientInfo: { name: "native-mobile-test", version: "1" },
          },
          getClient: Effect.die("unused"),
        }),
      ),
    );
  }),
);
