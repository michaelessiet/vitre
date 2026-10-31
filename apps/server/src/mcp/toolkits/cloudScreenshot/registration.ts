import * as Config from "effect/Config";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import { McpSchema, McpServer } from "effect/unstable/ai";
import { McpInvocationContext, requireMcpCapability } from "../../McpInvocationContext.ts";
import { ServerConfig } from "../../../config.ts";
import { captureScreenshot, saveScreenshot } from "./capture.ts";

const input = Schema.Struct({
  port: Schema.Int.check(Schema.isBetween({ minimum: 1024, maximum: 65535 })),
  path: Schema.optional(Schema.String.check(Schema.isMaxLength(2048))),
  width: Schema.optional(Schema.Int.check(Schema.isBetween({ minimum: 320, maximum: 2560 }))),
  height: Schema.optional(Schema.Int.check(Schema.isBetween({ minimum: 320, maximum: 2560 }))),
  fullPage: Schema.optional(Schema.Boolean),
  waitForSelector: Schema.optional(Schema.String.check(Schema.isMaxLength(1024))),
});
const decode = Schema.decodeUnknownEffect(input);
const encodeJson = Schema.encodeSync(Schema.UnknownFromJsonString);
class CloudScreenshotError extends Schema.TaggedErrorClass<CloudScreenshotError>()(
  "CloudScreenshotError",
  { message: Schema.String },
) {}

export const register = Effect.gen(function* () {
  const enabled = yield* Config.boolean("VITRE_CLOUD_SCREENSHOTS").pipe(Config.withDefault(false));
  if (!enabled) return;
  const server = yield* McpServer.McpServer;
  const config = yield* ServerConfig;
  yield* server.addTool({
    tool: new McpSchema.Tool({
      name: "cloud_screenshot",
      description:
        "Take a PNG screenshot of a frontend running in this cloud workspace when the user asks to see or verify its UI. First start the development server on a loopback port. Supply its port and path, optionally a viewport, fullPage, and a CSS selector to wait for. Returns the image directly and saves a PNG in the workspace. Include the returned path when sharing the screenshot with the user. This uses an isolated Chromium browser with no signed-in profile; never claim a screenshot was taken unless the tool succeeds. Use only when the user requests screenshots or visual verification.",
      inputSchema: Schema.toJsonSchemaDocument(input).schema,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
    }),
    annotations: Context.empty(),
    handle: (payload) =>
      Effect.withFiber((fiber) => {
        const invocation = Context.getUnsafe(fiber.context, McpInvocationContext);
        return Effect.gen(function* () {
          yield* requireMcpCapability("preview");
          const params = yield* decode(payload);
          const result = yield* Effect.tryPromise({
            try: () => captureScreenshot(params, config.port),
            catch: (error) =>
              new CloudScreenshotError({
                message: error instanceof Error ? error.message : "Screenshot failed",
              }),
          });
          const path = yield* Effect.tryPromise({
            try: () => saveScreenshot(config.cwd, result.png),
            catch: () =>
              new CloudScreenshotError({
                message: "Could not save the screenshot in this workspace",
              }),
          });
          const metadata = {
            path,
            url: result.url,
            width: result.width,
            height: result.height,
            mimeType: "image/png",
          };
          return new McpSchema.CallToolResult({
            isError: false,
            structuredContent: metadata,
            content: [
              { type: "text", text: encodeJson(metadata) },
              { type: "image", mimeType: "image/png", data: new Uint8Array(result.png) },
            ],
          });
        }).pipe(
          Effect.provideService(McpInvocationContext, invocation),
          Effect.catch((error) =>
            Effect.succeed(
              new McpSchema.CallToolResult({
                isError: true,
                content: [
                  {
                    type: "text",
                    text: error instanceof Error ? error.message : "Cloud screenshot failed.",
                  },
                ],
              }),
            ),
          ),
        );
      }),
  });
});
export const CloudScreenshotRegistrationLive = Layer.effectDiscard(register);
