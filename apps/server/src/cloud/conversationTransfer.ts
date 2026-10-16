// @effect-diagnostics nodeBuiltinImport:off - Content-addressed transfer filesystem boundary.
import * as NodeFSP from "node:fs/promises";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import type { OrchestrationThread, TerminalSessionSnapshot } from "@t3tools/contracts";
import {
  CloudConversationSnapshot,
  CloudDesktopAuthError,
  CloudTerminalState,
  type CloudTransferRequest,
  type CloudTransferResult,
} from "@t3tools/contracts/cloud";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import {
  CHUNK_BYTES,
  captureWorkspace,
  digest,
} from "../../../../scripts/vitre/cloud/workspace.mjs";
import { exportAttachmentFiles } from "../../../../scripts/vitre/cloud/attachments.mjs";
import { attachmentRelativePath } from "../attachmentStore.ts";
import { ProviderRegistry } from "../provider/Services/ProviderRegistry.ts";
import { validateCloudProvider } from "./providerValidation.ts";
import { TerminalManager } from "../terminal/Manager.ts";
import { ServerConfig } from "../config.ts";
import { ProjectionSnapshotQuery } from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import { isolatedWorkspaceRoots, readExecutionOwnership } from "./executionOwnership.ts";

const decodeTerminal = Schema.decodeUnknownSync(CloudTerminalState);
const decodeSnapshot = Schema.decodeUnknownSync(CloudConversationSnapshot);

export class ConversationChunkStore {
  readonly directory: string;
  constructor(directory: string) {
    this.directory = directory;
  }
  async put(bytes: Uint8Array): Promise<string> {
    if (!bytes.length || bytes.length > CHUNK_BYTES) throw new Error("Invalid transfer chunk size");
    const hash = digest(bytes);
    await NodeFSP.mkdir(this.directory, { recursive: true, mode: 0o700 });
    const temporary = await NodeFSP.mkdtemp(NodePath.join(this.directory, ".chunk-"));
    try {
      const file = await NodeFSP.open(NodePath.join(temporary, "data"), "wx", 0o600);
      try {
        await file.writeFile(bytes);
        await file.sync();
      } finally {
        await file.close();
      }
      await NodeFSP.rename(NodePath.join(temporary, "data"), NodePath.join(this.directory, hash));
    } finally {
      await NodeFSP.rm(temporary, { recursive: true, force: true });
    }
    return hash;
  }
  async get(hash: string): Promise<Uint8Array> {
    if (!/^[a-f0-9]{64}$/.test(hash)) throw new Error("Invalid transfer hash");
    const handle = await NodeFSP.open(
      NodePath.join(this.directory, hash),
      NodeFS.constants.O_RDONLY | NodeFS.constants.O_NOFOLLOW,
    );
    try {
      const stat = await handle.stat();
      if (!stat.isFile() || stat.size > CHUNK_BYTES) throw new Error("Invalid transfer chunk");
      const bytes = await handle.readFile();
      if (digest(bytes) !== hash) throw new Error("Transfer chunk failed integrity verification");
      return bytes;
    } finally {
      await handle.close();
    }
  }
  async putBlob(bytes: Uint8Array) {
    if (bytes.length > 360 * 1024 * 1024) throw new Error("Conversation exceeds transfer limit");
    const chunks = [];
    for (let offset = 0; offset < bytes.length; offset += CHUNK_BYTES)
      chunks.push(await this.put(bytes.subarray(offset, offset + CHUNK_BYTES)));
    return { sha256: digest(bytes), sizeBytes: bytes.length, chunks };
  }
}

