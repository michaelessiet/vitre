import { LensCommand, LensOverview, LensModelReply } from "@t3tools/contracts/lens";
import { CloudLens } from "./lens.ts";
import {
  CloudCommand,
  CloudConnection,
  CloudOverview,
  CloudProvider,
  CloudSavedResult,
  CloudWorkerCallback,
  CloudTaskFeed,
  CloudLoginStatus,
  CloudRepository,
  CloudWorkspaceManifest,
  CloudSnapshotRef,
  CloudWorkspaceChunkUpload,
  CloudProjectSnapshot,
  CloudMobileDeviceRegistration,
} from "@t3tools/contracts/cloud";
import {
  RelayClientAuth,
  RelayClientPrincipal,
  RelayAuthInvalidError,
} from "@t3tools/contracts/relay";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as HttpApi from "effect/unstable/httpapi/HttpApi";
import * as HttpApiBuilder from "effect/unstable/httpapi/HttpApiBuilder";
import * as HttpApiEndpoint from "effect/unstable/httpapi/HttpApiEndpoint";
import * as HttpApiGroup from "effect/unstable/httpapi/HttpApiGroup";
import { CloudConfiguration } from "./config.ts";
import { CloudService } from "./service.ts";
import { CloudWorkerControl } from "./workerControl.ts";
import { CloudAuxiliary } from "./auxiliary.ts";
import type { CloudError } from "./policy.ts";
import { decodeWorkspaceChunkUpload } from "./workspaceChunkTransport.ts";

const CloudErrorFields = {
  code: Schema.String,
  message: Schema.String,
  requestDisposition: Schema.optionalKey(Schema.Literals(["rejected", "unknown"])),
  retryable: Schema.optionalKey(Schema.Boolean),
};

