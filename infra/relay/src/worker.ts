import { githubAccountPage } from "./cloud/githubAccountPage.ts";
import { createGitHubAccounts } from "./cloud/githubAccounts.ts";
import * as Alchemy from "alchemy";
import * as Cloudflare from "alchemy/Cloudflare";
import * as Config from "effect/Config";
import * as DateTime from "effect/DateTime";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as Stream from "effect/Stream";
import * as Etag from "effect/unstable/http/Etag";
import * as HttpPlatform from "effect/unstable/http/HttpPlatform";
import * as HttpRouter from "effect/unstable/http/HttpRouter";
import * as HttpEffect from "effect/unstable/http/HttpEffect";
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
import * as HttpServerRequest from "effect/unstable/http/HttpServerRequest";
import * as HttpApiBuilder from "effect/unstable/httpapi/HttpApiBuilder";
import { documentationLayer } from "./http/documentation.ts";
import { requestRouteFamily } from "./http/requestRouting.ts";

import { RelayApi } from "@t3tools/contracts/relay";

import {
  clientApi,
  dpopClientApi,
  healthApi,
  metadataApi,
  mobileApi,
  relayClientAuthLayer,
  relayDpopClientAuthLayer,
  relayCors,
  relayDocsRedirectRoute,
  relayEnvironmentAuthLayer,
  relayNotFoundRoute,
  serverApi,
  traceRelayHttpRequestWith,
  tokenApi,
  withoutCapturedParentSpan,
} from "./http/Api.ts";
import { ManagedEndpointZone, RelayApiZone, RelayDeploymentConfig } from "./zone.ts";
import { makeRelayTraceLayer, RelayObservability } from "./observability.ts";
import * as DeliveryAttempts from "./agentActivity/DeliveryAttempts.ts";
import * as AgentActivityRows from "./agentActivity/AgentActivityRows.ts";
import * as Devices from "./agentActivity/Devices.ts";
import * as DpopProofs from "./auth/DpopProofs.ts";
import * as RelayTokens from "./auth/RelayTokens.ts";
import * as EnvironmentCredentials from "./environments/EnvironmentCredentials.ts";
import * as EnvironmentLinks from "./environments/EnvironmentLinks.ts";
import * as ManagedEndpointAllocations from "./environments/ManagedEndpointAllocations.ts";
import * as LiveActivities from "./agentActivity/LiveActivities.ts";
import * as RelayDb from "./db.ts";
import { requestPostgres } from "./postgres.ts";
import { RelayApnsDeliveryDeadLetterQueue, RelayApnsDeliveryQueue } from "./queues.ts";
import * as RelayConfiguration from "./Config.ts";
import * as AgentActivityPublisher from "./agentActivity/AgentActivityPublisher.ts";
import * as ApnsClient from "./agentActivity/ApnsClient.ts";
import * as ApnsProviderTokens from "./agentActivity/ApnsProviderTokens.ts";
import * as ApnsDeliveryQueue from "./agentActivity/ApnsDeliveryQueue.ts";
import * as ApnsDeliveries from "./agentActivity/ApnsDeliveries.ts";
import * as EnvironmentConnector from "./environments/EnvironmentConnector.ts";
import * as EnvironmentLinker from "./environments/EnvironmentLinker.ts";
import * as EnvironmentPublishSignatures from "./environments/EnvironmentPublishSignatures.ts";
import * as ManagedEndpointProvider from "./environments/ManagedEndpointProvider.ts";
import * as ManagedTunnelLimits from "./environments/ManagedTunnelLimits.ts";
import * as MobileRegistrations from "./agentActivity/MobileRegistrations.ts";
import { CloudApi, cloudApiLayer, cloudWorkerApiLayer } from "./cloud/api.ts";
import { CloudConfiguration } from "./cloud/config.ts";
import { CloudError } from "./cloud/policy.ts";
import * as CloudStore from "./cloud/store.ts";
import * as CloudService from "./cloud/service.ts";
import * as CloudScheduler from "./cloud/scheduler.ts";
import {
  beginReconciliation,
  needsFrequentReconciliation,
  wakeReconciliation,
} from "./cloud/reconciliation.ts";
import * as CloudAuxiliary from "./cloud/auxiliary.ts";
import { VitreCloudQueue } from "./queues.ts";
import { CloudArtifacts } from "./cloud/artifacts.ts";
import * as CloudWorkerControl from "./cloud/workerControl.ts";

