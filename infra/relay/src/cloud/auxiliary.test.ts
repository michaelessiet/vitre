import { afterEach, it, expect, vi } from "@effect/vitest";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import { CloudAuxiliary, layer } from "./auxiliary.ts";
import { CloudConfiguration } from "./config.ts";
import { CloudStore, emptyDocument } from "./store.ts";
import { CloudArtifacts } from "./artifacts.ts";
import { CloudError } from "./policy.ts";
import { CredentialVault, sha256 } from "./crypto.ts";
import { reserveJob } from "./jobs.ts";
import { currentMillis } from "./service.ts";
import { applyLensCommand } from "./lens.ts";
const encodeJson = Schema.encodeSync(Schema.UnknownFromJsonString);

afterEach(() => vi.unstubAllGlobals());

it.effect(
  "Lens bootstrap and callbacks are credential-fenced and failed replies cannot become reviews",
  () =>
    Effect.gen(function* () {
      const now = yield* currentMillis;
      let document = emptyDocument();
      const encryptionKey = btoa("x".repeat(32));
      const credential = encodeJson({ tokens: { refresh_token: "lens-subscription-secret" } });
      document.state.accounts.codex.state = "connected";
      document.state.accounts.codex.credentialVersion = 1;
      document.private.credentials.codex = {
        version: 1,
        sealed: yield* Effect.promise(() =>
          new CredentialVault(encryptionKey).seal(credential, "user:codex:1"),
        ),
      };
      const id = "lens-callback-test";
      applyLensCommand(
        document.state,
        { type: "sweep", idempotencyKey: "review" },
        now,
        id,
        true,
        "fingerprint",
      );
      const token = "private-lens-worker-token";
      document.private.workerTokens[id] = {
        hash: yield* Effect.promise(() => sha256(token)),
        sealed: yield* Effect.promise(() =>
          new CredentialVault(encryptionKey).seal(token, `user:job:${id}`),
        ),
      };
      const runtime = layer.pipe(
        Layer.provide([
          NodeCrypto.layer,
          Layer.succeed(CloudStore, {
            read: () => Effect.sync(() => structuredClone(document)),
            users: Effect.succeed(["user"]),
            mutate: (_, reduce) =>
              Effect.try({
                try: () => {
                  const next = structuredClone(document);
                  const result = reduce(next);
                  document = next;
                  return result;
                },
                catch: (error) =>
                  error instanceof CloudError ? error : new CloudError("test", "Test failed"),
              }),
          }),
          Layer.succeed(CloudConfiguration, {
            enabled: true,
            allowedUserId: "user",
            controlUrl: "https://example.test",
            encryptionKey,
            github: { appId: "", privateKey: "", installationIds: [] },
            wake: () => Effect.void,
          }),
          Layer.succeed(CloudArtifacts, {
            get: async () => null,
            head: async () => null,
            put: async () => {},
            delete: async () => {},
          }),
        ]),
      );
      yield* Effect.gen(function* () {
        const service = yield* CloudAuxiliary;
        expect((yield* Effect.flip(service.bootstrap(id, "invalid"))).status).toBe(401);
        const input = yield* service.bootstrap(id, token);
        expect(input.kind).toBe("lens");
        expect("credential" in input && input.credential).toBe(credential);
        expect(encodeJson(document)).not.toContain("lens-subscription-secret");
        expect(
          (yield* Effect.flip(service.callback(id, token, { sequence: 1, phase: "code" }))).code,
        ).toBe("invalid_reply");
        document.state.accounts.codex.credentialVersion++;
        expect((yield* Effect.flip(service.bootstrap(id, token))).code).toBe("stale_worker");
        expect(
          (yield* Effect.flip(service.callback(id, token, { sequence: 1, phase: "failed" }))).code,
        ).toBe("stale_worker");
        document.state.accounts.codex.credentialVersion--;
        yield* service.callback(id, token, {
          sequence: 1,
          phase: "failed",
          reply: { text: "Must not appear", recommendations: [] },
        });
        expect(document.state.lens!.messages).toHaveLength(0);
        expect(document.state.lens!.run).toBeNull();
        expect(document.state.lens!.error).toBeTruthy();
        expect(document.state.accounts.codex.leasedBy).toBe(id);
      }).pipe(Effect.provide(runtime));
    }),
);