export class CloudHttpError extends Schema.TaggedErrorClass<CloudHttpError>()(
  "CloudHttpError",
  CloudErrorFields,
  { httpApiStatus: 409 },
) {}
export class CloudBadRequest extends Schema.TaggedErrorClass<CloudBadRequest>()(
  "CloudBadRequest",
  CloudErrorFields,
  { httpApiStatus: 400 },
) {}
export class CloudUnauthorized extends Schema.TaggedErrorClass<CloudUnauthorized>()(
  "CloudUnauthorized",
  CloudErrorFields,
  { httpApiStatus: 401 },
) {}
export class CloudForbidden extends Schema.TaggedErrorClass<CloudForbidden>()(
  "CloudForbidden",
  CloudErrorFields,
  { httpApiStatus: 403 },
) {}
export class CloudNotFound extends Schema.TaggedErrorClass<CloudNotFound>()(
  "CloudNotFound",
  CloudErrorFields,
  { httpApiStatus: 404 },
) {}
export class CloudUnavailable extends Schema.TaggedErrorClass<CloudUnavailable>()(
  "CloudUnavailable",
  CloudErrorFields,
  { httpApiStatus: 503 },
) {}
export class CloudGatewayError extends Schema.TaggedErrorClass<CloudGatewayError>()(
  "CloudGatewayError",
  CloudErrorFields,
  { httpApiStatus: 502 },
) {}
const cloudErrors = [
  CloudHttpError,
  CloudBadRequest,
  CloudUnauthorized,
  CloudForbidden,
  CloudNotFound,
  CloudUnavailable,
  CloudGatewayError,
];
const cloudError = (error: CloudError) => {
  const fields = {
    code: error.code,
    message: error.message,
    requestDisposition: error.requestDisposition,
    retryable: error.retryable,
  };
  switch (error.status) {
    case 400:
      return new CloudBadRequest(fields);
    case 401:
      return new CloudUnauthorized(fields);
    case 403:
      return new CloudForbidden(fields);
    case 404:
      return new CloudNotFound(fields);
    case 503:
      return new CloudUnavailable(fields);
    case 502:
      return new CloudGatewayError(fields);
    default:
      return new CloudHttpError(fields);
  }
};
const Ok = Schema.Struct({ ok: Schema.Literal(true) });
const errors = [...cloudErrors, RelayAuthInvalidError];
const Id = Schema.String.check(Schema.isPattern(/^[a-zA-Z0-9_-]{1,128}$/));
const taskParams = Schema.Struct({ taskId: Id });
const workerHeaders = Schema.Struct({ authorization: Schema.String });
const Manifest = Schema.Struct({
  version: Schema.Literal(1),
  taskId: Id,
  attemptId: Id,
  checkpointId: Id,
  workspace: Schema.optionalKey(CloudSnapshotRef),
  chunks: Schema.Array(
    Schema.Struct({ index: Schema.Int, sha256: Schema.String, sizeBytes: Schema.Int }),
  ).check(Schema.isMaxLength(1280)),
  result: Schema.Struct({
    summary: Schema.String,
    diff: Schema.String,
    conversation: Schema.Unknown,
    testOutput: Schema.String,
    testExitCode: Schema.NullOr(Schema.Int),
  }),
});
const cloudGroup = HttpApiGroup.make("cloud")
  .add(
    HttpApiEndpoint.get("lensOverview", "/v1/cloud/lens", { success: LensOverview, error: errors }),
    HttpApiEndpoint.post("lensCommand", "/v1/cloud/lens/commands", {
      payload: LensCommand,
      success: LensOverview,
      error: errors,
    }),
    HttpApiEndpoint.post("mobileDevice", "/v1/cloud/mobile/devices", {
      payload: CloudMobileDeviceRegistration,
      success: Ok,
      error: errors,
    }),
    HttpApiEndpoint.get("projectSnapshots", "/v1/cloud/projects/:projectId/snapshots", {
      params: Schema.Struct({ projectId: Id }),
      success: Schema.Array(CloudProjectSnapshot),
      error: errors,
    }),
    HttpApiEndpoint.get("workspaceChunkStatus", "/v1/cloud/workspaces/chunks/:hash/status", {
      params: Schema.Struct({ hash: Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/)) }),
      success: Schema.Struct({ present: Schema.Boolean }),
      error: errors,
    }),
    HttpApiEndpoint.post("workspaceChunk", "/v1/cloud/workspaces/chunks", {
      payload: CloudWorkspaceChunkUpload,
      success: Schema.Struct({ sha256: Schema.String }),
      error: errors,
    }),
    HttpApiEndpoint.post("workspaceFinalize", "/v1/cloud/workspaces", {
      payload: CloudWorkspaceManifest,
      success: CloudSnapshotRef,
      error: errors,
    }),
    HttpApiEndpoint.get("artifact", "/v1/cloud/tasks/:taskId/artifacts", {
      params: taskParams,
      success: Schema.Unknown,
      error: errors,
    }),
    HttpApiEndpoint.get("artifactChunk", "/v1/cloud/tasks/:taskId/artifacts/:index", {
      params: Schema.Struct({
        taskId: Id,
        index: Schema.String.check(Schema.isPattern(/^[0-9]{1,4}$/)),
      }),
      success: Schema.Unknown,
      error: errors,
    }),
    HttpApiEndpoint.get("publicRepository", "/v1/cloud/repositories/public/:owner/:name", {
      params: Schema.Struct({
        owner: Schema.String.check(Schema.isPattern(/^[a-zA-Z0-9-]{1,100}$/)),
        name: Schema.String.check(Schema.isPattern(/^[a-zA-Z0-9_.-]{1,100}$/)),
      }),
      success: Schema.NullOr(CloudRepository),
      error: errors,
    }),
    HttpApiEndpoint.get("repositories", "/v1/cloud/repositories/available", {
      success: Schema.Array(CloudRepository),
      error: errors,
    }),
    HttpApiEndpoint.post("login", "/v1/cloud/provider-login", {
      payload: Schema.Struct({ idempotencyKey: Id }),
      success: Schema.Struct({ id: Id }),
      error: errors,
    }),
    HttpApiEndpoint.get("loginStatus", "/v1/cloud/provider-login/:taskId", {
      params: taskParams,
      success: CloudLoginStatus,
      error: errors,
    }),
    HttpApiEndpoint.get("overview", "/v1/cloud", { success: CloudOverview, error: errors }),
    HttpApiEndpoint.post("command", "/v1/cloud/commands", {
      payload: CloudCommand,
      success: Schema.Struct({ entityId: Schema.String, overview: CloudOverview }),
      error: errors,
    }),
    HttpApiEndpoint.post("credential", "/v1/cloud/provider-credentials", {
      payload: Schema.Struct({
        provider: CloudProvider,
        idempotencyKey: Id,
        credential: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(65536)),
        expectedVersion: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
      }),
      success: Ok,
      error: errors,
    }),
    HttpApiEndpoint.get("connection", "/v1/cloud/tasks/:taskId/connection", {
      params: taskParams,
      success: CloudConnection,
      error: errors,
    }),
    HttpApiEndpoint.get("result", "/v1/cloud/tasks/:taskId/result", {
      params: taskParams,
      success: CloudSavedResult,
      error: errors,
    }),
    HttpApiEndpoint.get("events", "/v1/cloud/tasks/:taskId/events", {
      params: taskParams,
      query: Schema.Struct({
        after: Schema.optionalKey(Schema.String.check(Schema.isPattern(/^[0-9]{1,15}$/))),
      }),
      success: CloudTaskFeed,
      error: errors,
    }),
  )
  .middleware(RelayClientAuth);
