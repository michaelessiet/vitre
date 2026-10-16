import { afterEach, expect, it, vi } from "@effect/vitest";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import {
  ManagedEndpointProvider,
  ManagedEndpointProvisioningFailed,
} from "../environments/ManagedEndpointProvider.ts";
import { ManagedTunnelLimitExceeded } from "../environments/ManagedTunnelLimits.ts";
import { CloudConfiguration } from "./config.ts";
import { CloudStore, emptyDocument } from "./store.ts";
import { CloudScheduler, layer } from "./scheduler.ts";
import { CloudAuxiliary, make as makeAuxiliary, layer as auxiliaryLayer } from "./auxiliary.ts";
import { CloudArtifacts } from "./artifacts.ts";
import { applyCommand, schedule } from "./state.ts";
import { CloudError, CLOUD_POLICY, iso } from "./policy.ts";
import { currentMillis } from "./service.ts";

afterEach(() => vi.unstubAllGlobals());

it.effect.each([
  {
    label: "capacity counts and corrective actions",
    failure: new ManagedTunnelLimitExceeded({
      userId: "private-user-id",
      environmentId: "private-environment-id",
      maxTunnels: 3,
      activeTunnels: 3,
    }),
    message:
      "Cloud endpoint capacity reached: 3 of 3 endpoints in use. Increase your account capacity or delete an unused cloud conversation.",
  },
  {
    label: "sanitized non-capacity provisioning failure",
    failure: new ManagedEndpointProvisioningFailed({
      stage: "get-tunnel-token",
      userId: "private-user-id",
      environmentId: "private-environment-id",
      tunnelId: "private-tunnel-id",
      cause: new Error("provider-secret-must-not-be-shown"),
    }),
    message: "Could not provision the worker endpoint",
  },
])("stores $label on the task and clears it after successful retry", ({ failure, message }) =>
  Effect.gen(function* () {
    const now = yield* currentMillis;
    let doc = emptyDocument();
    const id = "00000000-0000-4000-8000-000000000007";
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
    doc.state.accounts.codex.state = "connected";
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
      id,
      "create",
      now,
      true,
    );
    const store = CloudStore.of({
      users: Effect.succeed(["user"]),
      read: () => Effect.sync(() => structuredClone(doc)),
      mutate: (_, reduce) =>
        Effect.sync(() => {
          const next = structuredClone(doc);
          const result = reduce(next);
          doc = next;
          return result;
        }),
    });
    let failEndpoint = true;
    let workersStarted = 0;
    vi.stubGlobal("fetch", async (input: string | URL, init: RequestInit) => {
      const url = new URL(String(input));
      if (url.pathname === "/v1/attempts") return Response.json([]);
      if (url.pathname.endsWith("/prepare")) return Response.json({ port: 20000 });
      if (init.method === "PUT") {
        workersStarted++;
        return Response.json({ id: `machine-${id}-1` });
      }
      throw new Error("Unexpected machine request");
    });
    const services = layer.pipe(
      Layer.provide(auxiliaryLayer),
      Layer.provide([
        NodeCrypto.layer,
        Layer.succeed(CloudStore, store),
        Layer.succeed(CloudConfiguration, {
          enabled: true,
          allowedUserId: "user",
          controlUrl: "https://cloud.example.com",
          encryptionKey: btoa("x".repeat(32)),
          machine: { url: "https://machine.example", token: "m".repeat(64), ownerId: "user" },
          github: { appId: "", privateKey: "", installationIds: [] },
          wake: () => Effect.void,
        }),
        Layer.succeed(CloudArtifacts, {
          get: async () => null,
          head: async () => null,
          put: async () => {},
          delete: async () => {},
        }),
        Layer.succeed(ManagedEndpointProvider, {
          provision: () =>
            failEndpoint
              ? Effect.fail(failure)
              : Effect.succeed({
                  endpoint: {
                    httpBaseUrl: "https://cloud.test/",
                    wsBaseUrl: "wss://cloud.test/ws",
                    providerKind: "cloudflare_tunnel" as const,
                  },
                  runtime: {
                    providerKind: "cloudflare_tunnel" as const,
                    connectorToken: "connector",
                    tunnelId: "tunnel",
                    tunnelName: "tunnel",
                  },
                }),
          deprovision: () => Effect.void,
        }),
      ]),
    );
    yield* Effect.gen(function* () {
      const scheduler = yield* CloudScheduler;
      yield* scheduler.tick("user");
      expect(doc.state.tasks[id]!.error).toBe(message);
      expect(doc.state.tasks[id]!.error).not.toContain("private-");
      expect(doc.state.tasks[id]!.error).not.toContain("provider-secret");
      expect(workersStarted).toBe(0);
      expect(doc.private.endpoints[id]).toBeUndefined();
      failEndpoint = false;
      yield* scheduler.tick("user");
      expect(workersStarted).toBe(1);
      expect(doc.state.tasks[id]!.error).toBeNull();
      expect(doc.state.tasks[id]!.worker!.state).toBe("starting");
    }).pipe(Effect.provide(services));
  }),
);

