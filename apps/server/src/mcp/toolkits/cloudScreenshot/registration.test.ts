import { expect, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { vi } from "vite-plus/test";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { McpSchema, McpServer } from "effect/unstable/ai";
import { EnvironmentId, ThreadId, ProviderInstanceId } from "@t3tools/contracts";
import { layerTest } from "../../../config.ts";
import { McpInvocationContext, type McpCapability } from "../../McpInvocationContext.ts";
import { CloudScreenshotRegistrationLive } from "./registration.ts";
import { captureScreenshot } from "./capture.ts";
vi.mock("./capture.ts", () => ({
  captureScreenshot: vi.fn(async () => ({
    png: Buffer.from([1, 2, 3]),
    url: "http://127.0.0.1:3000/",
    width: 1280,
    height: 800,
  })),
  saveScreenshot: async () => "/workspace/.vitre-screenshot-test/screenshot.png",
}));
const layers = (enabled: boolean) =>
  CloudScreenshotRegistrationLive.pipe(
    Layer.provideMerge(McpServer.McpServer.layer),
    Layer.provide(layerTest("/workspace", { prefix: "vitre-screenshot-test-" })),
    Layer.provide(NodeServices.layer),
    Layer.provide(
      ConfigProvider.layer(
        ConfigProvider.fromEnv({ env: { VITRE_CLOUD_SCREENSHOTS: String(enabled) } }),
      ),
    ),
  );
it.effect("is unavailable outside cloud workers", () =>
  Effect.gen(function* () {
    const server = yield* McpServer.McpServer;
    expect(server.tools).toHaveLength(0);
  }).pipe(Effect.provide(layers(false))),
);
it.effect("checks the session capability and returns the image and saved artifact", () =>
  Effect.gen(function* () {
    const server = yield* McpServer.McpServer;
    const invoke = (allowed: boolean) =>
      server.callTool({ name: "cloud_screenshot", arguments: { port: 3000 } }).pipe(
        Effect.provideService(McpInvocationContext, {
          environmentId: EnvironmentId.make("cloud"),
          threadId: ThreadId.make("thread"),
          providerSessionId: "session",
          providerInstanceId: ProviderInstanceId.make("codex"),
          capabilities: new Set<McpCapability>(allowed ? ["preview"] : []),
          issuedAt: 0,
          expiresAt: Number.MAX_SAFE_INTEGER,
        }),
      );
    expect((yield* invoke(false)).isError).toBe(true);
    expect(captureScreenshot).not.toHaveBeenCalled();
    const result = yield* invoke(true);
    expect(result.isError).toBe(false);
    expect(result.structuredContent).toMatchObject({
      path: "/workspace/.vitre-screenshot-test/screenshot.png",
    });
    expect(result.content[1]).toEqual({
      type: "image",
      mimeType: "image/png",
      data: new Uint8Array([1, 2, 3]),
    });
    expect(captureScreenshot).toHaveBeenCalledWith({ port: 3000 }, 0);
  }).pipe(
    Effect.provide(layers(true)),
    Effect.provideService(McpSchema.McpServerClient, {
      clientId: 1,
      initializePayload: {
        protocolVersion: "2025-03-26",
        capabilities: {},
        clientInfo: { name: "test", version: "1" },
      },
      getClient: Effect.die("unused"),
    }),
  ),
);
