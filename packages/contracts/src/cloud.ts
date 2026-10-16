import * as Schema from "effect/Schema";
import { ProviderOptionSelections } from "./model.ts";
import {
  ProviderInteractionMode,
  RuntimeMode,
  UploadChatAttachment,
  ThreadExecutionState,
} from "./orchestration.ts";
import { ThreadId } from "./baseSchemas.ts";

/** Cloud control-plane wire types. Execution continues to use the environment RPC API. */
const Id = Schema.String.check(Schema.isPattern(/^[a-zA-Z0-9_-]{1,128}$/));
const Text = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(65536));
const Revision = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0));
const Timestamp = Schema.String;
const Sha = Schema.String.check(Schema.isPattern(/^[a-f0-9]{40}$/));
const Digest = Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/));

/** Portable execution metadata; omitted on legacy GitHub-only tasks. */
export const CloudExecutionTarget = Schema.Literals(["local", "cloud-github", "cloud-local"]);
export type CloudExecutionTarget = typeof CloudExecutionTarget.Type;
export const CloudSnapshotRef = Schema.Struct({ id: Id, sha256: Digest });
/** Encoding affects transport only; chunk digests always identify decoded bytes. */
export const CloudWorkspaceChunkUpload = Schema.Struct({
  base64: Schema.String.check(Schema.isMaxLength(6 * 1024 * 1024)),
  encoding: Schema.optionalKey(Schema.Literal("gzip")),
});
export type CloudWorkspaceChunkUpload = typeof CloudWorkspaceChunkUpload.Type;
export const CloudWorkspaceSource = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("github"), revision: Sha, snapshot: CloudSnapshotRef }),
  Schema.Struct({ kind: Schema.Literal("local"), snapshot: CloudSnapshotRef, name: Text }),
]);
export type CloudWorkspaceSource = typeof CloudWorkspaceSource.Type;
export const CloudWorkspaceEntry = Schema.Struct({
  rootId: Id,
  path: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(4096)),
  kind: Schema.Literals(["file", "symlink"]),
  executable: Schema.Boolean,
  sizeBytes: Revision,
  sha256: Digest,
  chunks: Schema.Array(Digest),
  chunkOffset: Schema.optionalKey(Revision),
  target: Schema.NullOr(Schema.String),
});
export type CloudWorkspaceEntry = typeof CloudWorkspaceEntry.Type;
export const CloudWorkspaceBlob = Schema.Struct({
  sha256: Digest,
  sizeBytes: Revision,
  chunks: Schema.Array(Digest),
});
export const CloudPreparedConversation = Schema.Struct({
  operationId: Id,
  conversationId: Id,
  generation: Revision,
  history: CloudWorkspaceBlob,
});
export const CloudWorkspaceGit = Schema.Struct({
  commitIdentity: Schema.optionalKey(
    Schema.Struct({
      name: Schema.String.check(Schema.isPattern(/^[^\p{Cc}]{1,256}$/u)),
      email: Schema.String.check(Schema.isPattern(/^[^\p{Cc}]{1,256}$/u)),
    }),
  ),
  githubRemote: Schema.optionalKey(
    Schema.String.check(Schema.isPattern(/^https:\/\/github\.com\/[\w.-]+\/[\w.-]+\.git$/)),
  ),
  publishedRevision: Schema.optionalKey(Sha),
  head: Sha,
  branch: Schema.NullOr(Text),
  bundle: CloudWorkspaceBlob,
  index: CloudWorkspaceBlob,
});
export const CloudWorkspaceManifest = Schema.Struct({
  version: Schema.Literals([1, 2]),
  roots: Schema.Array(
    Schema.Struct({ id: Id, name: Text, git: Schema.optionalKey(CloudWorkspaceGit) }),
  ),
  entries: Schema.Array(CloudWorkspaceEntry),
});
export type CloudWorkspaceManifest = typeof CloudWorkspaceManifest.Type;
export const CloudConversationSnapshot = Schema.Struct({
  projectId: Schema.optionalKey(Id),
  version: Schema.Literal(1),
  workspace: CloudWorkspaceManifest,
  history: CloudWorkspaceBlob,
  roots: Schema.Array(Schema.Struct({ id: Id, path: Text })),
});
export type CloudConversationSnapshot = typeof CloudConversationSnapshot.Type;
export const CloudTerminalState = Schema.Struct({
  managedCommand: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(65_536))),
  terminalId: Id,
  rootId: Id,
  relativeCwd: Schema.String.check(Schema.isMaxLength(4096)),
  history: Schema.String.check(Schema.isMaxLength(4 * 1024 * 1024)),
});
export type CloudTerminalState = typeof CloudTerminalState.Type;
export const CloudTransferRequest = Schema.Union([
  Schema.Struct({ type: Schema.Literal("validateProvider"), threadId: ThreadId }),
  Schema.Struct({ type: Schema.Literal("ownership"), threadId: ThreadId }),
  Schema.Struct({
    type: Schema.Literal("restoreTerminals"),
    resumeCommands: Schema.optionalKey(Schema.Boolean),
    threadId: ThreadId,
    operationId: Id,
    generation: Revision,
    terminals: Schema.Array(CloudTerminalState).check(Schema.isMaxLength(32)),
  }),
  Schema.Struct({
    type: Schema.Literal("closeTerminals"),
    threadId: ThreadId,
    operationId: Id,
    generation: Revision,
  }),
  Schema.Struct({
    type: Schema.Literal("capture"),
    threadId: ThreadId,
    operationId: Id,
    generation: Revision,
  }),
  Schema.Struct({ type: Schema.Literal("read"), sha256: Digest }),
  Schema.Struct({
    type: Schema.Literal("write"),
    base64: Schema.String.check(Schema.isMaxLength(6 * 1024 * 1024)),
  }),
]);
export type CloudTransferRequest = typeof CloudTransferRequest.Type;
export const CloudTransferResult = Schema.Union([
  Schema.Struct({
    type: Schema.Literal("providerValidation"),
    supported: Schema.Boolean,
    reason: Schema.NullOr(Schema.String),
    // The provider could not be probed yet; a retry may succeed.
    retryable: Schema.optionalKey(Schema.Boolean),
  }),
  Schema.Struct({ type: Schema.Literal("terminalsRestored") }),
  Schema.Struct({ type: Schema.Literal("ownership"), execution: ThreadExecutionState }),
  Schema.Struct({ type: Schema.Literal("snapshot"), snapshot: CloudConversationSnapshot }),
  Schema.Struct({ type: Schema.Literal("chunk"), base64: Schema.String, sha256: Digest }),
  Schema.Struct({ type: Schema.Literal("stored"), sha256: Digest }),
]);
export type CloudTransferResult = typeof CloudTransferResult.Type;
export const CloudHandoffPhase = Schema.Literals([
  "waiting",
  "preparing",
  "checkpointing",
  "transferring",
  "verifying",
  "activating",
  "releasing",
  "completed",
  "cancelled",
  "failed",
]);
export type CloudHandoffPhase = typeof CloudHandoffPhase.Type;
export const CloudRootBinding = Schema.Struct({
  id: Id,
  localPath: Schema.NullOr(Text),
  cloudPath: Schema.NullOr(Text),
});
export const CloudConversationBinding = Schema.Struct({
  roots: Schema.optionalKey(Schema.Array(CloudRootBinding)),
  aliases: Schema.optionalKey(Schema.Array(Id)),
  conversationId: Id,
  localThreadId: Id,
  cloudTaskId: Schema.NullOr(Id),
  target: CloudExecutionTarget,
  generation: Revision,
  leaseOwner: Schema.NullOr(Id),
  leaseExpiresAt: Schema.NullOr(Timestamp),
});
export type CloudConversationBinding = typeof CloudConversationBinding.Type;
export const CloudHandoffWaitReason = Schema.Literals([
  "active-turn",
  "cloud-preparation",
  "cloud-activation",
  "ownership-confirmation",
  "conflict",
]);
export const CloudHandoffErrorDisposition = Schema.Literals(["retryable", "terminal", "unknown"]);
export const CloudHandoffOperation = Schema.Struct({
  cancelRequested: Schema.optionalKey(Schema.Boolean),
  revision: Schema.optionalKey(Revision),
  startedAt: Schema.optionalKey(Timestamp),
  updatedAt: Schema.optionalKey(Timestamp),
  waitReason: Schema.optionalKey(CloudHandoffWaitReason),
  errorDisposition: Schema.optionalKey(CloudHandoffErrorDisposition),
  id: Id,
  conversationId: Id,
  from: CloudExecutionTarget,
  to: CloudExecutionTarget,
  generation: Revision,
  phase: CloudHandoffPhase,
  checkpoint: Schema.NullOr(CloudSnapshotRef),
  error: Schema.NullOr(Schema.String),
});
export type CloudHandoffOperation = typeof CloudHandoffOperation.Type;
export const CloudSwitchInput = Schema.Struct({
  idempotencyKey: Id,
  conversationId: Id,
  localThreadId: ThreadId,
  cloudTaskId: Schema.NullOr(Id),
  target: CloudExecutionTarget,
});
export type CloudSwitchInput = typeof CloudSwitchInput.Type;
export const CloudSwitchStatusInput = Schema.Struct({ conversationId: Id });
export const CloudSwitchCancelInput = Schema.Struct({ operationId: Id });
export const CloudSwitchResolveInput = Schema.Struct({
  operationId: Id,
  choice: Schema.Literals(["local", "cloud", "edited"]),
});
export const CloudSwitchStatus = Schema.Struct({
  accountRevision: Schema.optionalKey(Revision),
  conflictRoots: Schema.optionalKey(Schema.Array(Schema.Struct({ id: Id, path: Text }))),
  operation: Schema.NullOr(CloudHandoffOperation),
  binding: Schema.NullOr(CloudConversationBinding),
  conflicts: Schema.Array(Schema.String),
});
export type CloudSwitchStatus = typeof CloudSwitchStatus.Type;