const webcryptoLayer = Layer.succeed(
  Crypto.Crypto,
  Crypto.make({
    randomBytes: (size) => globalThis.crypto.getRandomValues(new Uint8Array(size)),
    digest: (algorithm, data) =>
      Effect.promise(async () => {
        const input = new Uint8Array(data.length);
        input.set(data);
        return new Uint8Array(await globalThis.crypto.subtle.digest(algorithm, input.buffer));
      }),
  }),
);

const httpPlatformNotSupportedLayer = Layer.succeed(HttpPlatform.HttpPlatform, {
  fileResponse: () => Effect.die("Relay API does not serve filesystem responses"),
  fileWebResponse: () => Effect.die("Relay API does not serve file responses"),
});

const relayApiLayer = Layer.mergeAll(
  healthApi,
  metadataApi,
  mobileApi,
  clientApi,
  tokenApi,
  dpopClientApi,
  serverApi,
);

const CloudMintKeyPair = Alchemy.KeyPair("CloudMintKeyPair");
const CloudArtifactBucket = Cloudflare.R2Bucket("VitreCloudArtifacts", {
  lifecycleRules: [
    {
      id: "expire-cloud-results",
      deleteObjectsTransition: {
        condition: { type: "Age", maxAge: 30 * 24 * 60 * 60 },
      },
    },
  ],
});
const ApnsDeliveryJobSigningSecret = Alchemy.makeRandom("ApnsDeliveryJobSigningSecret", {
  bytes: 32,
});