it.effect.each(["auxiliary", "inventory", "orphan deletion"] as const)(
  "starts queued work before blocked %s maintenance, then still cleans only orphan attempts",
  (blockedPhase) =>
    Effect.gen(function* () {
      const now = yield* currentMillis;
      let notifyBlocked = () => {};
      let unblock = () => {};
      const blocked = new Promise<void>((resolve) => {
        notifyBlocked = resolve;
      });
      const release = new Promise<void>((resolve) => {
        unblock = resolve;
      });
      const waitForRelease = () => {
        notifyBlocked();
        return release;
      };
      let doc = emptyDocument();
      const id = "00000000-0000-4000-8000-000000000003";
      const orphan = "00000000-0000-4000-8000-000000000004-1";
      const auxiliaryId = "login-00000000-0000-4000-8000-000000000005";
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
      doc.state.accounts.codex.state = "connected";
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
        id,
        "create",
        now,
        true,
      );
      const store = CloudStore.of({
        users: Effect.succeed(["user"]),
        read: () => Effect.sync(() => structuredClone(doc)),
        mutate: (_, reduce) =>
          Effect.sync(() => {
            const next = structuredClone(doc);
            const result = reduce(next);
            doc = next;
            return result;
          }),
      });
      const deleted: string[] = [];
      let provisioned = false;
      let auxiliaryTicks = 0;
      vi.stubGlobal("fetch", async (input: string | URL, init: RequestInit) => {
        const url = new URL(String(input));
        if (url.pathname === "/v1/attempts") {
          if (blockedPhase === "inventory") await waitForRelease();
          return Response.json(
            [`${id}-1`, orphan, auxiliaryId].map((attemptId) => ({
              id: `machine-${attemptId}`,
              attemptId,
            })),
          );
        }
        if (url.pathname.endsWith("/prepare")) return Response.json({ port: 20000 });
        if (init.method === "PUT") {
          provisioned = true;
          return Response.json({ id: `machine-${id}-1` });
        }
        if (init.method === "DELETE") {
          if (blockedPhase === "orphan deletion") await waitForRelease();
          deleted.push(url.pathname);
          return Response.json({});
        }
        throw new Error("Unexpected machine request");
      });
      const services = layer.pipe(
        Layer.provide(
          Layer.effect(
            CloudAuxiliary,
            makeAuxiliary.pipe(
              Effect.map((service) => ({
                ...service,
                tick: () =>
                  Effect.gen(function* () {
                    auxiliaryTicks++;
                    if (blockedPhase === "auxiliary") yield* Effect.promise(waitForRelease);
                    // A job claimed during maintenance must survive orphan cleanup.
                    doc.state.jobs ??= {};
                    doc.state.jobs[auxiliaryId] = {
                      id: auxiliaryId,
                      kind: "login",
                      publicationId: null,
                      state: "completed",
                      deleted: true,
                      startedAt: iso(now),
                      deadlineAt: iso(now),
                      billedThrough: iso(now),
                      reservedMicroDollars: 0,
                      sequence: 1,
                      credentialVersion: 1,
                      verificationUrl: null,
                      userCode: null,
                      error: null,
                      claimUntil: null,
                      claimToken: null,
                    };
                  }),
              })),
            ),
          ),
        ),
        Layer.provide([
          NodeCrypto.layer,
          Layer.succeed(CloudStore, store),
          Layer.succeed(CloudConfiguration, {
            enabled: true,
            allowedUserId: "user",
            controlUrl: "https://cloud.example.com",
            encryptionKey: btoa("x".repeat(32)),
            machine: { url: "https://machine.example", token: "m".repeat(64), ownerId: "user" },
            github: { appId: "", privateKey: "", installationIds: [] },
            wake: () => Effect.void,
          }),
          Layer.succeed(CloudArtifacts, {
            get: async () => null,
            head: async () => null,
            put: async () => {},
            delete: async () => {},
          }),
          Layer.succeed(ManagedEndpointProvider, {
            provision: () =>
              Effect.succeed({
                endpoint: {
                  httpBaseUrl: "https://cloud.test/",
                  wsBaseUrl: "wss://cloud.test/ws",
                  providerKind: "cloudflare_tunnel" as const,
                },
                runtime: {
                  providerKind: "cloudflare_tunnel" as const,
                  connectorToken: "connector",
                  tunnelId: "tunnel",
                  tunnelName: "tunnel",
                },
              }),
            deprovision: () => Effect.void,
          }),
        ]),
      );
      yield* Effect.gen(function* () {
        const scheduler = yield* CloudScheduler;
        const fiber = yield* Effect.forkChild(scheduler.tick("user"));
        yield* Effect.promise(() => blocked);
        try {
          expect(provisioned).toBe(true);
          expect(doc.state.tasks[id]!.worker!.state).toBe("starting");
          expect(doc.state.accounts.codex.leasedBy).toBe(`${id}-1`);
        } finally {
          unblock();
        }
        yield* Fiber.join(fiber);
        expect(auxiliaryTicks).toBe(1);
        expect(deleted).toEqual([`/v1/attempts/${orphan}`]);
      }).pipe(Effect.provide(services));
    }),
);
it.effect.each([
  {
    label: "expired checkpoint grace",
    running: undefined,
    age: CLOUD_POLICY.shutdownCheckpointMs,
    stopFails: false,
    inspectFails: false,
    stale: false,
    shouldStop: true,
  },
  {
    label: "confirmed exited worker",
    running: false,
    age: 0,
    stopFails: false,
    inspectFails: false,
    stale: false,
    shouldStop: true,
  },
  {
    label: "live worker still checkpointing",
    running: true,
    age: 0,
    stopFails: false,
    inspectFails: false,
    stale: false,
    shouldStop: false,
  },
  {
    label: "older agent without process state",
    running: undefined,
    age: 0,
    stopFails: false,
    inspectFails: false,
    stale: false,
    shouldStop: false,
  },
  {
    label: "failed process inspection",
    running: false,
    age: 0,
    stopFails: false,
    inspectFails: true,
    stale: false,
    shouldStop: false,
  },
  {
    label: "failed final stop confirmation",
    running: false,
    age: 0,
    stopFails: true,
    inspectFails: false,
    stale: false,
    shouldStop: false,
  },
  {
    label: "obsolete attempt operation",
    running: false,
    age: 0,
    stopFails: false,
    inspectFails: false,
    stale: true,
    shouldStop: false,
  },
])(
  "confirms shutdown before releasing the provider lease: $label",
  ({ running, age, stopFails, inspectFails, stale, shouldStop }) =>
    Effect.gen(function* () {
      const now = yield* currentMillis;
      let doc = emptyDocument();
      const id = "00000000-0000-4000-8000-000000000001";
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
      doc.state.accounts.codex.state = "connected";
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
        id,
        "create",
        now,
        true,
      );
      schedule(doc.state, now, true);
      const store = CloudStore.of({
        users: Effect.succeed(["user"]),
        read: () => Effect.sync(() => structuredClone(doc)),
        mutate: (_, reduce) =>
          Effect.try({
            try: () => {
              const next = structuredClone(doc);
              const result = reduce(next);
              doc = next;
              return result;
            },
            catch: () => new CloudError("test", "Test mutation failed"),
          }),
      });
      let wakeups = 0;
      let endpointReady = false,
        endpointReleased = false;
      let exists = false,
        stopped = false;
      vi.stubGlobal("fetch", async (input: string | URL, init: RequestInit) => {
        const url = new URL(String(input));
        expect(url.hostname).toBe("machine.example");
        if (url.pathname === "/v1/attempts")
          return Response.json(exists ? [{ id: `machine-${id}-1`, attemptId: `${id}-1` }] : []);
        if (url.pathname.endsWith("/prepare")) return Response.json({ port: 20000 });
        if (init.method === "PUT") {
          expect(endpointReady).toBe(true);
          exists = true;
          applyCommand(
            doc.state,
            { type: "task.cancel", idempotencyKey: "cancel", taskId: id },
            "cancel",
            "cancel",
            now - age,
            true,
          );
          return Response.json({ id: `machine-${id}-1` });
        }
        if (url.pathname.endsWith("/stop")) {
          expect(doc.state.accounts.codex.leasedBy).toBe(`${id}-1`);
          if (stopFails) return new Response(null, { status: 503 });
          stopped = true;
          return Response.json({ stopped: true });
        }
        if (inspectFails) return new Response(null, { status: 503 });
        return exists
          ? Response.json({ id: `machine-${id}-1`, ...(running === undefined ? {} : { running }) })
          : new Response(null, { status: 404 });
      });
      const services = layer.pipe(
        Layer.provide(auxiliaryLayer),
        Layer.provide([
          NodeCrypto.layer,
          Layer.succeed(CloudStore, store),
          Layer.succeed(CloudConfiguration, {
            enabled: true,
            allowedUserId: "user",
            controlUrl: "https://cloud.example.com",
            encryptionKey: btoa("x".repeat(32)),
            machine: { url: "https://machine.example", token: "a".repeat(64), ownerId: "user" },
            github: { appId: "", privateKey: "", installationIds: [] },
            wake: () =>
              Effect.sync(() => {
                wakeups++;
              }),
          }),
          Layer.succeed(CloudArtifacts, {
            get: async () => null,
            head: async () => null,
            put: async () => {},
            delete: async () => {},
          }),
          Layer.succeed(ManagedEndpointProvider, {
            provision: () =>
              Effect.sync(() => {
                endpointReady = true;
                return {
                  endpoint: {
                    httpBaseUrl: "https://cloud.test/",
                    wsBaseUrl: "wss://cloud.test/ws",
                    providerKind: "cloudflare_tunnel" as const,
                  },
                  runtime: {
                    providerKind: "cloudflare_tunnel" as const,
                    connectorToken: "connector",
                    tunnelId: "tunnel",
                    tunnelName: "tunnel",
                  },
                };
              }),
            deprovision: () =>
              Effect.sync(() => {
                endpointReleased = true;
              }),
          }),
        ]),
      );
      yield* Effect.gen(function* () {
        const scheduler = yield* CloudScheduler;
        yield* scheduler.tick("user");
        expect(doc.state.tasks[id]!.state).toBe("cancelled");
        expect(doc.state.accounts.codex.leasedBy).toBe(`${id}-1`);
        const originalEndpoint = doc.private.endpoints[id]!;
        if (stale) {
          for (const operation of Object.values(doc.state.operations))
            operation.attemptId = `${id}-99`;
        }
        yield* scheduler.tick("user");
        expect(stopped).toBe(shouldStop);
        expect(endpointReleased).toBe(false);
        expect(doc.private.endpoints[id]).toEqual(originalEndpoint);
        if (shouldStop) {
          expect(doc.state.tasks[id]!.worker!.state).toBe("stopped");
          expect(doc.state.accounts.codex.leasedBy).toBeNull();
          expect(wakeups).toBe(1);
        } else {
          expect(doc.state.tasks[id]!.worker!.state).not.toBe("stopped");
          expect(doc.state.accounts.codex.leasedBy).toBe(`${id}-1`);
          expect(wakeups).toBe(0);
        }
      }).pipe(Effect.provide(services));
    }),
);

