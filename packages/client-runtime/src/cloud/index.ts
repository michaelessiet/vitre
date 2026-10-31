import { LensCommand, LensOverview } from "@t3tools/contracts/lens";
import * as Schema from "effect/Schema";
export { cloudConversationLayer } from "./connection.ts";
import {
  CloudCommand,
  CloudConnection,
  CloudOverview,
  CloudSavedResult,
  CloudLoginStatus,
  CloudTaskFeed,
  CloudRepository,
  CloudProjectSnapshot,
  type CloudMobileDeviceRegistration,
  type CloudProvider,
} from "@t3tools/contracts/cloud";

export class CloudClientError extends Error {
  readonly status: number;
  readonly code: string;
  readonly requestDisposition: "rejected" | "unknown";
  readonly retryable: boolean;
  constructor(
    status: number,
    code: string,
    message: string,
    requestDisposition: "rejected" | "unknown" = "unknown",
    retryable = false,
  ) {
    super(message);
    this.name = "CloudClientError";
    this.status = status;
    this.code = code;
    this.requestDisposition = requestDisposition;
    this.retryable = retryable;
  }
}

export interface CloudClientOptions {
  readonly baseUrl: string;
  /** Resolve/refresh the personal deployment's Clerk bearer token on each request. */
  readonly accessToken: () => Promise<string>;
  readonly fetch?: typeof globalThis.fetch;
}

const CommandResult = Schema.Struct({ entityId: Schema.String, overview: CloudOverview });
const CredentialResult = Schema.Struct({ ok: Schema.Literal(true) });
const ErrorBody = Schema.Struct({
  code: Schema.String,
  message: Schema.String,
  requestDisposition: Schema.optional(Schema.Literals(["rejected", "unknown"])),
  retryable: Schema.optional(Schema.Boolean),
});
const RelayAuthErrorBody = Schema.TaggedStruct("RelayAuthInvalidError", {
  code: Schema.Literal("auth_invalid"),
  reason: Schema.Literals(["missing_bearer", "invalid_bearer", "invalid_dpop", "not_authorized"]),
});

const encodeJson = Schema.encodeSync(Schema.UnknownFromJsonString);
const decodeError = Schema.decodeUnknownOption(ErrorBody);
const decodeRelayAuthError = Schema.decodeUnknownOption(RelayAuthErrorBody);
const decodeLensOverview = Schema.decodeUnknownSync(LensOverview);
const decodeLensCommand = Schema.decodeUnknownSync(LensCommand);
const decodeOverview = Schema.decodeUnknownSync(CloudOverview);
const decodeCommandResult = Schema.decodeUnknownSync(CommandResult);
const decodeCommand = Schema.decodeUnknownSync(CloudCommand);
const decodeConnection = Schema.decodeUnknownSync(CloudConnection);
const decodeResult = Schema.decodeUnknownSync(CloudSavedResult);
const decodeCredentialResult = Schema.decodeUnknownSync(CredentialResult);
const decodeLogin = Schema.decodeUnknownSync(CloudLoginStatus);
const decodeFeed = Schema.decodeUnknownSync(CloudTaskFeed);
const decodeLoginStart = Schema.decodeUnknownSync(Schema.Struct({ id: Schema.String }));
const decodeRepositories = Schema.decodeUnknownSync(Schema.Array(CloudRepository));
const decodeRepository = Schema.decodeUnknownSync(CloudRepository);

/** No UI, browser storage, filesystem access, or provider credentials cached here. */
const decodeProjectSnapshots = Schema.decodeUnknownSync(Schema.Array(CloudProjectSnapshot));
const decodeUploadedChunk = Schema.decodeUnknownSync(Schema.Struct({ sha256: Schema.String }));