export async function captureConversation(
  thread: OrchestrationThread,
  roots: readonly { id: string; path: string }[],
  attachmentsDirectory: string,
  chunks: ConversationChunkStore,
  terminals: readonly TerminalSessionSnapshot[] = [],
): Promise<CloudConversationSnapshot> {
  const names = [
    ...new Set(
      thread.messages.flatMap((message) => (message.attachments ?? []).map(attachmentRelativePath)),
    ),
  ];
  const attachments = await exportAttachmentFiles(attachmentsDirectory, names);
  if (attachments.length !== names.length)
    throw new Error("A conversation attachment is missing; restore it before moving");
  const portableTerminals = terminals.map((terminal) => {
    const root = [...roots]
      .sort((a, b) => b.path.length - a.path.length)
      .find((root) => {
        const relative = NodePath.relative(root.path, terminal.cwd);
        return !relative.startsWith("..") && !NodePath.isAbsolute(relative);
      });
    if (!root) throw new Error("A terminal is outside the conversation workspace");
    return decodeTerminal({
      terminalId: terminal.terminalId,
      rootId: root.id,
      relativeCwd: NodePath.relative(root.path, terminal.cwd),
      history: terminal.history,
      ...(terminal.managedCommand ? { managedCommand: terminal.managedCommand } : {}),
    });
  });
  const history = await chunks.putBlob(
    Buffer.from(JSON.stringify({ version: 1, thread, attachments, terminals: portableTerminals })),
  );
  const workspace = await captureWorkspace(roots, (hash, bytes) =>
    chunks.put(bytes).then((stored) => {
      if (stored !== hash) throw new Error("Capture integrity mismatch");
    }),
  );
  return decodeSnapshot({
    projectId: thread.projectId,
    version: 1,
    workspace,
    history,
    roots,
  });
}