const callbackGroup = HttpApiGroup.make("cloudWorker").add(
  HttpApiEndpoint.get("legacyRepository", "/v1/cloud/worker/:taskId/legacy-repository", {
    params: taskParams,
    headers: workerHeaders,
    success: Schema.Unknown,
    error: cloudErrors,
  }),
  HttpApiEndpoint.post("workerWorkspaceChunk", "/v1/cloud/worker/:taskId/workspace-chunks", {
    params: taskParams,
    headers: workerHeaders,
    payload: CloudWorkspaceChunkUpload,
    success: Schema.Struct({ sha256: Schema.String }),
    error: cloudErrors,
  }),
  HttpApiEndpoint.post("workerWorkspaceSave", "/v1/cloud/worker/:taskId/workspace", {
    params: taskParams,
    headers: workerHeaders,
    payload: Schema.Struct({ manifest: CloudWorkspaceManifest, seed: Schema.Boolean }),
    success: CloudSnapshotRef,
    error: cloudErrors,
  }),
  HttpApiEndpoint.get("seed", "/v1/cloud/worker/:taskId/seed", {
    params: taskParams,
    headers: workerHeaders,
    success: Schema.Unknown,
    error: cloudErrors,
  }),
  HttpApiEndpoint.get("seedChunk", "/v1/cloud/worker/:taskId/seed/:index", {
    params: Schema.Struct({
      taskId: Id,
      index: Schema.String.check(Schema.isPattern(/^[0-9]{1,4}$/)),
    }),
    headers: workerHeaders,
    success: Schema.Unknown,
    error: cloudErrors,
  }),
  HttpApiEndpoint.post("mirror", "/v1/cloud/worker/mirror", {
    headers: workerHeaders,
    payload: Schema.Struct({ callback: CloudWorkerCallback, conversation: Schema.Unknown }),
    success: Ok,
    error: cloudErrors,
  }),
  HttpApiEndpoint.get("jobBootstrap", "/v1/cloud/jobs/:taskId/bootstrap", {
    params: taskParams,
    headers: workerHeaders,
    success: Schema.Unknown,
    error: cloudErrors,
  }),
  HttpApiEndpoint.get("jobChunk", "/v1/cloud/jobs/:taskId/chunks/:index", {
    params: Schema.Struct({
      taskId: Id,
      index: Schema.String.check(Schema.isPattern(/^[0-9]{1,4}$/)),
    }),
    headers: workerHeaders,
    success: Schema.Unknown,
    error: cloudErrors,
  }),
  HttpApiEndpoint.post("jobCallback", "/v1/cloud/jobs/:taskId/callback", {
    params: taskParams,
    headers: workerHeaders,
    payload: Schema.Struct({
      reply: Schema.optionalKey(LensModelReply),
      sequence: Schema.Int.check(Schema.isGreaterThan(0)),
      phase: Schema.Literals(["code", "completed", "failed"]),
      verificationUrl: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(2048))),
      userCode: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(32))),
      credential: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(65536))),
      commit: Schema.optionalKey(
        Schema.NullOr(Schema.String.check(Schema.isPattern(/^[a-f0-9]{40}$/))),
      ),
    }),
    success: Ok,
    error: cloudErrors,
  }),
  HttpApiEndpoint.post("callback", "/v1/cloud/worker/callback", {
    payload: CloudWorkerCallback,
    headers: Schema.Struct({ authorization: Schema.String }),
    success: Ok,
    error: cloudErrors,
  }),
  HttpApiEndpoint.get("workspace", "/v1/cloud/worker/:taskId/workspace/:hash", {
    params: Schema.Struct({
      taskId: Id,
      hash: Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/)),
    }),
    headers: workerHeaders,
    success: Schema.Unknown,
    error: cloudErrors,
  }),
  HttpApiEndpoint.get("bootstrap", "/v1/cloud/worker/:taskId/bootstrap", {
    params: taskParams,
    headers: workerHeaders,
    success: Schema.Unknown,
    error: cloudErrors,
  }),
  HttpApiEndpoint.get("restore", "/v1/cloud/worker/:taskId/checkpoint", {
    params: taskParams,
    headers: workerHeaders,
    success: Schema.Unknown,
    error: cloudErrors,
  }),
  HttpApiEndpoint.get("restoreChunk", "/v1/cloud/worker/:taskId/checkpoint/:index", {
    params: Schema.Struct({
      taskId: Id,
      index: Schema.String.check(Schema.isPattern(/^[0-9]{1,4}$/)),
    }),
    headers: workerHeaders,
    success: Schema.Unknown,
    error: cloudErrors,
  }),
  HttpApiEndpoint.post("workerCredential", "/v1/cloud/worker/:taskId/credential", {
    params: taskParams,
    headers: workerHeaders,
    payload: Schema.Struct({ attemptId: Id }),
    success: Schema.Unknown,
    error: cloudErrors,
  }),
  HttpApiEndpoint.post("workerLease", "/v1/cloud/worker/:taskId/lease", {
    params: taskParams,
    headers: workerHeaders,
    payload: Schema.Struct({
      attemptId: Id,
      action: Schema.Literals(["acquire", "release"]),
      turnRequestId: Schema.optionalKey(Id),
    }),
    success: Schema.Unknown,
    error: cloudErrors,
  }),
  HttpApiEndpoint.post("refreshCredential", "/v1/cloud/worker/:taskId/credential/refresh", {
    params: taskParams,
    headers: workerHeaders,
    payload: Schema.Struct({
      attemptId: Id,
      expectedVersion: Schema.Int,
      credential: Schema.String.check(Schema.isMaxLength(65536)),
    }),
    success: Schema.Unknown,
    error: cloudErrors,
  }),
  HttpApiEndpoint.post("upload", "/v1/cloud/worker/:taskId/chunks", {
    params: taskParams,
    headers: workerHeaders,
    payload: Schema.Struct({
      attemptId: Id,
      checkpointId: Id,
      index: Schema.Int,
      base64: Schema.String.check(Schema.isMaxLength(12 * 1024 * 1024)),
    }),
    success: Schema.Unknown,
    error: cloudErrors,
  }),
  HttpApiEndpoint.post("finalize", "/v1/cloud/worker/finalize", {
    headers: workerHeaders,
    payload: Schema.Struct({ callback: CloudWorkerCallback, manifest: Manifest }),
    success: Ok,
    error: cloudErrors,
  }),
);
export const CloudApi = HttpApi.make("VitreCloudApi").add(cloudGroup, callbackGroup);