it.effect("wakes task scheduling only after auxiliary absence releases its provider lease", () =>
  Effect.gen(function* () {
    const now = yield* currentMillis;
    let document = emptyDocument();
    const id = "login-00000000-0000-4000-8000-000000000006";
    reserveJob(document.state, id, "login", now).state = "completed";
    let exists = true;
    let wakeups = 0;
    vi.stubGlobal("fetch", async (input: string | URL, init: RequestInit) => {
      expect(new URL(String(input)).pathname).toBe(`/v1/attempts/${id}`);
      if (init.method === "DELETE") {
        exists = false;
        return Response.json({});
      }
      return exists ? Response.json({ id: `machine-${id}` }) : new Response(null, { status: 404 });
    });
    const services = layer.pipe(
      Layer.provide([
        NodeCrypto.layer,
        Layer.succeed(CloudStore, {
          users: Effect.succeed(["user"]),
          read: () => Effect.sync(() => structuredClone(document)),
          mutate: (_, reduce) =>
            Effect.sync(() => {
              const next = structuredClone(document);
              const result = reduce(next);
              document = next;
              return result;
            }),
        }),
        Layer.succeed(CloudConfiguration, {
          enabled: true,
          allowedUserId: "user",
          controlUrl: "https://cloud.example.com",
          encryptionKey: btoa("x".repeat(32)),
          machine: { url: "https://machine.example", token: "m".repeat(64), ownerId: "user" },
          github: { appId: "", privateKey: "", installationIds: [] },
          wake: () =>
            Effect.sync(() => {
              expect(document.state.jobs![id]!.deleted).toBe(true);
              expect(document.state.accounts.codex.leasedBy).toBeNull();
              wakeups++;
            }),
        }),
        Layer.succeed(CloudArtifacts, {
          get: async () => null,
          head: async () => null,
          put: async () => {},
          delete: async () => {},
        }),
      ]),
    );
    yield* Effect.gen(function* () {
      const auxiliary = yield* CloudAuxiliary;
      yield* auxiliary.tick("user");
      expect(exists).toBe(false);
      expect(document.state.accounts.codex.leasedBy).toBe(id);
      expect(wakeups).toBe(0);
      yield* auxiliary.tick("user");
      expect(document.state.accounts.codex.leasedBy).toBeNull();
      expect(wakeups).toBe(1);
      yield* auxiliary.tick("user");
      expect(wakeups).toBe(1);
    }).pipe(Effect.provide(services));
  }),
);

it.effect("disabled deployments boot without cloud credentials", () => {
  const services = layer.pipe(
    Layer.provide([
      NodeCrypto.layer,
      Layer.succeed(CloudStore, {
        read: () => Effect.succeed(emptyDocument()),
        users: Effect.succeed([]),
        mutate: (_, reduce) => Effect.sync(() => reduce(emptyDocument())),
      }),
      Layer.succeed(CloudConfiguration, {
        enabled: false,
        allowedUserId: "user",
        controlUrl: "https://example.test",
        encryptionKey: "",
        github: { appId: "", privateKey: "", installationIds: [] },
        wake: () => Effect.void,
      }),
      Layer.succeed(CloudArtifacts, {
        get: async () => null,
        head: async () => null,
        put: async () => {},
        delete: async () => {},
      }),
    ]),
  );
  return Effect.gen(function* () {
    const service = yield* CloudAuxiliary;
    expect((yield* Effect.flip(service.login("user", "disabled"))).code).toBe("disabled");
  }).pipe(Effect.provide(services));
});

it.effect("login redelivery, stale callbacks, encrypted credentials and exclusive lease", () =>
  Effect.gen(function* () {
    let document = emptyDocument();
    const encryptionKey = btoa("x".repeat(32));
    const store = CloudStore.of({
      read: () => Effect.sync(() => structuredClone(document)),
      users: Effect.succeed(["user"]),
      mutate: (_, reduce) =>
        Effect.try({
          try: () => {
            const next = structuredClone(document);
            const result = reduce(next);
            document = next;
            return result;
          },
          catch: (error) =>
            error instanceof CloudError ? error : new CloudError("test", "Test failed"),
        }),
    });
    const runtime = layer.pipe(
      Layer.provide([
        NodeCrypto.layer,
        Layer.succeed(CloudStore, store),
        Layer.succeed(CloudConfiguration, {
          enabled: true,
          allowedUserId: "user",
          controlUrl: "https://example.test",
          encryptionKey,
          github: { appId: "", privateKey: "", installationIds: [] },
          wake: () => Effect.void,
        }),
        Layer.succeed(CloudArtifacts, {
          get: async () => null,
          head: async () => null,
          put: async () => {},
          delete: async () => {},
        }),
      ]),
    );
    yield* Effect.gen(function* () {
      const service = yield* CloudAuxiliary;
      const first = yield* service.login("user", "login-key");
      expect((yield* service.login("user", "login-key")).id).toBe(first.id);
      expect((yield* Effect.flip(service.login("other", "other-key"))).status).toBe(403);
      const token = "private-worker-token";
      document.private.workerTokens[first.id] = {
        hash: yield* Effect.promise(() => sha256(token)),
        sealed: yield* Effect.promise(() =>
          new CredentialVault(encryptionKey).seal(token, `user:job:${first.id}`),
        ),
      };
      expect((yield* Effect.flip(service.bootstrap(first.id, "bad"))).status).toBe(401);
      yield* service.callback(first.id, token, {
        sequence: 1,
        phase: "code",
        verificationUrl: "https://auth.openai.com/codex/device",
        userCode: "ABCD-EFGH",
      });
      const credential = encodeJson({ tokens: { refresh_token: "subscription-secret" } });
      yield* service.callback(first.id, token, { sequence: 2, phase: "completed", credential });
      expect(document.state.accounts.codex.state).toBe("connected");
      expect(document.state.accounts.codex.leasedBy).toBe(first.id);
      expect(encodeJson(document)).not.toContain("subscription-secret");
      yield* service.callback(first.id, token, { sequence: 2, phase: "completed", credential });
      expect(document.state.accounts.codex.credentialVersion).toBe(1);
      expect(
        (yield* Effect.flip(
          service.callback(first.id, token, { sequence: 3, phase: "completed", credential }),
        )).code,
      ).toBe("stale_worker");
    }).pipe(Effect.provide(runtime));
  }),
);
