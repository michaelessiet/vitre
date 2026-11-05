import * as Config from "effect/Config";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Random from "effect/Random";
import * as Schema from "effect/Schema";
import { McpSchema, McpServer } from "effect/unstable/ai";
import { McpInvocationContext, requireMcpCapability } from "../../McpInvocationContext.ts";

const input = Schema.Struct({
  title: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(256)),
  body: Schema.String.check(Schema.isMaxLength(65536)),
});
const decode = Schema.decodeUnknownEffect(input);
/** File format read by the cloud worker once the turn settles. */
export const CloudPublicationRequestFile = Schema.Struct({
  kind: Schema.Literal("pull_request"),
  title: Schema.String,
  body: Schema.String,
});
const encodeRequest = Schema.encodeSync(Schema.fromJsonString(CloudPublicationRequestFile));
const encodeJson = Schema.encodeSync(Schema.UnknownFromJsonString);
class CloudPublishError extends Schema.TaggedErrorClass<CloudPublishError>()("CloudPublishError", {
  message: Schema.String,
}) {}

/**
 * Hands the agent's pull-request request to the cloud worker. The worker reads
 * the file once the turn settles and asks the relay to snapshot the workspace,
 * push the branch, and open a draft PR with the user's connected GitHub account.
 */
const writeRequest = Effect.fn("cloudPublish.writeRequest")(function* (
  target: string,
  request: typeof CloudPublicationRequestFile.Type,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const directory = path.dirname(target);
  yield* fs.makeDirectory(directory, { recursive: true });
  // Write beside the target and rename so the worker never reads a partial file.
  const nonce = yield* Random.nextIntBetween(0, Number.MAX_SAFE_INTEGER);
  const temporary = `${target}.${nonce.toString(36)}.tmp`;
  yield* fs
    .writeFileString(temporary, encodeRequest(request), { mode: 0o600, flag: "wx" })
    .pipe(
      Effect.andThen(fs.rename(temporary, target)),
      Effect.ensuring(fs.remove(temporary, { force: true }).pipe(Effect.ignore)),
    );
});

export const register = Effect.gen(function* () {
  const target = yield* Config.string("VITRE_CLOUD_PUBLICATION_REQUEST_PATH").pipe(
    Config.withDefault(""),
  );
  if (!target.trim()) return;
  const server = yield* McpServer.McpServer;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  yield* server.addTool({
    tool: new McpSchema.Tool({
      name: "cloud_create_pull_request",
      description:
        "Open a draft pull request for the work in this cloud workspace. Call it once the changes and validation are finished and the user asked for a PR. Supply a concise title and a Markdown description of the changes and how they were verified. Vitre saves the workspace for review when this turn ends, pushes the branch, and publishes the draft PR with the user's connected GitHub account; the PR link appears in Vitre, not in this conversation. Calling it again before the turn ends replaces the earlier request. Never push branches or create PRs with shell tools.",
      inputSchema: Schema.toJsonSchemaDocument(input).schema,
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
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
          const request = {
            kind: "pull_request" as const,
            title: params.title.trim(),
            body: params.body.trim(),
          };
          if (!request.title)
            return yield* new CloudPublishError({ message: "A pull request title is required" });
          yield* writeRequest(target, request).pipe(
            Effect.mapError(
              () =>
                new CloudPublishError({
                  message: "Could not record the pull request request for this workspace",
                }),
            ),
            Effect.provideService(FileSystem.FileSystem, fs),
            Effect.provideService(Path.Path, path),
          );
          const metadata = { requested: true, kind: request.kind, title: request.title };
          return new McpSchema.CallToolResult({
            isError: false,
            structuredContent: metadata,
            content: [
              {
                type: "text",
                text: `${encodeJson(metadata)}\nPull request requested. Finish this turn; Vitre will save the workspace, push the branch, and open the draft PR, then show its link to the user.`,
              },
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
                    text:
                      error instanceof Error ? error.message : "Cloud pull request request failed.",
                  },
                ],
              }),
            ),
          ),
        );
      }),
  });
});
export const CloudPublishRegistrationLive = Layer.effectDiscard(register);