export const cloudApiLayer = HttpApiBuilder.group(
  CloudApi,
  "cloud",
  Effect.fnUntraced(function* (handlers) {
    const service = yield* CloudService;
    const lens = yield* CloudLens;
    const control = yield* CloudWorkerControl;
    const auxiliary = yield* CloudAuxiliary;
    const config = yield* CloudConfiguration;
    const workspaceUser = Effect.gen(function* () {
      const { userId } = yield* RelayClientPrincipal;
      if (!config.enabled || userId !== config.allowedUserId)
        return yield* new CloudForbidden({
          code: "forbidden",
          message: "Cloud workspace access is unavailable",
        });
      return userId;
    });
    return handlers
      .handle("lensOverview", () =>
        Effect.gen(function* () {
          const { userId } = yield* RelayClientPrincipal;
          return yield* lens.overview(userId).pipe(Effect.mapError(cloudError));
        }),
      )
      .handle("lensCommand", ({ payload }) =>
        Effect.gen(function* () {
          const { userId } = yield* RelayClientPrincipal;
          return yield* lens.command(userId, payload).pipe(Effect.mapError(cloudError));
        }),
      )
      .handle("mobileDevice", ({ payload }) =>
        Effect.gen(function* () {
          const { userId } = yield* RelayClientPrincipal;
          yield* service.registerMobileDevice(userId, payload).pipe(Effect.mapError(cloudError));
          return { ok: true as const };
        }),
      )
      .handle("projectSnapshots", ({ params }) =>
        Effect.gen(function* () {
          const { userId } = yield* RelayClientPrincipal;
          return yield* service
            .projectSnapshots(userId, params.projectId)
            .pipe(Effect.mapError(cloudError));
        }),
      )
      .handle("workspaceChunkStatus", ({ params }) =>
        Effect.gen(function* () {
          const userId = yield* workspaceUser;
          return yield* control
            .workspaceChunkStatus(userId, params.hash)
            .pipe(Effect.mapError(cloudError));
        }),
      )
      .handle("workspaceChunk", ({ payload }) =>
        Effect.gen(function* () {
          const userId = yield* workspaceUser;
          const bytes = yield* Effect.tryPromise({
            try: () => decodeWorkspaceChunkUpload(payload),
            catch: () =>
              new CloudBadRequest({ code: "invalid_chunk", message: "Invalid workspace chunk" }),
          });
          return yield* control.uploadWorkspace(userId, bytes).pipe(Effect.mapError(cloudError));
        }),
      )
      .handle("workspaceFinalize", ({ payload }) =>
        Effect.gen(function* () {
          const userId = yield* workspaceUser;
          return yield* control
            .finalizeWorkspace(userId, payload)
            .pipe(Effect.mapError(cloudError));
        }),
      )
      .handle("artifact", ({ params }) =>
        Effect.gen(function* () {
          const { userId } = yield* RelayClientPrincipal;
          return yield* control.artifact(userId, params.taskId).pipe(Effect.mapError(cloudError));
        }),
      )
      .handle("artifactChunk", ({ params }) =>
        Effect.gen(function* () {
          const { userId } = yield* RelayClientPrincipal;
          return yield* control
            .artifact(userId, params.taskId, Number(params.index))
            .pipe(Effect.mapError(cloudError));
        }),
      )
      .handle("publicRepository", ({ params }) =>
        Effect.gen(function* () {
          const { userId } = yield* RelayClientPrincipal;
          return yield* auxiliary
            .publicRepository(userId, params.owner, params.name)
            .pipe(Effect.mapError(cloudError));
        }),
      )
      .handle("repositories", () =>
        Effect.gen(function* () {
          const { userId } = yield* RelayClientPrincipal;
          return yield* auxiliary.repositories(userId).pipe(Effect.mapError(cloudError));
        }),
      )
      .handle("login", ({ payload }) =>
        Effect.gen(function* () {
          const { userId } = yield* RelayClientPrincipal;
          return yield* auxiliary
            .login(userId, payload.idempotencyKey)
            .pipe(Effect.mapError(cloudError));
        }),
      )
      .handle("loginStatus", ({ params }) =>
        Effect.gen(function* () {
          const { userId } = yield* RelayClientPrincipal;
          return yield* auxiliary.status(userId, params.taskId).pipe(Effect.mapError(cloudError));
        }),
      )
      .handle("overview", () =>
        Effect.gen(function* () {
          const { userId } = yield* RelayClientPrincipal;
          return yield* service.overview(userId).pipe(Effect.mapError(cloudError));
        }),
      )
      .handle("command", ({ payload }) =>
        Effect.gen(function* () {
          const { userId } = yield* RelayClientPrincipal;
          return yield* service.command(userId, payload).pipe(Effect.mapError(cloudError));
        }),
      )
      .handle("credential", ({ payload }) =>
        Effect.gen(function* () {
          const { userId } = yield* RelayClientPrincipal;
          yield* service
            .saveCredential(
              userId,
              payload.provider,
              payload.credential,
              payload.expectedVersion,
              payload.idempotencyKey,
            )
            .pipe(Effect.mapError(cloudError));
          return { ok: true as const };
        }),
      )
      .handle("connection", ({ params }) =>
        Effect.gen(function* () {
          const { userId } = yield* RelayClientPrincipal;
          return yield* control.connection(userId, params.taskId).pipe(Effect.mapError(cloudError));
        }),
      )
      .handle("result", ({ params }) =>
        Effect.gen(function* () {
          const { userId } = yield* RelayClientPrincipal;
          return yield* control.result(userId, params.taskId).pipe(Effect.mapError(cloudError));
        }),
      )
      .handle("events", ({ params, query }) =>
        Effect.gen(function* () {
          const { userId } = yield* RelayClientPrincipal;
          return yield* control
            .events(userId, params.taskId, Number(query.after ?? 0))
            .pipe(Effect.mapError(cloudError));
        }),
      );
  }),
);
export const cloudWorkerApiLayer = HttpApiBuilder.group(
  CloudApi,
  "cloudWorker",
  Effect.fnUntraced(function* (handlers) {
    const service = yield* CloudService;
    const control = yield* CloudWorkerControl;
    const auxiliary = yield* CloudAuxiliary;
    const token = (headers: { authorization: string }) =>
      headers.authorization.startsWith("Bearer ") ? headers.authorization.slice(7) : "";
    return handlers
      .handle("legacyRepository", ({ params, headers }) =>
        control.legacyRepository(params.taskId, token(headers)).pipe(Effect.mapError(cloudError)),
      )
      .handle("workerWorkspaceChunk", ({ params, headers, payload }) =>
        Effect.gen(function* () {
          const bytes = yield* Effect.tryPromise({
            try: () => decodeWorkspaceChunkUpload(payload),
            catch: () =>
              new CloudBadRequest({ code: "invalid_chunk", message: "Invalid workspace chunk" }),
          });
          return yield* control
            .uploadWorkerWorkspace(params.taskId, token(headers), bytes)
            .pipe(Effect.mapError(cloudError));
        }),
      )
      .handle("workerWorkspaceSave", ({ params, headers, payload }) =>
        control
          .saveWorkerWorkspace(params.taskId, token(headers), payload.manifest, payload.seed)
          .pipe(Effect.mapError(cloudError)),
      )
      .handle("seed", ({ params, headers }) =>
        control
          .restore(params.taskId, token(headers), undefined, true)
          .pipe(Effect.mapError(cloudError)),
      )
      .handle("seedChunk", ({ params, headers }) =>
        control
          .restore(params.taskId, token(headers), Number(params.index), true)
          .pipe(Effect.mapError(cloudError)),
      )
      .handle("mirror", ({ headers, payload }) =>
        control
          .mirror(token(headers), payload.callback, payload.conversation)
          .pipe(Effect.as({ ok: true as const }), Effect.mapError(cloudError)),
      )
      .handle("jobBootstrap", ({ headers, params }) =>
        auxiliary.bootstrap(params.taskId, token(headers)).pipe(Effect.mapError(cloudError)),
      )
      .handle("jobChunk", ({ headers, params }) =>
        auxiliary
          .chunk(params.taskId, token(headers), Number(params.index))
          .pipe(Effect.mapError(cloudError)),
      )
      .handle("jobCallback", ({ headers, params, payload }) =>
        auxiliary
          .callback(params.taskId, token(headers), payload)
          .pipe(Effect.as({ ok: true as const }), Effect.mapError(cloudError)),
      )
      .handle("callback", ({ headers, payload }) =>
        service
          .callback(
            headers.authorization.startsWith("Bearer ") ? headers.authorization.slice(7) : "",
            payload,
          )
          .pipe(Effect.as({ ok: true as const }), Effect.mapError(cloudError)),
      )
      .handle("workspace", ({ params, headers }) =>
        control
          .workspace(params.taskId, token(headers), params.hash)
          .pipe(Effect.mapError(cloudError)),
      )
      .handle("bootstrap", ({ headers, params }) =>
        control.bootstrap(params.taskId, token(headers)).pipe(Effect.mapError(cloudError)),
      )
      .handle("restore", ({ headers, params }) =>
        control.restore(params.taskId, token(headers)).pipe(Effect.mapError(cloudError)),
      )
      .handle("restoreChunk", ({ headers, params }) =>
        control
          .restore(params.taskId, token(headers), Number(params.index))
          .pipe(Effect.mapError(cloudError)),
      )
      .handle("workerCredential", ({ headers, params, payload }) =>
        control
          .credential(params.taskId, token(headers), payload.attemptId)
          .pipe(Effect.mapError(cloudError)),
      )
      .handle("workerLease", ({ headers, params, payload }) =>
        control
          .lease(
            params.taskId,
            token(headers),
            payload.attemptId,
            payload.action,
            payload.turnRequestId,
          )
          .pipe(Effect.mapError(cloudError)),
      )
      .handle("refreshCredential", ({ headers, params, payload }) =>
        control
          .refreshCredential(
            params.taskId,
            token(headers),
            payload.attemptId,
            payload.expectedVersion,
            payload.credential,
          )
          .pipe(Effect.mapError(cloudError)),
      )
      .handle("upload", ({ headers, params, payload }) =>
        Effect.gen(function* () {
          const bytes = yield* Effect.try({
            try: () => Uint8Array.from(atob(payload.base64), (c) => c.charCodeAt(0)),
            catch: () =>
              new CloudBadRequest({ code: "invalid_chunk", message: "Invalid chunk encoding" }),
          });
          return yield* control
            .upload(
              params.taskId,
              token(headers),
              payload.attemptId,
              payload.checkpointId,
              payload.index,
              bytes,
            )
            .pipe(Effect.mapError(cloudError));
        }),
      )
      .handle("finalize", ({ headers, payload }) =>
        control
          .finalize(token(headers), payload.callback, {
            ...payload.manifest,
            chunks: [...payload.manifest.chunks],
          })
          .pipe(Effect.as({ ok: true as const }), Effect.mapError(cloudError)),
      );
  }),
);