export const CloudProvider = Schema.Literals(["codex", "claude"]);
export type CloudProvider = typeof CloudProvider.Type;
export const CloudTaskState = Schema.Literals([
  "queued",
  "preparing",
  "running",
  "waiting_for_input",
  "needs_auth",
  "usage_limited",
  "completed",
  "failed",
  "cancelled",
  "interrupted",
]);
export type CloudTaskState = typeof CloudTaskState.Type;
export const CloudWorkerState = Schema.Literals([
  "provisioning",
  "starting",
  "ready",
  "paused",
  "stopped",
  "deleting",
  "deleted",
  "error",
]);
export type CloudWorkerState = typeof CloudWorkerState.Type;
export const CloudRepository = Schema.Struct({
  id: Id,
  installationId: Id,
  owner: Id,
  name: Schema.String.check(Schema.isPattern(/^[a-zA-Z0-9_.-]{1,100}$/)),
  defaultBranch: Text,
  setupCommand: Schema.String.check(Schema.isMaxLength(16384)),
  testCommand: Schema.String.check(Schema.isMaxLength(16384)),
  revision: Revision,
});
export type CloudRepository = typeof CloudRepository.Type;
export const CloudTaskAttempt = Schema.Struct({
  id: Id,
  generation: Revision,
  startedAt: Timestamp,
  deadlineAt: Timestamp,
  heartbeatAt: Timestamp,
  lastSequence: Revision,
  reservedMicroDollars: Revision,
  billedThrough: Timestamp,
});
export type CloudTaskAttempt = typeof CloudTaskAttempt.Type;
export const CloudWorker = Schema.Struct({
  id: Id,
  sandboxId: Schema.NullOr(Id),
  environmentId: Id,
  state: CloudWorkerState,
  cpu: Schema.Number,
  memoryGiB: Schema.Number,
  diskGiB: Schema.Number,
  stoppedAt: Schema.NullOr(Timestamp),
});
export type CloudWorker = typeof CloudWorker.Type;
export const CloudCheckpoint = Schema.Struct({
  id: Id,
  taskId: Id,
  attemptId: Id,
  sequence: Revision,
  objectKey: Text,
  sha256: Digest,
  sizeBytes: Revision,
  createdAt: Timestamp,
});
export type CloudCheckpoint = typeof CloudCheckpoint.Type;
export const CloudResultRevision = Schema.Struct({
  id: Id,
  taskId: Id,
  checkpointId: Id,
  sha256: Digest,
  summary: Schema.String,
  createdAt: Timestamp,
});
export type CloudResultRevision = typeof CloudResultRevision.Type;
export const CloudPublication = Schema.Struct({
  id: Id,
  taskId: Id,
  resultId: Id,
  resultSha256: Digest,
  kind: Schema.Literals(["pull_request", "issue_comment"]),
  title: Text,
  body: Text,
  state: Schema.Literals(["queued", "publishing", "published", "failed"]),
  url: Schema.NullOr(Text),
});
export type CloudPublication = typeof CloudPublication.Type;
export const CloudAttachment = Schema.Struct({
  type: Schema.Literals(["image", "file"]),
  name: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(255)),
  mimeType: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(100)),
  sizeBytes: Schema.Int.check(
    Schema.isGreaterThanOrEqualTo(0),
    Schema.isLessThanOrEqualTo(10 * 1024 * 1024),
  ),
  sha256: Digest,
  chunks: Schema.Array(Digest).check(Schema.isMaxLength(3)),
});
export type CloudAttachment = typeof CloudAttachment.Type;
const CloudAttachments = Schema.Array(CloudAttachment).check(Schema.isMaxLength(8));
const CloudUploadAttachments = Schema.Array(UploadChatAttachment).check(Schema.isMaxLength(8));