export default class Api extends Cloudflare.Worker<Api>()(
  "Api",
  RelayDeploymentConfig.pipe(
    Effect.map(({ relayPublicDomain }) => ({
      main: import.meta.filename,
      compatibility: {
        date: "2026-05-22",
        flags: ["nodejs_compat"],
      },
      domain: relayPublicDomain,
    })),
    Effect.orDie,
  ),
  Effect.gen(function* () {
    //
    // 1. Provision Infrastructure for the Worker to use
    //
    const { relayPublicOrigin, stage, personalDeployment } = yield* RelayDeploymentConfig;
    const httpTracingEnabled = yield* Config.boolean("RELAY_HTTP_TRACING_ENABLED").pipe(
      Config.withDefault(!personalDeployment),
    );
    const mobileEnabled = yield* Config.boolean("RELAY_MOBILE_ENABLED").pipe(
      Config.withDefault(!personalDeployment),
    );
    const apnsDeliveryQueue = mobileEnabled ? yield* RelayApnsDeliveryQueue : undefined;
    const apnsDeliveryDeadLetterQueue = mobileEnabled
      ? yield* RelayApnsDeliveryDeadLetterQueue
      : undefined;
    const cloudMintKeyPair = yield* CloudMintKeyPair;
    const relayApiZone = yield* RelayApiZone;
    const managedEndpointZone = yield* ManagedEndpointZone;
    const randomApnsDeliveryJobSigningSecret = mobileEnabled
      ? yield* ApnsDeliveryJobSigningSecret
      : undefined;
    const observability = yield* RelayObservability;

    //
    // 2. Create bindings
    //
    const environment = mobileEnabled
      ? yield* Config.schema(RelayConfiguration.ApnsEnvironment, "APNS_ENVIRONMENT")
      : "sandbox";
    const apnsTeamId = mobileEnabled ? yield* Config.string("APNS_TEAM_ID") : "";
    const apnsKeyId = mobileEnabled ? yield* Config.string("APNS_KEY_ID") : "";
    const apnsBundleId = mobileEnabled ? yield* Config.string("APNS_BUNDLE_ID") : "";
    const apnsPrivateKey = mobileEnabled
      ? yield* Config.redacted("APNS_PRIVATE_KEY")
      : Redacted.make("");
    const apnsDeliveryJobSigningSecret = randomApnsDeliveryJobSigningSecret
      ? yield* randomApnsDeliveryJobSigningSecret
      : Effect.succeed(Redacted.make(""));
    const apnsDeliveryQueueSender = apnsDeliveryQueue
      ? yield* Cloudflare.QueueBinding.bind(apnsDeliveryQueue)
      : undefined;
    const cloudQueue = yield* VitreCloudQueue;
    const cloudQueueSender = yield* Cloudflare.QueueBinding.bind(cloudQueue);
    const cloudBucket = yield* Cloudflare.R2BucketBinding.bind(yield* CloudArtifactBucket);
    const cloudEnabled = yield* Config.boolean("VITRE_CLOUD_ENABLED").pipe(
      Config.withDefault(false),
    );
    const cloudAllowedUserId = yield* Config.string("VITRE_CLOUD_ALLOWED_USER_ID").pipe(
      Config.withDefault(""),
    );
    const machineUrl = yield* Config.string("VITRE_CLOUD_MACHINE_URL").pipe(Config.withDefault(""));
    const machineToken = yield* Config.redacted("VITRE_CLOUD_MACHINE_TOKEN").pipe(
      Config.withDefault(Redacted.make("")),
    );
    const cloudEncryptionKey = yield* Config.redacted("VITRE_CLOUD_ENCRYPTION_KEY").pipe(
      Config.withDefault(Redacted.make("")),
    );
    const githubAppId = yield* Config.string("VITRE_GITHUB_APP_ID").pipe(Config.withDefault(""));
    const githubPrivateKey = yield* Config.redacted("VITRE_GITHUB_PRIVATE_KEY").pipe(
      Config.withDefault(Redacted.make("")),
    );
    const githubInstallationIds = yield* Config.string("VITRE_GITHUB_INSTALLATION_IDS").pipe(
      Config.withDefault(""),
    );

    const axiomDatasetName = yield* observability.traces.name;
    const axiomIngestToken = yield* observability.workerIngestToken.token;
    const axiomTracesEndpoint = yield* observability.traces.otelTracesEndpoint;

    const clerkSecretKey = yield* Config.redacted("CLERK_SECRET_KEY");
    const clerkPublishableKey = yield* Config.string("CLERK_PUBLISHABLE_KEY");
    const clerkJwtAudience = yield* Config.string("CLERK_JWT_AUDIENCE");

    const cloudMintPrivateKey = yield* cloudMintKeyPair.privateKey;
    const cloudMintPublicKey = yield* cloudMintKeyPair.publicKey;
    const hyperdrive = yield* Cloudflare.Hyperdrive.bind(yield* RelayDb.RelayHyperdrive);
    const db = yield* requestPostgres(hyperdrive.connectionString);

    const managedEndpointTunnelBinding = yield* Cloudflare.TunnelReadWrite.bind();
    // Keep Worker custom-domain reconciliation ordered after API zone provisioning.
    yield* yield* relayApiZone.zoneId;
    const managedEndpointDnsBinding = yield* Cloudflare.DnsReadWrite.bind(managedEndpointZone);
    const managedEndpointZoneName = yield* managedEndpointZone.name;

    //
    // 3. Runtime layers and app construction
    //
    const alchemyRuntimeContext = yield* Alchemy.RuntimeContext;

    const loadSettings = Effect.gen(function* () {
      return RelayConfiguration.RelayConfiguration.of({
        relayIssuer: relayPublicOrigin,
        apns: {
          environment,
          teamId: apnsTeamId,
          keyId: apnsKeyId,
          bundleId: apnsBundleId,
          privateKey: apnsPrivateKey,
        },
        apnsDeliveryJobSigningSecret: yield* apnsDeliveryJobSigningSecret,
        clerkSecretKey,
        clerkPublishableKey,
        clerkJwtAudience,
        cloudMintPrivateKey: yield* cloudMintPrivateKey,
        cloudMintPublicKey: yield* cloudMintPublicKey,
        managedEndpointBaseDomain: yield* managedEndpointZoneName,
        managedEndpointNamespace: stage,
      });
    });

    const relayTraceLayer = Layer.unwrap(
      Effect.all({
        tracesDatasetName: axiomDatasetName,
        tracesEndpoint: axiomTracesEndpoint,
        ingestToken: axiomIngestToken,
      }).pipe(Effect.map(makeRelayTraceLayer)),
    );

    const runtimeLayer = Layer.empty
      .pipe(
        Layer.provideMerge(CloudWorkerControl.layer),
        Layer.provideMerge(CloudScheduler.layer),
        Layer.provideMerge(CloudAuxiliary.layer),
        Layer.provideMerge(CloudService.layer),
        Layer.provideMerge(CloudStore.layer),
        Layer.provideMerge(
          Layer.effect(
            CloudArtifacts,
            Effect.gen(function* () {
              const bucket = yield* cloudBucket.raw;
              return CloudArtifacts.of({
                put: async (key, bytes, metadata) => {
                  await bucket.put(key, bytes.buffer, { customMetadata: metadata });
                },
                get: async (key) => {
                  const object = await bucket.get(key);
                  return object ? new Uint8Array(await object.arrayBuffer()) : null;
                },
                head: async (key) => {
                  const object = await bucket.head(key);
                  return object
                    ? { size: object.size, metadata: object.customMetadata ?? {} }
                    : null;
                },
                delete: async (keys) => {
                  await bucket.delete(keys);
                },
                deletePrefix: async (prefix) => {
                  // Re-list from the beginning as deletion changes the key set.
                  for (;;) {
                    const page = await bucket.list({ prefix, limit: 1000 });
                    if (!page.objects.length) break;
                    await bucket.delete(page.objects.map((object) => object.key));
                  }
                },
              });
            }).pipe(Effect.provideService(Alchemy.RuntimeContext, alchemyRuntimeContext)),
          ),
        ),
        Layer.provideMerge(
          Layer.succeed(CloudConfiguration, {
            enabled: cloudEnabled,
            allowedUserId: cloudAllowedUserId,
            controlUrl: relayPublicOrigin,
            encryptionKey: Redacted.value(cloudEncryptionKey),
            ...(machineUrl
              ? {
                  machine: {
                    url: machineUrl,
                    token: Redacted.value(machineToken),
                    ownerId: cloudAllowedUserId,
                  },
                }
              : {}),
            github: {
              accounts: createGitHubAccounts(Redacted.value(clerkSecretKey)),
              appId: githubAppId,
              privateKey: Redacted.value(githubPrivateKey),
              installationIds: githubInstallationIds
                .split(",")
                .map((s) => s.trim())
                .filter(Boolean),
            },
            wake: (userId) =>
              Effect.gen(function* () {
                const bucket = yield* cloudBucket.raw;
                // Queue remains available if the marker write fails; the hourly sweep
                // also recovers durable operations if both wakeup channels fail.
                yield* Effect.tryPromise(() => wakeReconciliation(bucket, userId)).pipe(
                  Effect.ignore,
                );
                yield* cloudQueueSender.send({ userId });
              }).pipe(
                Effect.provideService(Alchemy.RuntimeContext, alchemyRuntimeContext),
                Effect.mapError(
                  () =>
                    new CloudError(
                      "queue_unavailable",
                      "Cloud scheduling wakeup will be retried",
                      503,
                    ),
                ),
              ),
          }),
        ),
        Layer.provideMerge(MobileRegistrations.layer),
        Layer.provideMerge(AgentActivityPublisher.layer),
        Layer.provideMerge(EnvironmentConnector.layer),
        Layer.provideMerge(EnvironmentLinker.layer),
        Layer.provideMerge(EnvironmentPublishSignatures.layer),
        Layer.provideMerge(
          ManagedEndpointProvider.layerCloudflareBindings(
            managedEndpointTunnelBinding,
            managedEndpointDnsBinding,
            alchemyRuntimeContext,
          ),
        ),
        Layer.provideMerge(DpopProofs.layer),
        Layer.provideMerge(ApnsDeliveries.layer),
        Layer.provideMerge(ApnsClient.layer.pipe(Layer.provideMerge(ApnsProviderTokens.layer))),
        Layer.provideMerge(
          apnsDeliveryQueueSender
            ? ApnsDeliveryQueue.layerCloudflareQueues(
                apnsDeliveryQueueSender,
                alchemyRuntimeContext,
              )
            : ApnsDeliveryQueue.layerDisabled,
        ),
        Layer.provideMerge(AgentActivityRows.layer),
      )
      .pipe(
        Layer.provideMerge(Devices.layer),
        Layer.provideMerge(EnvironmentCredentials.layer),
        Layer.provideMerge(
          Layer.mergeAll(
            EnvironmentLinks.layer,
            ManagedEndpointAllocations.layer,
            ManagedTunnelLimits.layer,
          ),
        ),
      )
      .pipe(
        Layer.provideMerge(LiveActivities.layer),
        Layer.provideMerge(DeliveryAttempts.layer),
        Layer.provideMerge(RelayTokens.layer),
        Layer.provideMerge(Layer.succeed(RelayDb.RelayDb, db)),
        Layer.provideMerge(Layer.effect(RelayConfiguration.RelayConfiguration, loadSettings)),
        Layer.provideMerge(webcryptoLayer),
      );

    const appLayer = relayApiLayer.pipe(
      Layer.provideMerge(relayClientAuthLayer),
      Layer.provideMerge(relayDpopClientAuthLayer),
      Layer.provideMerge(relayEnvironmentAuthLayer),
      Layer.provide(runtimeLayer),
    );

    const cloudAppLayer = Layer.mergeAll(cloudApiLayer, cloudWorkerApiLayer).pipe(
      Layer.provideMerge(relayClientAuthLayer),
      Layer.provide(runtimeLayer),
    );

    const reconcileCloud = (userId: string, force: boolean) =>
      Effect.gen(function* () {
        if (userId !== cloudAllowedUserId) return;
        const bucket = yield* cloudBucket.raw.pipe(
          Effect.provideService(Alchemy.RuntimeContext, alchemyRuntimeContext),
        );
        // A queue retry can arrive after an idle marker was saved. Keep cron
        // monitoring active even if this reconciliation fails partway through.
        if (force)
          yield* Effect.tryPromise(() => wakeReconciliation(bucket, userId)).pipe(Effect.ignore);
        const now = yield* DateTime.now;
        const gate = yield* Effect.promise(() =>
          beginReconciliation(bucket, userId, DateTime.toEpochMillis(now), force),
        );
        if (!gate) return;
        const scheduler = yield* CloudScheduler.CloudScheduler;
        yield* scheduler.tick(userId);
        const store = yield* CloudStore.CloudStore;
        const state = yield* store.read(userId);
        yield* Effect.promise(() => gate.complete(needsFrequentReconciliation(state.state)));
      });

    yield* Cloudflare.messages<unknown>(cloudQueue, {
      batchSize: 1,
      maxRetries: 5,
      maxWaitTime: "1 second",
    }).subscribe((stream) =>
      stream.pipe(
        Stream.runForEach((message) =>
          Effect.gen(function* () {
            const body = message.body;
            if (
              typeof body !== "object" ||
              body === null ||
              !("userId" in body) ||
              typeof body.userId !== "string"
            )
              return;
            yield* reconcileCloud(body.userId, true);
          }),
        ),
        Effect.provide(runtimeLayer),
      ),
    );

    yield* Cloudflare.cron("* * * * *").subscribe(() =>
      Effect.gen(function* () {
        if (cloudAllowedUserId) yield* reconcileCloud(cloudAllowedUserId, false);
      }).pipe(Effect.provide(runtimeLayer)),
    );

    if (apnsDeliveryQueue && apnsDeliveryDeadLetterQueue)
      yield* Cloudflare.messages<unknown>(apnsDeliveryQueue, {
        batchSize: 10,
        maxRetries: 5,
        maxWaitTime: "5 seconds",
        retryDelay: "30 seconds",
        // Alchemy beta.45 expects a resolved string here although Queue names are Outputs.
        deadLetterQueue: apnsDeliveryDeadLetterQueue.queueName as unknown as string,
      }).subscribe((stream) =>
        stream.pipe(
          Stream.withSpan("relay.apn_delivery_queue.process_batch"),
          Stream.runForEach((message) =>
            ApnsDeliveries.ApnsDeliveries.pipe(
              Effect.flatMap((deliveries) => deliveries.processSignedJob(message.body)),
              Effect.withSpan("relay.apn_delivery_queue.process_message"),
            ),
          ),
          Effect.provide(runtimeLayer),
        ),
      );

    yield* Cloudflare.cron(mobileEnabled ? "*/5 * * * *" : "0 * * * *").subscribe(() =>
      DpopProofs.DpopProofReplay.pipe(
        Effect.flatMap((dpopProofs) => dpopProofs.pruneExpired),
        // Terminal thread rows are kept briefly so finished agents show as
        // Done/Failed in the Live Activity; sweep them once they age out.
        Effect.andThen(
          Effect.all([AgentActivityRows.AgentActivityRows, DateTime.now]).pipe(
            Effect.flatMap(([activityRows, now]) =>
              activityRows.pruneTerminal({
                updatedBefore: DateTime.formatIso(DateTime.subtract(now, { minutes: 30 })),
              }),
            ),
          ),
        ),
        Effect.withSpan("relay.cron.prune_expired_state"),
        Effect.provide(runtimeLayer),
      ),
    );

    const routeLayers = {
      documentation: Layer.mergeAll(
        documentationLayer,
        relayDocsRedirectRoute,
        HttpRouter.add(
          "GET",
          "/account/github",
          Effect.sync(() =>
            HttpServerResponse.text(githubAccountPage(clerkPublishableKey), {
              contentType: "text/html",
              headers: {
                "cache-control": "no-store",
                "referrer-policy": "no-referrer",
                "x-frame-options": "DENY",
                "x-content-type-options": "nosniff",
              },
            }),
          ),
        ),
      ),
      cloud: HttpApiBuilder.layer(CloudApi).pipe(Layer.provide(cloudAppLayer)),
      relay: HttpApiBuilder.layer(RelayApi).pipe(Layer.provide(appLayer)),
    };
    type RouteRequirements = Layer.Services<(typeof routeLayers)[keyof typeof routeLayers]>;
    const fetch = Layer.merge(
      Layer.unwrap(
        HttpServerRequest.HttpServerRequest.pipe(
          Effect.map(
            (request): Layer.Layer<never, never, RouteRequirements> =>
              routeLayers[requestRouteFamily(request.url)],
          ),
        ),
      ).pipe(Layer.provide([Etag.layerWeak, httpPlatformNotSupportedLayer, relayCors])),
      relayNotFoundRoute,
    ).pipe(
      HttpRouter.toHttpEffect,
      withoutCapturedParentSpan,
      Effect.flatMap((httpEffect) =>
        traceRelayHttpRequestWith(
          Effect.andThen(
            HttpEffect.appendPreResponseHandler((request, response) =>
              Effect.succeed(
                request.url.startsWith("/v1/cloud")
                  ? HttpServerResponse.setHeader(response, "cache-control", "no-store")
                  : response,
              ),
            ),
            httpEffect,
          ),
          relayTraceLayer,
          httpTracingEnabled,
        ),
      ),
    );

    return { fetch };
  }).pipe(
    Effect.provide(
      Layer.empty.pipe(
        Layer.provideMerge(Cloudflare.HyperdriveBindingLive),
        Layer.provideMerge(Cloudflare.CronEventSourceLive),
        Layer.provideMerge(Cloudflare.QueueBindingLive),
        Layer.provideMerge(Cloudflare.QueueEventSourceLive),
        Layer.provideMerge(Cloudflare.R2BucketBindingLive),
        Layer.provideMerge(Cloudflare.TunnelReadWriteLive),
        Layer.provideMerge(Cloudflare.DnsReadWriteLive),
      ),
    ),
  ),
) {}
