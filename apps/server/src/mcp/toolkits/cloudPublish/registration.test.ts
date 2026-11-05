import { expect, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { McpSchema, McpServer } from "effect/unstable/ai";
import { EnvironmentId, ThreadId, ProviderInstanceId } from "@t3tools/contracts";
import { layerTest } from "../../../config.ts";
import { McpInvocationContext, type McpCapability } from "../../McpInvocationContext.ts";
import { CloudPublicationRequestFile, CloudPublishRegistrationLive } from "./registration.ts";

const decodeRequest = Schema.decodeUnknownSync(Schema.fromJsonString(CloudPublicationRequestFile));
const layers = (path: string) =>
  CloudPublishRegistrationLive.pipe(
    Layer.provideMerge(McpServer.McpServer.layer),
    Layer.provide(layerTest("/workspace", { prefix: "vitre-publish-test-" })),
    Layer.provide(NodeServices.layer),
    Layer.provide(
      ConfigProvider.layer(
        ConfigProvider.fromEnv({ env: { VITRE_CLOUD_PUBLICATION_REQUEST_PATH: path } }),
      ),
    ),
  );
const client = {
  clientId: 1,
  initializePayload: {
    protocolVersion: "2025-03-26",
    capabilities: {},
    clientInfo: { name: "test", version: "1" },
  },
  getClient: Effect.die("unused"),
};
it.effect("is unavailable outside cloud workers", () =>
  Effect.gen(function* () {
    const server = yield* McpServer.McpServer;
    expect(server.tools).toHaveLength(0);
  }).pipe(Effect.provide(layers(""))),
);
it.effect("records the agent's request for the worker after checking the session capability", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const directory = yield* fs.makeTempDirectory({ prefix: "vitre-publish-" });
    const target = path.join(directory, "nested", "request.json");
    yield* Effect.gen(function* () {
      const server = yield* McpServer.McpServer;
      const invoke = (allowed: boolean, args: Record<string, unknown>) =>
        server.callTool({ name: "cloud_create_pull_request", arguments: args }).pipe(
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
      const denied = yield* invoke(false, { title: "Add retries", body: "Adds retries." });
      expect(denied.isError).toBe(true);
      expect(yield* fs.readDirectory(directory)).toEqual([]);
      const blank = yield* invoke(true, { title: "   ", body: "" });
      expect(blank.isError).toBe(true);
      const result = yield* invoke(true, { title: " Add retries ", body: "Adds retries.\n" });
      expect(result.isError).toBe(false);
      expect(result.structuredContent).toEqual({
        requested: true,
        kind: "pull_request",
        title: "Add retries",
      });
      expect(decodeRequest(yield* fs.readFileString(target))).toEqual({
        kind: "pull_request",
        title: "Add retries",
        body: "Adds retries.",
      });
      expect(yield* fs.readDirectory(path.dirname(target))).toEqual(["request.json"]);
    }).pipe(
      Effect.provide(layers(target)),
      Effect.provideService(McpSchema.McpServerClient, client),
    );
  }).pipe(Effect.provide(NodeServices.layer)),
);