/** Attempt-scoped progress, ordered by the callback sequence that persisted it. */
export const CloudPreparation = Schema.Struct({
  attemptId: Id,
  sequence: Revision,
  phase: Schema.Literals([
    "restoring",
    "cloning",
    "dependencies",
    "backend",
    "provider",
    "ready",
    "failed",
  ]),
  startedAt: Timestamp,
  updatedAt: Timestamp,
});
export type CloudPreparation = typeof CloudPreparation.Type;
export const CloudDependencySetup = Schema.Struct({
  attemptId: Id,
  sequence: Revision,
  outcome: Schema.Literals(["running", "succeeded", "reused", "unnecessary", "failed"]),
  updatedAt: Timestamp,
  detail: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(65536))),
});
export type CloudDependencySetup = typeof CloudDependencySetup.Type;
export const CloudTask = Schema.Struct({
  preparation: Schema.optionalKey(CloudPreparation),
  dependencySetup: Schema.optionalKey(CloudDependencySetup),
  runtimeMode: Schema.optionalKey(RuntimeMode),
  title: Schema.optionalKey(Text),
  archivedAt: Schema.optionalKey(Schema.NullOr(Timestamp)),
  projectId: Schema.optionalKey(Id),
  id: Id,
  handoff: Schema.optionalKey(CloudPreparedConversation),
  wakeOnly: Schema.optionalKey(Schema.Boolean),
  idle: Schema.optionalKey(Schema.Boolean),
  turnRequestId: Schema.optionalKey(Id),
  keepAliveSeconds: Schema.optionalKey(
    Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 900 })),
  ),
  attachments: Schema.optionalKey(CloudAttachments),
  source: Schema.optionalKey(CloudWorkspaceSource),
  model: Schema.optionalKey(Text),
  modelOptions: Schema.optionalKey(ProviderOptionSelections),
  interactionMode: Schema.optionalKey(ProviderInteractionMode),
  repository: CloudRepository,
  baseBranch: Text,
  baseSha: Schema.NullOr(Sha),
  provider: CloudProvider,
  kind: Schema.Literals(["build", "ask", "investigate"]),
  prompt: Text,
  issueNumber: Schema.NullOr(Schema.Int.check(Schema.isGreaterThan(0))),
  state: CloudTaskState,
  branch: Text,
  createdAt: Timestamp,
  updatedAt: Timestamp,
  attempt: Schema.NullOr(CloudTaskAttempt),
  worker: Schema.NullOr(CloudWorker),
  checkpoint: Schema.NullOr(CloudCheckpoint),
  result: Schema.NullOr(CloudResultRevision),
  error: Schema.NullOr(Schema.String),
});
export type CloudTask = typeof CloudTask.Type;
export const CloudProviderAccount = Schema.Struct({
  provider: CloudProvider,
  state: Schema.Literals(["disconnected", "connected", "needs_auth", "usage_limited"]),
  credentialVersion: Revision,
  leasedBy: Schema.NullOr(Id),
});
export type CloudProviderAccount = typeof CloudProviderAccount.Type;
export const CloudUsageSummary = Schema.Struct({
  month: Schema.String,
  spentMicroDollars: Revision,
  reservedMicroDollars: Revision,
  limitMicroDollars: Revision,
  warning: Schema.Boolean,
});
export type CloudUsageSummary = typeof CloudUsageSummary.Type;
export const CloudOverview = Schema.Struct({
  revision: Schema.optionalKey(Revision),
  enabled: Schema.Boolean,
  repositories: Schema.Array(CloudRepository),
  tasks: Schema.Array(CloudTask),
  accounts: Schema.Array(CloudProviderAccount),
  publications: Schema.Array(CloudPublication),
  bindings: Schema.optionalKey(Schema.Array(CloudConversationBinding)),
  handoffs: Schema.optionalKey(Schema.Array(CloudHandoffOperation)),
  usage: CloudUsageSummary,
});
export type CloudOverview = typeof CloudOverview.Type;
export const CloudConnection = Schema.Struct({
  environmentId: Id,
  httpBaseUrl: Schema.String,
  bootstrapToken: Text,
});
export type CloudConnection = typeof CloudConnection.Type;
/** Desktop bootstrap access only; refresh tokens stay in the local secret store. */
export const CloudDesktopSession = Schema.Struct({
  enabled: Schema.Boolean,
  relayUrl: Schema.NullOr(Schema.String),
  accessToken: Schema.NullOr(Schema.String),
  expiresAtEpochMs: Schema.NullOr(Schema.Number),
});
export class CloudDesktopAuthError extends Schema.TaggedErrorClass<CloudDesktopAuthError>()(
  "CloudDesktopAuthError",
  {
    message: Schema.String,
    code: Schema.optionalKey(Schema.String),
    requestDisposition: Schema.optionalKey(Schema.Literals(["rejected", "unknown"])),
    retryable: Schema.optionalKey(Schema.Boolean),
  },
) {}
export const CloudSavedResult = Schema.Struct({
  revision: Schema.NullOr(CloudResultRevision),
  result: Schema.Struct({
    summary: Schema.String,
    diff: Schema.String,
    conversation: Schema.Unknown,
    testOutput: Schema.String,
    testExitCode: Schema.NullOr(Schema.Int),
  }),
});
export type CloudSavedResult = typeof CloudSavedResult.Type;
export const CloudLoginStatus = Schema.Struct({
  id: Id,
  state: Schema.Literals(["starting", "running", "completed", "failed"]),
  verificationUrl: Schema.NullOr(Schema.String),
  userCode: Schema.NullOr(Schema.String),
  error: Schema.NullOr(Schema.String),
});
export const CloudTaskEvent = Schema.Struct({
  cursor: Revision,
  attemptId: Id,
  sequence: Revision,
  phase: Schema.String,
  detail: Schema.String,
  createdAt: Timestamp,
});
export const CloudTaskFeed = Schema.Struct({
  cursor: Revision,
  reset: Schema.Boolean,
  events: Schema.Array(CloudTaskEvent),
  conversation: Schema.Unknown,
});
export const CloudCommand = Schema.Union([
  Schema.Struct({
    type: Schema.Literal("handoff.request"),
    idempotencyKey: Id,
    conversationId: Id,
    localThreadId: Id,
    cloudTaskId: Schema.NullOr(Id),
    target: CloudExecutionTarget,
    expectedGeneration: Revision,
  }),
  Schema.Struct({
    type: Schema.Literal("handoff.advance"),
    roots: Schema.optionalKey(Schema.Array(CloudRootBinding)),
    idempotencyKey: Id,
    operationId: Id,
    expectedPhase: CloudHandoffPhase,
    nextPhase: CloudHandoffPhase,
    checkpoint: Schema.NullOr(CloudSnapshotRef),
    destinationOwner: Schema.optionalKey(Id),
    cloudTaskId: Schema.optionalKey(Id),
  }),
  Schema.Struct({ type: Schema.Literal("handoff.cancel"), idempotencyKey: Id, operationId: Id }),
  Schema.Struct({
    type: Schema.Literal("publication.retry"),
    idempotencyKey: Id,
    publicationId: Id,
  }),
  Schema.Struct({
    type: Schema.Literal("repository.save"),
    idempotencyKey: Id,
    repository: CloudRepository,
  }),
  Schema.Struct({
    type: Schema.Literal("task.create"),
    runtimeMode: Schema.optionalKey(RuntimeMode),
    projectId: Schema.optionalKey(Id),
    handoff: Schema.optionalKey(CloudPreparedConversation),
    keepAliveSeconds: Schema.optionalKey(
      Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 900 })),
    ),
    attachments: Schema.optionalKey(CloudAttachments),
    source: Schema.optionalKey(CloudWorkspaceSource),
    model: Schema.optionalKey(Text),
    modelOptions: Schema.optionalKey(ProviderOptionSelections),
    interactionMode: Schema.optionalKey(ProviderInteractionMode),
    idempotencyKey: Id,
    repositoryId: Id,
    baseBranch: Text,
    provider: CloudProvider,
    kind: Schema.Literals(["build", "ask", "investigate"]),
    prompt: Text,
    issueNumber: Schema.NullOr(Schema.Int.check(Schema.isGreaterThan(0))),
  }),
  Schema.Struct({
    type: Schema.Literal("task.cancel"),
    idempotencyKey: Id,
    taskId: Id,
    // Explicit null fences a first turn whose request ID is not yet assigned.
    expectedTurnRequestId: Schema.optionalKey(Schema.NullOr(Id)),
  }),
  Schema.Struct({
    type: Schema.Literal("task.update"),
    idempotencyKey: Id,
    taskId: Id,
    title: Schema.optionalKey(Text),
    archived: Schema.optionalKey(Schema.Boolean),
  }),
  Schema.Struct({ type: Schema.Literal("task.wake"), idempotencyKey: Id, taskId: Id }),
  Schema.Struct({
    type: Schema.Literal("task.continue"),
    attachments: Schema.optionalKey(CloudAttachments),
    idempotencyKey: Id,
    taskId: Id,
    prompt: Text,
  }),
  Schema.Struct({ type: Schema.Literal("task.resume"), idempotencyKey: Id, taskId: Id }),
  Schema.Struct({ type: Schema.Literal("task.delete"), idempotencyKey: Id, taskId: Id }),
  Schema.Struct({
    type: Schema.Literal("provider.disconnect"),
    idempotencyKey: Id,
    provider: CloudProvider,
  }),
  Schema.Struct({
    type: Schema.Literal("publication.create"),
    idempotencyKey: Id,
    taskId: Id,
    resultId: Id,
    resultSha256: Digest,
    kind: Schema.Literals(["pull_request", "issue_comment"]),
    title: Text,
    body: Text,
  }),
  Schema.Struct({
    type: Schema.Literal("limits.update"),
    idempotencyKey: Id,
    monthlyComputeMicroDollars: Schema.Int.check(
      Schema.isBetween({ minimum: 0, maximum: 1_000_000_000 }),
    ),
  }),
]);
export type CloudCommand = typeof CloudCommand.Type;