it.effect(
  "keeps a persistent machine's endpoint across stop and wake, re-pointing it when the port moves",
  () =>
    Effect.gen(function* () {
      const now = yield* currentMillis;
      let doc = emptyDocument();
      const id = "00000000-0000-4000-8000-000000000002";
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
      doc.state.accounts.codex.state = "connected";
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
        id,
        "create",
        now,
        true,
      );
      schedule(doc.state, now, true);
      const store = CloudStore.of({
        users: Effect.succeed(["user"]),
        read: () => Effect.sync(() => structuredClone(doc)),
        mutate: (_, reduce) =>
          Effect.try({
            try: () => {
              const next = structuredClone(doc);
              const result = reduce(next);
              doc = next;
              return result;
            },
            catch: () => new CloudError("test", "Test mutation failed"),
          }),
      });
      const provisioned: number[] = [];
      let deprovisioned = 0;
      let port = 20000;
      let failPreparation = true;
      const workers = new Map<string, { attemptId: string; state: "running" | "stopped" }>();
      vi.stubGlobal("fetch", async (input: string | URL, init: RequestInit) => {
        const url = new URL(String(input));
        expect(url.origin).toBe("https://machine.example");
        const match = /^\/v1\/attempts\/([^/]+)(\/prepare|\/stop)?$/.exec(url.pathname);
        if (url.pathname === "/v1/attempts")
          return Response.json(
            [...workers].map(([wid, worker]) => ({
              id: wid,
              attemptId: worker.attemptId,
              state: worker.state,
            })),
          );
        if (!match) return new Response(null, { status: 404 });
        const attemptId = match[1]!;
        const wid = `machine-${attemptId}`;
        if (match[2] === "/prepare") {
          if (failPreparation) {
            failPreparation = false;
            return new Response(null, { status: 503 });
          }
          return Response.json({ port });
        }
        if (match[2] === "/stop") {
          const worker = workers.get(wid);
          if (worker) worker.state = "stopped";
          return Response.json({});
        }
        if (init.method === "PUT") {
          workers.set(wid, { attemptId, state: "running" });
          return Response.json({ id: wid, attemptId, state: "running" });
        }
        if (init.method === "DELETE") {
          workers.delete(wid);
          return Response.json({});
        }
        const worker = workers.get(wid);
        return worker
          ? Response.json({ id: wid, attemptId, state: worker.state })
          : new Response(null, { status: 404 });
      });
      const services = layer.pipe(
        Layer.provide(auxiliaryLayer),
        Layer.provide([
          NodeCrypto.layer,
          Layer.succeed(CloudStore, store),
          Layer.succeed(CloudConfiguration, {
            enabled: true,
            allowedUserId: "user",
            controlUrl: "https://cloud.example.com",
            encryptionKey: btoa("x".repeat(32)),
            machine: { url: "https://machine.example", token: "m".repeat(64), ownerId: "user" },
            github: { appId: "", privateKey: "", installationIds: [] },
            wake: () => Effect.void,
          }),
          Layer.succeed(CloudArtifacts, {
            get: async () => null,
            head: async () => null,
            put: async () => {},
            delete: async () => {},
            deletePrefix: async () => {},
          }),
          Layer.succeed(ManagedEndpointProvider, {
            provision: (input) =>
              Effect.sync(() => {
                provisioned.push(input.origin.localHttpPort);
                return {
                  endpoint: {
                    httpBaseUrl: "https://cloud.test/",
                    wsBaseUrl: "wss://cloud.test/ws",
                    providerKind: "cloudflare_tunnel" as const,
                  },
                  runtime: {
                    providerKind: "cloudflare_tunnel" as const,
                    connectorToken: "connector",
                    tunnelId: "tunnel",
                    tunnelName: "tunnel",
                  },
                };
              }),
            deprovision: () =>
              Effect.sync(() => {
                deprovisioned++;
              }),
          }),
        ]),
      );
      yield* Effect.gen(function* () {
        const scheduler = yield* CloudScheduler;
        yield* scheduler.tick("user");
        expect(doc.state.tasks[id]!.error).toBe("Machine request failed (503)");
        yield* scheduler.tick("user");
        expect(doc.state.tasks[id]!.error).toBeNull();
        expect(provisioned).toEqual([20000]);
        expect(doc.state.tasks[id]!.worker!.sandboxId).toBe(`machine-${id}-1`);
        const sealed = doc.private.endpoints[id]!;
        // The worker finishes; the settled task is stopped after its grace period.
        const t = doc.state.tasks[id]!;
        t.state = "completed";
        t.worker!.state = "ready";
        t.checkpoint = {
          attemptId: `${id}-1`,
          createdAt: iso(now),
          objectKey: "cloud/user/x",
          sha256: "a".repeat(64),
          sizeBytes: 1,
          bundleSizeBytes: 1,
          diffSizeBytes: 1,
        } as never;
        const stopAt = now + CLOUD_POLICY.settledGraceMs + 1;
        const stopId = `${id}-1-stop`;
        doc.state.operations[stopId] = {
          id: stopId,
          taskId: id,
          attemptId: `${id}-1`,
          kind: "stop",
          createdAt: iso(stopAt - CLOUD_POLICY.shutdownCheckpointMs),
          claimUntil: null,
          claimToken: null,
          failures: 0,
        };
        yield* scheduler.tick("user");
        expect(doc.state.tasks[id]!.worker!.state).toBe("stopped");
        expect(doc.state.accounts.codex.leasedBy).toBeNull();
        // Stopping a persistent machine keeps the hostname, tunnel and DNS record.
        expect(deprovisioned).toBe(0);
        expect(doc.private.endpoints[id]).toEqual(sealed);
        // Reconciliation must not treat the retained endpoint as a leak either.
        yield* scheduler.tick("user");
        expect(deprovisioned).toBe(0);
        expect(doc.private.endpoints[id]).toEqual(sealed);
        // Waking on the same port reuses the endpoint without touching Cloudflare.
        applyCommand(
          doc.state,
          { type: "task.wake", idempotencyKey: "wake-1", taskId: id },
          "wake-1",
          "wake-1",
          stopAt,
          true,
        );
        schedule(doc.state, stopAt, true);
        yield* scheduler.tick("user");
        expect(doc.state.tasks[id]!.worker!.sandboxId).toBe(`machine-${id}-2`);
        expect(provisioned).toEqual([20000]);
        expect(doc.private.endpoints[id]).toEqual(sealed);
        // Deleting the task releases the endpoint.
        applyCommand(
          doc.state,
          { type: "task.delete", idempotencyKey: "delete", taskId: id },
          "delete",
          "delete",
          stopAt,
          true,
        );
        yield* scheduler.tick("user");
        yield* scheduler.tick("user");
        expect(deprovisioned).toBe(1);
        expect(doc.private.endpoints[id]).toBeUndefined();
      }).pipe(Effect.provide(services));
      void port;
    }),
);
