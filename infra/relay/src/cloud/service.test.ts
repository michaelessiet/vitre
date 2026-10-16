import { describe, expect, it } from "@effect/vitest";
import { afterEach, vi } from "vite-plus/test";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import { CloudConfiguration, type CloudConfigurationValue } from "./config.ts";
import { CloudStore, emptyDocument } from "./store.ts";
import { CloudService, currentMillis, layer } from "./service.ts";
import { CloudWorkerControl, layer as workerLayer } from "./workerControl.ts";
import { CloudArtifacts } from "./artifacts.ts";
import { CloudError } from "./policy.ts";
import { CredentialVault, sha256 } from "./crypto.ts";
import { applyCommand, confirmStopped, schedule } from "./state.ts";
const encodeJson = Schema.encodeSync(Schema.UnknownFromJsonString);
afterEach(() => vi.unstubAllGlobals());

function fixture() {
  let document = emptyDocument();
  const objects = new Map<string, Uint8Array<ArrayBuffer>>();
  const store = CloudStore.of({
    read: () => Effect.sync(() => structuredClone(document)),
    users: Effect.succeed(["user"]),
    mutate: (_, reduce) =>
      Effect.try({
        try: () => {
          const next = structuredClone(document);
          const value = reduce(next);
          document = next;
          return value;
        },
        catch: (error) =>
          error instanceof CloudError
            ? error
            : new CloudError("test_failure", "Unexpected test failure"),
      }),
  });
  const config: CloudConfigurationValue = {
    enabled: true,
    allowedUserId: "user",
    controlUrl: "https://cloud.example.com",
    encryptionKey: btoa("x".repeat(32)),
    github: { appId: "", privateKey: "", installationIds: [] },
    wake: () => Effect.void,
  };
  const services = Layer.mergeAll(layer, workerLayer).pipe(
    Layer.provide([
      NodeCrypto.layer,
      Layer.succeed(CloudConfiguration, config),
      Layer.succeed(CloudStore, store),
      Layer.succeed(CloudArtifacts, {
        put: async (key, bytes) => {
          objects.set(key, bytes);
        },
        get: async (key) => objects.get(key) ?? null,
        head: async () => null,
        delete: async () => {},
      }),
    ]),
  );
  const run = <A, E>(effect: Effect.Effect<A, E, CloudService | CloudWorkerControl>) =>
    effect.pipe(Effect.provide(services));
  return { run, state: () => document, config, store, objects };
}
const auth = JSON.stringify({
  auth_mode: "chatgpt",
  tokens: { refresh_token: "subscription-refresh" },
});