export const CloudWorkerCallback = Schema.Struct({
  preparation: Schema.optionalKey(CloudPreparation),
  dependencySetup: Schema.optionalKey(CloudDependencySetup),
  closeIdle: Schema.optionalKey(Schema.Boolean),
  idle: Schema.optionalKey(Schema.Boolean),
  turnRequestId: Schema.optionalKey(Id),
  baseSha: Schema.optionalKey(Sha),
  taskId: Id,
  attemptId: Id,
  generation: Revision,
  sequence: Revision,
  phase: Schema.Literals([
    "heartbeat",
    "running",
    "waiting_for_input",
    "completed",
    "failed",
    "needs_auth",
    "usage_limited",
  ]),
  detail: Schema.String.check(Schema.isMaxLength(65536)),
  checkpoint: Schema.optionalKey(CloudCheckpoint),
  result: Schema.optionalKey(CloudResultRevision),
});
export type CloudWorkerCallback = typeof CloudWorkerCallback.Type;

export const CloudStartConversationInput = Schema.Struct({
  runtimeMode: Schema.optionalKey(RuntimeMode),
  projectId: Schema.optionalKey(Id),
  handoff: Schema.optionalKey(CloudPreparedConversation),
  attachments: Schema.optionalKey(CloudUploadAttachments),
  idempotencyKey: Id,
  target: Schema.Literals(["cloud-github", "cloud-local"]),
  roots: Schema.Array(Schema.Struct({ id: Id, path: Text })).check(
    Schema.isMinLength(1),
    Schema.isMaxLength(16),
  ),
  provider: CloudProvider,
  model: Text,
  modelOptions: Schema.optionalKey(ProviderOptionSelections),
  interactionMode: Schema.optionalKey(ProviderInteractionMode),
  prompt: Text,
});
export const CloudStartConversationResult = Schema.Struct({
  entityId: Id,
  overview: CloudOverview,
});

export const CloudContinueConversationInput = Schema.Struct({
  idempotencyKey: Id,
  taskId: Id,
  prompt: Text,
  attachments: CloudUploadAttachments,
});

/** Additive progress fields keep older desktop/native clients interoperable. */
export const CloudStartProgress = Schema.Struct({
  message: Schema.String,
  requestId: Schema.optionalKey(Id),
  sequence: Schema.optionalKey(Revision),
  phase: Schema.optionalKey(
    Schema.Literals([
      "collection",
      "upload",
      "creation",
      "cancelling",
      "cancelled",
      "completed",
      "failed",
      "unknown",
    ]),
  ),
  startedAt: Schema.optionalKey(Timestamp),
  updatedAt: Schema.optionalKey(Timestamp),
  completedBytes: Schema.optionalKey(Revision),
  totalBytes: Schema.optionalKey(Revision),
});
export type CloudStartProgress = typeof CloudStartProgress.Type;
