// @effect-diagnostics preferSchemaOverJson:off - Expo's external push response is validated below.
import { OrchestrationThread } from "@t3tools/contracts";
import type { CloudTask } from "@t3tools/contracts/cloud";
import { historicalActivityIds } from "@t3tools/shared/historyActivities";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { FetchHttpClient, HttpClient, HttpClientRequest } from "effect/unstable/http";
import { CloudStore, type CloudAccountDocument } from "./store.ts";
import { CloudConfiguration } from "./config.ts";
import { CredentialVault, sha256, type SealedCredential } from "./crypto.ts";
import { currentMillis, fromPromise } from "./service.ts";
import { CloudError } from "./policy.ts";

const decodeThread = Schema.decodeUnknownOption(OrchestrationThread);

export interface CloudMobileDevice {
  platform: "ios" | "android";
  token: SealedCredential;
  tokenHash: string;
  updatedAt: number;
}
export interface CloudPushDelivery {
  deviceId: string;
  tokenHash: string;
  ticket?: string;
  state: "queued" | "ticket" | "done" | "failed";
  attempts: number;
  nextAt: number;
  claim?: string;
  claimUntil?: number;
  error?: string;
}
export interface CloudPushEvent {
  id: string;
  taskId: string;
  kind: "input" | "completed" | "failed";
  createdAt: number;
  deliveries: CloudPushDelivery[];
}

export function enqueueCloudNotification(
  document: CloudAccountDocument,
  task: CloudTask,
  kind: CloudPushEvent["kind"],
  identity: string,
  now: number,
) {
  const events = (document.private.pushEvents ??= {});
  const id = `${task.id}:${kind}:${identity}`;
  if (events[id]) return;
  events[id] = {
    id,
    taskId: task.id,
    kind,
    createdAt: now,
    deliveries: Object.entries(document.private.mobileDevices ?? {}).map(([deviceId, device]) => ({
      deviceId,
      tokenHash: device.tokenHash,
      state: "queued",
      attempts: 0,
      nextAt: now,
    })),
  };
  // Keep completed deduplication markers for the retention window. Old mirrored
  // activity is ignored by enqueueConversationNotifications after that window.
  for (const [key, event] of Object.entries(events))
    if (event.createdAt < now - 7 * 86400_000) delete events[key];
}
export function enqueueConversationNotifications(
  document: CloudAccountDocument,
  task: CloudTask,
  conversation: unknown,
  now: number,
) {
  const decoded = decodeThread(conversation);
  if (decoded._tag === "None") return;
  const thread = decoded.value;
  const history = historicalActivityIds(thread.activities);
  const pending = new Map<string, string>();
  for (const activity of thread.activities) {
    if (history.has(activity.id) || !activity.payload || typeof activity.payload !== "object")
      continue;
    const requestId = "requestId" in activity.payload ? activity.payload.requestId : null;
    if (typeof requestId !== "string") continue;
    if (
      ["approval.requested", "user-input.requested"].includes(activity.kind) &&
      now - Date.parse(activity.createdAt) < 86400_000
    )
      pending.set(requestId, activity.createdAt);
    else if (["approval.resolved", "user-input.resolved"].includes(activity.kind))
      pending.delete(requestId);
  }
  for (const request of pending.keys())
    enqueueCloudNotification(document, task, "input", request, now);
  const turn = thread.latestTurn;
  if (turn?.completedAt && now - Date.parse(turn.completedAt) < 86400_000)
    enqueueCloudNotification(
      document,
      task,
      turn.state === "error" ? "failed" : "completed",
      task.turnRequestId ?? task.attempt?.id ?? turn.turnId,
      now,
    );
}
interface ExpoStatus {
  status: "ok" | "error";
  id?: string;
  details?: { error?: string };
}
function expoStatus(value: unknown): ExpoStatus | null {
  if (
    !value ||
    typeof value !== "object" ||
    !("status" in value) ||
    !["ok", "error"].includes(String(value.status))
  )
    return null;
  return value as ExpoStatus;
}