describe("cloud account and credential boundaries", () => {
  it.effect(
    "starts an owned uploaded Git repository without upstream access, preserving unpublished HEAD",
    () =>
      Effect.gen(function* () {
        const fetch = vi.fn(async () => new Response("GitHub rate limited", { status: 403 }));
        vi.stubGlobal("fetch", fetch);
        const f = fixture();
        f.state().state.accounts.codex.state = "connected";
        f.state().state.repositories.repo = {
          id: "repo",
          installationId: "public",
          owner: "owner",
          name: "repo",
          defaultBranch: "main",
          setupCommand: "",
          testCommand: "",
          revision: 1,
        };
        const head = "a".repeat(40);
        const upstream = "b".repeat(40);
        const blob = { sha256: "c".repeat(64), sizeBytes: 4, chunks: ["d".repeat(64)] };
        const bytes = new TextEncoder().encode(
          encodeJson({
            version: 2,
            roots: [
              {
                id: "primary",
                name: "repo",
                git: {
                  head,
                  publishedRevision: upstream,
                  branch: "local-feature",
                  bundle: blob,
                  index: blob,
                },
              },
            ],
            entries: [],
          }),
        );
        const digest = yield* Effect.promise(() => sha256(bytes));
        f.objects.set(`cloud-workspaces/user/manifests/${digest}`, bytes);
        const command = {
          type: "task.create" as const,
          idempotencyKey: "uploaded",
          repositoryId: "repo",
          baseBranch: "main",
          provider: "codex" as const,
          kind: "ask" as const,
          prompt: "Explain",
          issueNumber: null,
          source: {
            kind: "github" as const,
            revision: upstream,
            snapshot: { id: digest, sha256: digest },
          },
        };
        const created = yield* f.run(
          CloudService.pipe(Effect.flatMap((s) => s.command("user", command))),
        );
        const id = created.entityId;
        expect(f.state().state.tasks[id]?.baseSha).toBe(head);
        const token = "worker-token";
        const vault = new CredentialVault(f.config.encryptionKey);
        const hash = yield* Effect.promise(() => sha256(token));
        const sealed = yield* Effect.promise(() => vault.seal(token, `user:worker:${id}`));
        const endpoint = yield* Effect.promise(() => vault.seal("{}", `user:endpoint:${id}`));
        yield* f.store.mutate("user", (doc) => {
          doc.private.workerTokens[id] = { hash, sealed };
          doc.private.endpoints[id] = endpoint;
        });
        const bootstrap = yield* f.run(
          CloudWorkerControl.pipe(Effect.flatMap((s) => s.bootstrap(id, token))),
        );
        expect(bootstrap).toMatchObject({
          task: { baseSha: head },
          repositoryToken: "",
          issue: null,
        });
        expect(fetch).not.toHaveBeenCalled();
        // A different owner's object and corrupted content must never bypass validation.
        f.objects.delete(`cloud-workspaces/user/manifests/${digest}`);
        f.objects.set(`cloud-workspaces/other/manifests/${digest}`, bytes);
        const denied = yield* Effect.flip(
          f.run(
            CloudService.pipe(
              Effect.flatMap((s) => s.command("user", { ...command, idempotencyKey: "missing" })),
            ),
          ),
        );
        expect(denied.code).toBe("incomplete_workspace");
        f.objects.set(
          `cloud-workspaces/user/manifests/${digest}`,
          new TextEncoder().encode("corrupted"),
        );
        expect(
          (yield* Effect.flip(
            f.run(CloudWorkerControl.pipe(Effect.flatMap((s) => s.bootstrap(id, token)))),
          )).code,
        ).toBe("incomplete_workspace");
      }),
  );
  it.effect(
    "avoids scheduler I/O for ready resident continuations but wakes pending work and cold starts",
    () =>
      Effect.gen(function* () {
        const f = fixture();
        const now = yield* currentMillis;
        f.config.machine = {
          url: "https://machine.example.com",
          ownerId: "user",
          token: "machine-token",
        };
        let wakes = 0;
        f.config.wake = () =>
          Effect.sync(() => {
            wakes++;
          });
        const doc = f.state();
        doc.state.accounts.codex.state = "connected";
        doc.state.repositories.repo = {
          id: "repo",
          installationId: "1",
          owner: "owner",
          name: "repo",
          defaultBranch: "main",
          setupCommand: "",
          testCommand: "",
          revision: 1,
        };
        applyCommand(
          doc.state,
          {
            type: "task.create",
            idempotencyKey: "create",
            repositoryId: "repo",
            baseBranch: "main",
            provider: "codex",
            kind: "ask",
            prompt: "Explain",
            issueNumber: null,
          },
          "task",
          "create",
          now,
          true,
        );
        schedule(doc.state, now, true, true);
        const provision = Object.values(doc.state.operations)[0]!;
        doc.state.operations = {};
        doc.state.tasks.task!.state = "running";
        doc.state.tasks.task!.idle = true;
        doc.state.tasks.task!.worker!.state = "ready";
        doc.state.tasks.task!.worker!.sandboxId = "machine-task-1";
        const send = (key: string) =>
          f.run(
            CloudService.pipe(
              Effect.flatMap((service) =>
                service.command("user", {
                  type: "task.continue",
                  taskId: "task",
                  idempotencyKey: key,
                  prompt: "Next",
                }),
              ),
            ),
          );
        const warm = yield* send("warm");
        expect(warm.overview.tasks.find((task) => task.id === "task")).toMatchObject({
          state: "running",
          idle: false,
          turnRequestId: "warm",
        });
        expect(wakes).toBe(0);
        yield* f.store.mutate("user", (document) => {
          document.state.tasks.task!.idle = true;
          document.state.operations["unrelated"] = {
            ...provision,
            id: "unrelated",
            taskId: "other",
            kind: "stop",
          };
        });
        yield* send("with-pending-operation");
        expect(wakes).toBe(1);
        yield* f.store.mutate("user", (document) => {
          document.state.operations = {};
          document.state.tasks.task!.state = "completed";
          confirmStopped(document.state, "task", "task-1", now);
        });
        const cold = yield* send("cold");
        expect(cold.overview.tasks.find((task) => task.id === "task")?.state).toBe("preparing");
        expect(wakes).toBe(2);
        expect(
          Object.values(f.state().state.operations).some(
            (operation) => operation.kind === "provision",
          ),
        ).toBe(true);
      }),
  );

  it.effect(
    "leases resident turns atomically and never exposes credentials to a waiting worker",
    () =>
      Effect.gen(function* () {
        const f = fixture();
        f.config.machine = {
          url: "https://machine.example.com",
          ownerId: "user",
          token: "machine-token",
        };
        yield* f.run(
          CloudService.pipe(
            Effect.flatMap((service) =>
              service.saveCredential("user", "codex", auth, 0, "connect"),
            ),
          ),
        );
        const token = "worker-token";
        const vault = new CredentialVault(f.config.encryptionKey);
        const hash = yield* Effect.promise(() => sha256(token));
        const sealed = yield* Effect.promise(() => vault.seal(token, "user:worker:task"));
        const endpoint = yield* Effect.promise(() => vault.seal("{}", "user:endpoint:task"));
        yield* f.store.mutate("user", (document) => {
          document.state.repositories.repo = {
            id: "repo",
            installationId: "1",
            owner: "owner",
            name: "repo",
            defaultBranch: "main",
            revision: 1,
            setupCommand: "",
            testCommand: "",
          };
          applyCommand(
            document.state,
            {
              type: "task.create",
              idempotencyKey: "task",
              repositoryId: "repo",
              baseBranch: "main",
              provider: "codex",
              kind: "ask",
              prompt: "Explain",
              issueNumber: null,
            },
            "task",
            "task",
            0,
            true,
          );
          schedule(document.state, 0, true, true);
          const task = document.state.tasks.task!;
          task.worker!.sandboxId = null;
          task.worker!.state = "provisioning";
          document.private.workerTokens.task = { hash, sealed };
          document.private.endpoints.task = endpoint;
        });
        const lease = (action: "acquire" | "release", turnRequestId?: string) =>
          f.run(
            CloudWorkerControl.pipe(
              Effect.flatMap((control) =>
                control.lease("task", token, "task-1", action, turnRequestId),
              ),
            ),
          );
        // The worker may authenticate before ensure() returns to the scheduler.
        // Neither a stale attempt nor an invalid token may reserve its identity.
        const provisional = structuredClone(f.state());
        const staleAttempt = yield* Effect.flip(
          f.run(
            CloudWorkerControl.pipe(
              Effect.flatMap((control) => control.lease("task", token, "task-0", "acquire")),
            ),
          ),
        );
        expect(staleAttempt.code).toBe("stale_worker");
        expect(f.state()).toEqual(provisional);
        const invalidProvisionalToken = yield* Effect.flip(
          f.run(
            CloudWorkerControl.pipe(
              Effect.flatMap((control) =>
                control.lease("task", "different-worker-token", "task-1", "acquire"),
              ),
            ),
          ),
        );
        expect(invalidProvisionalToken.code).toBe("unauthorized");
        expect(f.state()).toEqual(provisional);
        const machine = f.config.machine;
        delete f.config.machine;
        expect((yield* Effect.flip(lease("acquire"))).code).toBe("unsupported");
        expect(f.state()).toEqual(provisional);
        f.config.machine = machine;
        expect(yield* lease("acquire")).toMatchObject({ acquired: true, credential: auth });
        expect(f.state().state.tasks.task!.worker!.sandboxId).toBe("machine-task-1");
        yield* f.run(
          CloudService.pipe(
            Effect.flatMap((service) =>
              service.callback(token, {
                taskId: "task",
                attemptId: "task-1",
                generation: 1,
                sequence: 1,
                phase: "running",
                detail: "",
                idle: true,
              }),
            ),
          ),
        );
        const bootstrap = yield* f.run(
          CloudWorkerControl.pipe(Effect.flatMap((control) => control.bootstrap("task", token))),
        );
        expect(bootstrap).toMatchObject({
          resident: true,
          leaseOwned: true,
          leaseTurnRequestId: null,
        });
        for (const invalidToken of ["", "different-worker-token"]) {
          const before = structuredClone(f.state());
          const denied = yield* Effect.flip(
            f.run(
              CloudWorkerControl.pipe(
                Effect.flatMap((control) =>
                  control.lease("task", invalidToken, "task-1", "release"),
                ),
              ),
            ),
          );
          expect(denied.code).toBe("unauthorized");
          expect(f.state()).toEqual(before);
        }
        yield* lease("release");
        const readCredential = () =>
          f.run(
            CloudWorkerControl.pipe(
              Effect.flatMap((control) => control.credential("task", token, "task-1")),
            ),
          );
        expect((yield* Effect.flip(readCredential())).code).toBe("stale_worker");
        yield* f.store.mutate("user", (document) => {
          document.state.tasks.task!.handoff = {
            operationId: "switch",
            conversationId: "conversation",
            generation: 0,
            history: { sha256: "a".repeat(64), sizeBytes: 1, chunks: ["b".repeat(64)] },
          };
          document.state.bindings = {
            conversation: {
              conversationId: "conversation",
              localThreadId: "local",
              cloudTaskId: null,
              target: "local",
              generation: 0,
              leaseOwner: null,
              leaseExpiresAt: null,
            },
          };
          document.state.handoffs = {
            switch: {
              id: "switch",
              conversationId: "conversation",
              from: "local",
              to: "cloud-local",
              generation: 0,
              phase: "verifying",
              checkpoint: { id: "saved", sha256: "c".repeat(64) },
              error: null,
            },
          };
        });
        expect((yield* Effect.flip(readCredential())).code).toBe("stale_worker");
        yield* f.store.mutate("user", (document) => {
          document.state.tasks.task!.worker!.sandboxId = "retired-task-1";
        });
        expect((yield* Effect.flip(readCredential())).code).toBe("stale_worker");
        expect(
          (yield* Effect.flip(
            f.run(
              CloudWorkerControl.pipe(
                Effect.flatMap((control) => control.bootstrap("task", token)),
              ),
            ),
          )).code,
        ).toBe("stale_worker");
        yield* f.store.mutate("user", (document) => {
          document.state.tasks.task!.worker!.sandboxId = "machine-task-1";
          delete document.state.tasks.task!.handoff;
          document.state.tasks.task!.idle = false;
          document.state.tasks.task!.turnRequestId = "next";
          document.state.accounts.codex.leasedBy = "another-task-1";
        });
        expect(yield* lease("acquire", "next")).toEqual({ acquired: false });
        yield* f.store.mutate("user", (document) => {
          document.state.accounts.codex.leasedBy = null;
        });
        expect(yield* lease("acquire", "next")).toEqual({
          acquired: true,
          version: 1,
          credential: auth,
        });
        const refreshedAuth = encodeJson({ tokens: { refresh_token: "rotated-subscription" } });
        yield* f.run(
          CloudWorkerControl.pipe(
            Effect.flatMap((control) =>
              control.refreshCredential("task", token, "task-1", 1, refreshedAuth),
            ),
          ),
        );
        yield* lease("release", "next");
        expect(
          (yield* Effect.flip(
            f.run(
              CloudWorkerControl.pipe(
                Effect.flatMap((control) =>
                  control.refreshCredential("task", token, "task-1", 2, auth),
                ),
              ),
            ),
          )).code,
        ).toBe("credential_conflict");
        expect(yield* lease("acquire", "next")).toEqual({
          acquired: true,
          version: 2,
          credential: refreshedAuth,
        });
        yield* f.store.mutate("user", (document) => {
          document.state.tasks.task!.turnRequestId = "retained-next";
        });
        expect(
          yield* f.run(
            CloudWorkerControl.pipe(Effect.flatMap((control) => control.bootstrap("task", token))),
          ),
        ).toMatchObject({
          leaseOwned: true,
          leaseTurnRequestId: "next",
          task: { turnRequestId: "retained-next" },
        });
        expect(yield* lease("acquire", "retained-next")).toMatchObject({
          acquired: true,
          version: 2,
        });
        yield* lease("release", "next");
        expect((yield* f.store.read("user")).state.accounts.codex.leasedBy).toBe("task-1");
        yield* f.store.mutate("user", (document) => {
          const task = document.state.tasks.task!;
          task.idle = true;
          document.state.tasks.waiting = {
            ...structuredClone(task),
            id: "waiting",
            state: "queued",
            attempt: null,
            worker: null,
          };
        });
        expect(
          yield* f.run(
            CloudWorkerControl.pipe(Effect.flatMap((control) => control.bootstrap("task", token))),
          ),
        ).toMatchObject({ leaseOwned: true, leaseTurnRequestId: "retained-next", yieldIdle: true });
        yield* f.store.mutate("user", (document) => {
          document.state.tasks.task!.worker!.sandboxId = null;
        });
        expect(
          yield* f.run(
            CloudWorkerControl.pipe(Effect.flatMap((control) => control.bootstrap("task", token))),
          ),
        ).toMatchObject({ resident: true });
      }),
  );
  it.effect("checks account ownership and stores only encrypted subscription credentials", () =>
    Effect.gen(function* () {
      const f = fixture();
      expect(
        (yield* Effect.flip(
          f.run(CloudService.pipe(Effect.flatMap((service) => service.overview("another-user")))),
        )).message,
      ).toContain("cannot access");
      yield* f.run(
        CloudService.pipe(
          Effect.flatMap((service) => service.saveCredential("user", "codex", auth, 0, "connect")),
        ),
      );
      expect(encodeJson(f.state())).not.toContain("subscription-refresh");
      expect(f.state().state.accounts.codex.credentialVersion).toBe(1);
      yield* f.run(
        CloudService.pipe(
          Effect.flatMap((service) => service.saveCredential("user", "codex", auth, 0, "connect")),
        ),
      );
      expect(f.state().state.accounts.codex.credentialVersion).toBe(1);
      expect(
        (yield* Effect.flip(
          f.run(
            CloudService.pipe(
              Effect.flatMap((service) =>
                service.saveCredential("user", "codex", auth, 1, "connect"),
              ),
            ),
          ),
        )).message,
      ).toContain("another request");
    }),
  );
  it.effect("rejects API billing credentials and malformed refresh caches", () =>
    Effect.gen(function* () {
      const f = fixture();
      for (const credential of [
        "null",
        "{}",
        '{"OPENAI_API_KEY":"api-secret"}',
        '{"tokens":{"refresh_token":""}}',
      ]) {
        expect(
          (yield* Effect.flip(
            f.run(
              CloudService.pipe(
                Effect.flatMap((service) =>
                  service.saveCredential("user", "codex", credential, 0, "invalid"),
                ),
              ),
            ),
          )).message,
        ).toContain("subscription");
      }
      expect(f.state().private.credentials).toEqual({});
    }),
  );
  it.effect(
    "fences concurrent credential refreshes and disconnects before an old worker can overwrite the account",
    () =>
      Effect.gen(function* () {
        const f = fixture();
        yield* f.run(
          CloudService.pipe(
            Effect.flatMap((service) =>
              service.saveCredential("user", "codex", auth, 0, "connect"),
            ),
          ),
        );
        const token = "worker-token";
        const sealed = yield* Effect.promise(() =>
          new CredentialVault(f.config.encryptionKey).seal(token, "user:worker:task"),
        );
        const hash = yield* Effect.promise(() => sha256(token));
        yield* f.store.mutate("user", (document) => {
          document.state.repositories.repo = {
            id: "repo",
            installationId: "1",
            owner: "owner",
            name: "repo",
            defaultBranch: "main",
            revision: 1,
            setupCommand: "",
            testCommand: "",
          };
          applyCommand(
            document.state,
            {
              type: "task.create",
              idempotencyKey: "task",
              repositoryId: "repo",
              baseBranch: "main",
              provider: "codex",
              kind: "ask",
              prompt: "Explain",
              issueNumber: null,
            },
            "task",
            "task",
            0,
            true,
          );
          schedule(document.state, 0, true);
          document.private.workerTokens.task = { hash, sealed };
        });
        const event = {
          taskId: "task",
          attemptId: "task-1",
          generation: 1,
          sequence: 1,
          phase: "heartbeat" as const,
          detail: "Conversation updated",
        };
        yield* f.run(
          CloudWorkerControl.pipe(
            Effect.flatMap((control) => control.mirror(token, event, { messages: ["persisted"] })),
          ),
        );
        yield* f.run(
          CloudWorkerControl.pipe(
            Effect.flatMap((control) =>
              control.mirror(token, event, { messages: ["duplicate must not replace"] }),
            ),
          ),
        );
        expect(f.state().state.events?.task).toHaveLength(1);
        const projection = f.state().state.projections?.task;
        expect(projection).toBeDefined();
        expect(
          (yield* Effect.flip(
            f.run(
              CloudWorkerControl.pipe(
                Effect.flatMap((control) =>
                  control.mirror(token, { ...event, generation: 0, sequence: 2 }, {}),
                ),
              ),
            ),
          )).code,
        ).toBe("stale_worker");
        expect(f.state().state.projections?.task).toEqual(projection);
        const feed = yield* f.run(
          CloudWorkerControl.pipe(Effect.flatMap((control) => control.events("user", "task", 0))),
        );
        expect(feed.conversation).toEqual({ messages: ["persisted"] });
        expect(feed.cursor).toBe(1);
        expect(
          (yield* Effect.flip(
            f.run(
              CloudWorkerControl.pipe(
                Effect.flatMap((control) => control.events("another", "task", 0)),
              ),
            ),
          )).status,
        ).toBe(403);
        const refresh = () =>
          f.run(
            CloudWorkerControl.pipe(
              Effect.flatMap((control) =>
                control.refreshCredential("task", token, "task-1", 1, auth),
              ),
            ),
          );
        const outcomes = yield* Effect.all([Effect.exit(refresh()), Effect.exit(refresh())], {
          concurrency: 2,
        });
        expect(outcomes.filter((outcome) => outcome._tag === "Success")).toHaveLength(1);
        expect(f.state().state.accounts.codex.credentialVersion).toBe(2);
        yield* f.run(
          CloudService.pipe(
            Effect.flatMap((service) =>
              service.command("user", {
                type: "provider.disconnect",
                idempotencyKey: "disconnect",
                provider: "codex",
              }),
            ),
          ),
        );
        expect(f.state().private.credentials.codex).toBeUndefined();
        expect((yield* Effect.flip(refresh())).message).toContain("version or lease");
        expect(f.state().private.credentials.codex).toBeUndefined();
        const chunk = new TextEncoder().encode("checkpoint bytes");
        const chunkHash = yield* Effect.promise(() => sha256(chunk));
        const manifest = new TextEncoder().encode(
          encodeJson({
            attemptId: "task-1",
            checkpointId: "saved",
            chunks: [{ index: 0, sha256: chunkHash, sizeBytes: chunk.length }],
          }),
        );
        const manifestHash = yield* Effect.promise(() => sha256(manifest));
        f.objects.set("manifest", manifest);
        f.objects.set(`cloud/user/task/task-1/saved/0-${chunkHash}`, chunk);
        yield* f.store.mutate("user", (doc) => {
          doc.state.tasks.task!.worker!.state = "stopped";
          doc.state.tasks.task!.checkpoint = {
            id: "saved",
            taskId: "task",
            attemptId: "task-1",
            sequence: 1,
            objectKey: "manifest",
            sha256: manifestHash,
            sizeBytes: chunk.length,
            createdAt: "2026-09-20T00:00:00Z",
          };
        });
        const artifact = yield* f.run(
          CloudWorkerControl.pipe(Effect.flatMap((control) => control.artifact("user", "task", 0))),
        );
        expect(artifact).toEqual({ base64: btoa("checkpoint bytes"), sha256: chunkHash });
        f.objects.set(
          `cloud/user/task/task-1/saved/0-${chunkHash}`,
          new TextEncoder().encode("tampered"),
        );
        expect(
          (yield* Effect.flip(
            f.run(
              CloudWorkerControl.pipe(
                Effect.flatMap((control) => control.artifact("user", "task", 0)),
              ),
            ),
          )).code,
        ).toBe("invalid_checkpoint");
      }),
  );
});
