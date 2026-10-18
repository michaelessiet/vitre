import { afterEach, describe, expect, it, vi } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { FetchHttpClient } from "effect/unstable/http";
import { emptyDocument, CloudStore } from "./store.ts";
import { CloudConfiguration } from "./config.ts";
import { CredentialVault, sha256 } from "./crypto.ts";
import { deliverCloudNotifications, enqueueCloudNotification } from "./notifications.ts";
import { applyCommand } from "./state.ts";

afterEach(() => vi.unstubAllGlobals());
function fixture() {
  const doc = emptyDocument();
  doc.state.accounts.codex.state = "connected";
  applyCommand(
    doc.state,
    {
      type: "task.create",
      idempotencyKey: "source",
      repositoryId: "local",
      source: {
        kind: "local",
        name: "Private project",
        snapshot: { id: "a".repeat(64), sha256: "a".repeat(64) },
      },
      baseBranch: "main",
      provider: "codex",
      prompt: "Private prompt",
      kind: "build",
      issueNumber: null,
    },
    "task",
    "fingerprint",
    0,
    true,
  );
  const config = {
    enabled: true,
    allowedUserId: "user",
    controlUrl: "https://cloud.example",
    encryptionKey: btoa("x".repeat(32)),
    github: { appId: "", privateKey: "", installationIds: [] },
    wake: () => Effect.void,
  };
  const store = CloudStore.of({
    read: () => Effect.succeed(structuredClone(doc)),
    mutate: (_, reduce) => Effect.sync(() => reduce(doc)),
    users: Effect.succeed(["user"]),
  });
  const run = (claim: string) =>
    deliverCloudNotifications("user", claim).pipe(
      Effect.provideService(CloudStore, store),
      Effect.provideService(CloudConfiguration, config),
      Effect.provideService(FetchHttpClient.Fetch, globalThis.fetch),
    );
  return { doc, config, run };
}
describe("cloud mobile push outbox", () => {
  it.effect(
    "deduplicates completion, persists a ticket and disables an invalid device only after its receipt",
    () =>
      Effect.gen(function* () {
        const f = fixture();
        const token = "ExpoPushToken[test-device]";
        f.doc.private.mobileDevices = {
          device: {
            platform: "android",
            token: yield* Effect.promise(() =>
              new CredentialVault(f.config.encryptionKey).seal(token, "user:mobile:device"),
            ),
            tokenHash: yield* Effect.promise(() => sha256(token)),
            updatedAt: 0,
          },
        };
        enqueueCloudNotification(f.doc, f.doc.state.tasks.task!, "completed", "turn", 0);
        enqueueCloudNotification(f.doc, f.doc.state.tasks.task!, "completed", "turn", 0);
        let sends = 0;
        vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
          const request = new Request(input, init);
          const body = (await request.json()) as Record<string, unknown>;
          if (request.url.endsWith("getReceipts"))
            return Response.json({
              data: { ticket: { status: "error", details: { error: "DeviceNotRegistered" } } },
            });
          sends++;
          expect(body.body).not.toContain("Private");
          expect(body.data).toMatchObject({ accountId: "user", taskId: "task" });
          expect(body.collapseId).toHaveLength(64);
          return Response.json({ data: { status: "ok", id: "ticket" } });
        });
        yield* f.run("one");
        const delivery = Object.values(f.doc.private.pushEvents!)[0]!.deliveries[0]!;
        expect(delivery.state).toBe("ticket");
        yield* f.run("two");
        expect(sends).toBe(1);
        delivery.nextAt = 0;
        yield* f.run("three");
        expect(delivery.state).toBe("failed");
        expect(f.doc.private.mobileDevices.device).toBeUndefined();
      }),
  );
  it.effect("retries temporary delivery failures, and skips stale token registrations", () =>
    Effect.gen(function* () {
      const f = fixture();
      f.doc.private.mobileDevices = {
        device: {
          platform: "ios",
          token: yield* Effect.promise(() =>
            new CredentialVault(f.config.encryptionKey).seal(
              "ExpoPushToken[test]",
              "user:mobile:device",
            ),
          ),
          tokenHash: "hash",
          updatedAt: 0,
        },
      };
      enqueueCloudNotification(f.doc, f.doc.state.tasks.task!, "input", "request", 0);
      vi.stubGlobal("fetch", async () => new Response(null, { status: 503 }));
      yield* f.run("one");
      const delivery = Object.values(f.doc.private.pushEvents!)[0]!.deliveries[0]!;
      expect(delivery.state).toBe("queued");
      expect(delivery.attempts).toBe(1);
      delivery.nextAt = 0;
      f.doc.private.mobileDevices.device!.tokenHash = "rotated";
      yield* f.run("two");
      expect(delivery.state).toBe("failed");
      expect(f.doc.private.mobileDevices.device!.tokenHash).toBe("rotated");
    }),
  );
});