export function makeCloudClient(options: CloudClientOptions) {
  const origin = new URL(options.baseUrl);
  if (
    origin.protocol !== "https:" ||
    origin.username ||
    origin.password ||
    origin.search ||
    origin.hash ||
    origin.pathname !== "/"
  ) {
    throw new CloudClientError(0, "invalid_origin", "Cloud deployment must be an HTTPS origin");
  }
  const fetcher = options.fetch ?? globalThis.fetch;
  const request = async (path: string, body?: unknown, signal?: AbortSignal): Promise<unknown> => {
    const token = await options.accessToken();
    if (!token) throw new CloudClientError(401, "needs_auth", "Sign into your cloud deployment");
    const controller = new AbortController();
    const abort = () => controller.abort();
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) abort();
    // React Native does not provide AbortSignal.timeout or AbortSignal.any.
    // @effect-diagnostics-next-line globalTimers:off
    const timer = setTimeout(abort, 30_000);
    try {
      const response = await fetcher(`${origin.origin}/v1/cloud${path}`, {
        method: body === undefined ? "GET" : "POST",
        redirect: "error",
        cache: "no-store",
        signal: controller.signal,
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        ...(body === undefined ? {} : { body: encodeJson(body) }),
      });
      const data: unknown = await response.json();
      if (!response.ok) {
        const error = decodeError(data);
        const relayAuth = decodeRelayAuthError(data);
        if (relayAuth._tag === "Some") {
          throw new CloudClientError(
            response.status,
            relayAuth.value.code,
            relayAuth.value.reason === "not_authorized"
              ? "This account is not authorized for this cloud deployment."
              : "Cloud sign-in was rejected. Sign out and sign in again. If it persists, check this build's Clerk JWT template.",
            "rejected",
          );
        }
        throw new CloudClientError(
          response.status,
          error._tag === "Some" ? error.value.code : "cloud_unavailable",
          error._tag === "Some" ? error.value.message : "Cloud request failed",
          error._tag === "Some" ? error.value.requestDisposition : undefined,
          error._tag === "Some" ? error.value.retryable : undefined,
        );
      }
      return data;
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
    }
  };
  const taskPath = (id: string) => {
    if (!/^[a-zA-Z0-9_-]{1,128}$/.test(id))
      throw new CloudClientError(0, "invalid_task", "Invalid cloud task ID");
    return `/tasks/${id}`;
  };
  return {
    lens: async () => decodeLensOverview(await request("/lens")),
    lensCommand: async (command: LensCommand) =>
      decodeLensOverview(await request("/lens/commands", decodeLensCommand(command))),
    registerMobileDevice: async (registration: CloudMobileDeviceRegistration) =>
      decodeCredentialResult(await request("/mobile/devices", registration)),
    projectSnapshots: async (projectId: string) => {
      taskPath(projectId);
      return decodeProjectSnapshots(await request(`/projects/${projectId}/snapshots`));
    },
    uploadChunk: async (base64: string) =>
      decodeUploadedChunk(await request("/workspaces/chunks", { base64 })),
    repositories: async () => decodeRepositories(await request("/repositories/available")),
    publicRepository: async (owner: string, name: string) => {
      if (!/^[a-zA-Z0-9-]{1,100}$/.test(owner) || !/^[a-zA-Z0-9_.-]{1,100}$/.test(name))
        throw new CloudClientError(0, "invalid_repository", "Invalid GitHub repository");
      const value = await request(`/repositories/public/${owner}/${name}`);
      return value === null ? null : decodeRepository(value);
    },
    startCodexLogin: async (idempotencyKey: string) =>
      decodeLoginStart(await request("/provider-login", { idempotencyKey })),
    loginStatus: async (id: string) => {
      taskPath(id);
      return decodeLogin(await request(`/provider-login/${id}`));
    },
    events: async (taskId: string, after = 0) =>
      decodeFeed(
        await request(`${taskPath(taskId)}/events?after=${Math.max(0, Math.floor(after))}`),
      ),
    overview: async (signal?: AbortSignal) => decodeOverview(await request("", undefined, signal)),
    command: async (command: CloudCommand, signal?: AbortSignal) =>
      decodeCommandResult(await request("/commands", decodeCommand(command), signal)),
    connection: async (taskId: string, signal?: AbortSignal) => {
      const connection = decodeConnection(
        await request(`${taskPath(taskId)}/connection`, undefined, signal),
      );
      const url = new URL(connection.httpBaseUrl);
      if (
        url.protocol !== "https:" ||
        url.username ||
        url.password ||
        url.search ||
        url.hash ||
        url.pathname !== "/"
      ) {
        throw new CloudClientError(
          0,
          "invalid_environment",
          "Cloud environment must use an HTTPS origin",
        );
      }
      return connection;
    },
    result: async (taskId: string, signal?: AbortSignal) =>
      decodeResult(await request(`${taskPath(taskId)}/result`, undefined, signal)),
    artifact: async (taskId: string, index?: number, signal?: AbortSignal) => {
      if (index !== undefined && (!Number.isSafeInteger(index) || index < 0 || index >= 1280))
        throw new CloudClientError(400, "invalid_chunk", "Invalid artifact chunk index");
      return request(
        `${taskPath(taskId)}/artifacts${index === undefined ? "" : `/${index}`}`,
        undefined,
        signal,
      );
    },
    saveCredential: async (
      input: {
        provider: CloudProvider;
        credential: string;
        expectedVersion: number;
        idempotencyKey: string;
      },
      signal?: AbortSignal,
    ) => decodeCredentialResult(await request("/provider-credentials", input, signal)),
  };
}

/** Only repository URLs are accepted; branch selection is an independent field. */
export function parseGithubRepository(input: string): { owner: string; name: string } {
  const text = input.trim();
  const match =
    /^(?:https:\/\/github\.com\/)?([a-zA-Z0-9](?:[a-zA-Z0-9-]{0,99}))\/([a-zA-Z0-9_.-]{1,100})\/?$/.exec(
      text,
    );
  const owner = match?.[1];
  const name = match?.[2]?.replace(/\.git$/, "");
  if (!owner || !name || name === "." || name === "..")
    throw new CloudClientError(
      0,
      "invalid_repository",
      "Enter a GitHub repository URL or owner/repo. Select its branch separately.",
      "rejected",
    );
  return { owner, name };
}
export type CloudClient = ReturnType<typeof makeCloudClient>;
