import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import { McpSchema, McpServer } from "effect/unstable/ai";
import { parseVisual, VISUAL_INSTRUCTIONS } from "@t3tools/shared/visual";

const decode = Schema.decodeUnknownSync(
  Schema.Struct({ source: Schema.String.check(Schema.isMaxLength(65536)) }),
);

export const VisualToolkitRegistrationLive = Layer.effectDiscard(
  Effect.gen(function* () {
    const server = yield* McpServer.McpServer;
    for (const name of ["visual_docs", "visual_check"] as const) {
      const schema =
        name === "visual_docs"
          ? Schema.Struct({})
          : Schema.Struct({ source: Schema.String.check(Schema.isMaxLength(65536)) });
      yield* server.addTool({
        tool: new McpSchema.Tool({
          name,
          description:
            name === "visual_docs"
              ? "Read Vitre's native inline visualization format and limits."
              : "Validate a native visualization JSON source before including it in a vitre-visual fenced block in your assistant response. Does not publish or execute anything.",
          inputSchema: Schema.toJsonSchemaDocument(schema).schema,
          annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
        }),
        annotations: Context.empty(),
        handle: (payload: unknown) =>
          Effect.sync(() => {
            try {
              if (name === "visual_docs")
                return new McpSchema.CallToolResult({
                  content: [{ type: "text", text: VISUAL_INSTRUCTIONS }],
                });
              const value = decode(payload);
              const spec = parseVisual(value.source);
              return new McpSchema.CallToolResult({
                content: [
                  {
                    type: "text",
                    text: `Valid: ${spec.title}. Include this JSON in a vitre-visual fenced block in your response.`,
                  },
                ],
              });
            } catch {
              return new McpSchema.CallToolResult({
                isError: true,
                content: [
                  {
                    type: "text",
                    text: "Invalid visual. Check visual_docs for supported fields, required data, and size limits.",
                  },
                ],
              });
            }
          }),
      });
    }
  }),
);