export const transferConversationEffect = Effect.fn("cloud.transfer_conversation")(function* (
  input: CloudTransferRequest,
) {
  const config = yield* ServerConfig;
  if (input.type === "ownership")
    return { type: "ownership", execution: yield* readExecutionOwnership(input.threadId) } as const;
  if (input.type === "validateProvider") {
    const query = yield* ProjectionSnapshotQuery;
    const thread = yield* query.getThreadDetailById(input.threadId);
    if (Option.isNone(thread))
      return yield* new CloudDesktopAuthError({ message: "Conversation not found" });
    const registry = yield* Effect.serviceOption(ProviderRegistry);
    const providers = Option.isSome(registry)
      ? yield* registry.value.refreshInstance(thread.value.modelSelection.instanceId)
      : [];
    return validateCloudProvider(thread.value.modelSelection, providers);
  }
  const chunks = new ConversationChunkStore(
    NodePath.join(config.stateDir, "cloud-transfer", "chunks"),
  );
  if (input.type === "write")
    return yield* Effect.tryPromise(async () => {
      const bytes = Buffer.from(input.base64, "base64");
      if (bytes.toString("base64") !== input.base64) throw new Error("Invalid chunk encoding");
      return { type: "stored", sha256: await chunks.put(bytes) } as const;
    });
  if (input.type === "read")
    return yield* Effect.tryPromise(
      async () =>
        ({
          type: "chunk",
          sha256: input.sha256,
          base64: Buffer.from(await chunks.get(input.sha256)).toString("base64"),
        }) as const,
    );
  const execution = yield* readExecutionOwnership(input.threadId);
  const terminalManager = yield* Effect.serviceOption(TerminalManager);
  if (input.type === "closeTerminals") {
    if (
      execution.status !== "released" ||
      execution.operationId !== input.operationId ||
      execution.generation !== input.generation
    )
      return yield* new CloudDesktopAuthError({
        message: "Ownership changed before releasing terminals",
      });
    if (Option.isSome(terminalManager))
      yield* terminalManager.value.close({ threadId: input.threadId });
    return { type: "terminalsRestored" } as const;
  }
  if (
    execution.status !==
      (input.type === "restoreTerminals" && input.resumeCommands ? "active" : "frozen") ||
    execution.operationId !== input.operationId ||
    execution.generation !== input.generation
  )
    return yield* new CloudDesktopAuthError({
      message: "Freeze this conversation before capturing it",
    });
  const query = yield* ProjectionSnapshotQuery;
  const thread = yield* query.getThreadDetailById(input.threadId);
  if (Option.isNone(thread))
    return yield* new CloudDesktopAuthError({ message: "Conversation not found" });
  const project = yield* query.getProjectShellById(thread.value.projectId);
  if (Option.isNone(project))
    return yield* new CloudDesktopAuthError({ message: "Project not found" });
  const roots = [{ id: "primary", path: thread.value.worktreePath ?? project.value.workspaceRoot }];
  const additional = [
    ...(project.value.resolvedAdditionalRoots ?? []),
    ...(thread.value.resolvedAdditionalRoots ?? []),
  ];
  for (const root of additional) {
    if (!root.path)
      return yield* new CloudDesktopAuthError({
        message: "An additional workspace root is unavailable",
      });
    if (!roots.some((entry) => entry.path === root.path))
      roots.push({ id: `root-${roots.length}`, path: root.path });
  }
  const effective = yield* isolatedWorkspaceRoots(input.threadId, {
    primary: roots[0]!.path,
    additional: roots.slice(1).map((root) => root.path),
  });
  const isolated = roots.filter(
    (root, index) => index === 0 || effective.additional.includes(root.path),
  );
  const mappedRoots = yield* Effect.tryPromise(() =>
    Promise.all(
      isolated.map(async (root) => {
        const saved = await NodeFSP.readFile(
          NodePath.join(
            config.stateDir,
            "cloud-transfer",
            "root-identities",
            `${digest(root.path)}.json`,
          ),
          "utf8",
        )
          .then(JSON.parse)
          .catch((error: NodeJS.ErrnoException) => {
            if (error.code === "ENOENT") return null;
            throw error;
          });
        if (saved && (!/^[a-zA-Z0-9_-]{1,128}$/.test(saved.id) || saved.path !== root.path))
          throw new Error("Invalid workspace identity");
        return saved ? { id: String(saved.id), path: root.path } : root;
      }),
    ),
  );
  if (input.type === "restoreTerminals") {
    if (
      input.terminals.length &&
      (Option.isNone(terminalManager) || !terminalManager.value.importHistory)
    )
      return yield* new CloudDesktopAuthError({ message: "This runtime cannot restore terminals" });
    for (const terminal of input.terminals) {
      const root = mappedRoots.find((root) => root.id === terminal.rootId);
      const relative = terminal.relativeCwd;
      if (!root || NodePath.isAbsolute(relative) || relative.split(/[\\/]/).includes(".."))
        return yield* new CloudDesktopAuthError({ message: "Invalid terminal workspace path" });
      if (input.resumeCommands) {
        if (terminal.managedCommand && Option.isSome(terminalManager)) {
          // Persist intent before writing to the PTY: an ambiguous restart must never replay a command.
          const claimed = yield* Effect.tryPromise(async () => {
            const marker = NodePath.join(
              config.stateDir,
              "cloud-transfer",
              "commands",
              digest(`${input.operationId}:${terminal.terminalId}`),
            );
            await NodeFSP.mkdir(NodePath.dirname(marker), { recursive: true, mode: 0o700 });
            try {
              await NodeFSP.writeFile(marker, "claimed", { flag: "wx", mode: 0o600 });
              return true;
            } catch (error) {
              if ((error as NodeJS.ErrnoException).code === "EEXIST") return false;
              throw error;
            }
          });
          if (claimed)
            yield* terminalManager.value.write({
              threadId: input.threadId,
              terminalId: terminal.terminalId,
              data: terminal.managedCommand,
              managedCommand: true,
            });
        }
        continue;
      }
      if (Option.isSome(terminalManager))
        yield* terminalManager.value.importHistory!(
          {
            threadId: input.threadId,
            terminalId: terminal.terminalId,
            cwd: NodePath.join(root.path, relative),
            worktreePath: roots[0]!.path,
          },
          terminal.history,
        );
    }
    return { type: "terminalsRestored" } as const;
  }
  const terminals =
    Option.isSome(terminalManager) && terminalManager.value.exportThread
      ? yield* terminalManager.value.exportThread(input.threadId)
      : [];
  const snapshot = yield* Effect.tryPromise(() =>
    captureConversation(thread.value, mappedRoots, config.attachmentsDir, chunks, terminals),
  );
  const current = yield* readExecutionOwnership(input.threadId);
  if (
    current.status !== "frozen" ||
    current.operationId !== input.operationId ||
    current.generation !== input.generation
  )
    return yield* new CloudDesktopAuthError({ message: "Ownership changed during capture" });
  return { type: "snapshot", snapshot } satisfies CloudTransferResult;
});