/** Account CAS claims + durable tickets recover sends/receipts across worker restarts. */
export const deliverCloudNotifications = Effect.fn("cloud.push.deliver")(function* (
  userId: string,
  claim: string,
) {
  const store = yield* CloudStore;
  const config = yield* CloudConfiguration;
  const now = yield* currentMillis;
  const selected = yield* store.mutate(userId, (doc) => {
    const deliveries: {
      event: CloudPushEvent;
      delivery: CloudPushDelivery;
      device: CloudMobileDevice;
    }[] = [];
    for (const event of Object.values(doc.private.pushEvents ?? {}))
      for (const delivery of event.deliveries) {
        if (
          !["queued", "ticket"].includes(delivery.state) ||
          delivery.nextAt > now ||
          (delivery.claimUntil ?? 0) > now
        )
          continue;
        const device = doc.private.mobileDevices?.[delivery.deviceId];
        if (
          !device ||
          device.tokenHash !== delivery.tokenHash ||
          doc.state.deletedTasks.includes(event.taskId) ||
          now - event.createdAt > 86400_000 ||
          delivery.attempts >= 12
        ) {
          delivery.state = "failed";
          continue;
        }
        delivery.claim = claim;
        delivery.claimUntil = now + 60_000;
        deliveries.push(structuredClone({ event, delivery, device }));
        // Two requests run concurrently; neither claim waits behind another batch.
        if (deliveries.length === 2) return deliveries;
      }
    return deliveries;
  });
  const vault = new CredentialVault(config.encryptionKey);
  yield* Effect.forEach(
    selected,
    ({ event, delivery, device }) =>
      Effect.gen(function* () {
        const outcome = yield* Effect.gen(function* () {
          const token = yield* fromPromise(() =>
            vault.open(device.token, `${userId}:mobile:${delivery.deviceId}`),
          );
          const collapseId = yield* fromPromise(() => sha256(event.id));
          const payload = delivery.ticket
            ? { ids: [delivery.ticket] }
            : {
                to: token,
                title: "Vitre",
                body:
                  event.kind === "input"
                    ? "A cloud conversation needs your input."
                    : event.kind === "completed"
                      ? "Your cloud conversation is ready to review."
                      : "A cloud conversation needs attention.",
                sound: "default",
                channelId: "conversations",
                data: {
                  version: 2,
                  accountId: userId,
                  taskId: event.taskId,
                  eventId: event.id,
                  url: `vitre://conversations/${event.taskId}`,
                },
                collapseId,
                ttl: 86400,
              };
          const response = yield* HttpClientRequest.post(
            `https://exp.host/--/api/v2/push/${delivery.ticket ? "getReceipts" : "send"}`,
          ).pipe(HttpClientRequest.bodyJson(payload), Effect.flatMap(HttpClient.execute));
          if (response.status < 200 || response.status >= 300)
            return yield* Effect.fail(
              new CloudError(
                "push_unavailable",
                "Push delivery is temporarily unavailable",
                response.status >= 500 || response.status === 429 ? 503 : 400,
              ),
            );
          const json = (yield* response.json) as { data?: unknown };
          return expoStatus(
            delivery.ticket && json.data && typeof json.data === "object"
              ? (json.data as Record<string, unknown>)[delivery.ticket]
              : json.data,
          );
        }).pipe(
          Effect.timeout("15 seconds"),
          Effect.provide(FetchHttpClient.layer),
          Effect.mapError((error) =>
            error instanceof CloudError
              ? error
              : new CloudError("push_unavailable", "Push delivery is temporarily unavailable", 503),
          ),
          Effect.result,
        );
        yield* store.mutate(userId, (doc) => {
          const current = doc.private.pushEvents?.[event.id]?.deliveries.find(
            (entry) =>
              entry.deviceId === delivery.deviceId && entry.tokenHash === delivery.tokenHash,
          );
          if (!current || current.claim !== claim) return;
          delete current.claim;
          delete current.claimUntil;
          current.attempts++;
          current.nextAt = now + Math.min(3600_000, 30_000 * 2 ** current.attempts);
          if (outcome._tag === "Failure") {
            if (outcome.failure.status === 400) current.state = "failed";
            return;
          }
          const status = outcome.success;
          if (status?.status === "ok") {
            if (delivery.ticket) current.state = "done";
            else if (typeof status.id === "string") {
              current.ticket = status.id;
              current.state = "ticket";
              current.nextAt = now + 15 * 60_000;
              current.attempts = 0;
            }
          } else if (status?.status === "error") {
            current.error = status.details?.error ?? "Push rejected";
            if (current.error === "DeviceNotRegistered") {
              current.state = "failed";
              if (doc.private.mobileDevices?.[delivery.deviceId]?.tokenHash === delivery.tokenHash)
                delete doc.private.mobileDevices[delivery.deviceId];
            } else if (
              ["MessageTooBig", "InvalidCredentials", "MismatchSenderId"].includes(
                current.error ?? "",
              )
            )
              current.state = "failed";
            else {
              delete current.ticket;
              current.state = "queued";
            }
          }
        });
      }),
    { concurrency: 2, discard: true },
  );
});
