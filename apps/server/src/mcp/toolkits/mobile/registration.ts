import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import { McpSchema, McpServer } from "effect/unstable/ai";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import { PreviewAutomationBroker } from "../../PreviewAutomationBroker.ts";

const coordinate = Schema.Number.check(Schema.isBetween({ minimum: 0, maximum: 1 }));
const point = { x: coordinate, y: coordinate };
const empty = Schema.Struct({});
const definitions = [
  {
    action: "devices",
    description:
      "List configured iOS simulators and Android emulators on the connected Vitre desktop, including stopped devices and their running state.",
    schema: empty,
  },
  {
    action: "open",
    description:
      "Start a listed device if stopped and connect it to Vitre's native Devices panel in this thread. A cold boot may return starting: true; poll mobile_status until connected or error. One thread owns the device at a time.",
    schema: Schema.Struct({
      deviceId: Schema.String.check(Schema.isNonEmpty(), Schema.isMaxLength(256)),
    }),
  },
  {
    action: "status",
    description:
      "Read the connected device and native display frame rate. Idle screens may produce zero new frames.",
    schema: empty,
  },
  {
    action: "screenshot",
    description:
      "Capture the connected device as an image. Inspect it before interacting, and capture again to verify results.",
    schema: empty,
  },
  {
    action: "tap",
    description:
      "Tap the device at normalized screen coordinates (0,0 top left; 1,1 bottom right). Take a screenshot first.",
    schema: Schema.Struct(point),
  },
  {
    action: "swipe",
    description:
      "Drag between normalized screen coordinates over durationMs (50–5000ms). Inspect a screenshot before and after.",
    schema: Schema.Struct({
      from: Schema.Struct(point),
      to: Schema.Struct(point),
      durationMs: Schema.Int.check(Schema.isBetween({ minimum: 50, maximum: 5000 })),
    }),
  },
  {
    action: "type",
    description:
      "Type into the focused device field. Native keyboard input currently supports ASCII text. Take a screenshot first to confirm focus.",
    schema: Schema.Struct({
      text: Schema.String.check(
        Schema.isMaxLength(1024),
        Schema.makeFilter((text: string) =>
          [...text].every((c) => c.charCodeAt(0) > 0 && c.charCodeAt(0) < 128),
        ),
      ),
    }),
  },
  {
    action: "press",
    description: "Press a device hardware button. Back and AppSwitch are Android only.",
    schema: Schema.Struct({ key: Schema.Literals(["GoHome", "GoBack", "AppSwitch", "Power"]) }),
  },
  {
    action: "stop",
    description:
      "Shut down this thread's selected simulator/emulator and release its display. Wait for startup to finish first. If stopping: true is returned, poll mobile_status until stopped or error. Use mobile_open to start it again.",
    schema: empty,
  },
  {
    action: "close",
    description:
      "Disconnect this thread's native Devices panel, leaving the simulator/emulator running.",
    schema: empty,
  },
] as const;
const encodeJson = Schema.encodeSync(Schema.UnknownFromJsonString);
const Screenshot = Schema.Struct({ data: Schema.String, mimeType: Schema.Literal("image/png") });
const decodeScreenshot = Schema.decodeUnknownEffect(Screenshot);

export const register = Effect.gen(function* () {
  const server = yield* McpServer.McpServer;
  const broker = yield* PreviewAutomationBroker;
  for (const definition of definitions) {
    const schema: Schema.Codec<unknown> = definition.schema;
    const decodeInput = Schema.decodeUnknownEffect(schema);
    yield* server.addTool({
      tool: new McpSchema.Tool({
        name: `mobile_${definition.action}`,
        description: definition.description,
        inputSchema: Schema.toJsonSchemaDocument(schema).schema,
        annotations: {
          readOnlyHint: ["devices", "status", "screenshot"].includes(definition.action),
          destructiveHint: definition.action === "stop",
          openWorldHint: false,
        },
      }),
      annotations: Context.empty(),
      handle: (payload: unknown) =>
        Effect.withFiber((fiber) => {
          const invocation = Context.getUnsafe(
            fiber.context,
            McpInvocationContext.McpInvocationContext,
          );
          return Effect.gen(function* () {
            const scope = yield* McpInvocationContext.requireMcpCapability("preview");
            const parameters = yield* decodeInput(payload ?? {});
            const result = yield* broker.invoke({
              scope,
              operation: "mobile",
              input: { action: definition.action, parameters },
              timeoutMs: 30_000,
            });
            if (definition.action === "screenshot") {
              const screenshot = yield* decodeScreenshot(result);
              return new McpSchema.CallToolResult({
                isError: false,
                content: [
                  {
                    type: "image",
                    mimeType: screenshot.mimeType,
                    data: new Uint8Array(Buffer.from(screenshot.data, "base64")),
                  },
                ],
              });
            }
            return new McpSchema.CallToolResult({
              isError: false,
              content: [{ type: "text", text: encodeJson(result) }],
            });
          }).pipe(
            Effect.provideService(McpInvocationContext.McpInvocationContext, invocation),
            Effect.catch((error) =>
              Effect.succeed(
                new McpSchema.CallToolResult({
                  isError: true,
                  content: [{ type: "text", text: error.message }],
                }),
              ),
            ),
          );
        }),
    });
  }
});
export const MobileToolkitRegistrationLive = Layer.effectDiscard(register);
