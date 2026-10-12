/**
 * Anonymous PostHog telemetry service.
 *
 * Persists an installation-scoped anonymous identifier, buffers events in
 * memory, and flushes batches over Effect's HTTP client.
 *
 * @module AnalyticsService
 */
import { HostProcessArchitecture, HostProcessPlatform } from "@t3tools/shared/hostProcess";
import * as Config from "effect/Config";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest";
import * as HttpClientResponse from "effect/unstable/http/HttpClientResponse";

import packageJson from "../../package.json" with { type: "json" };
import { writeFileStringAtomically } from "../atomicWrite.ts";
import * as ServerConfig from "../config.ts";
import { getTelemetryIdentifier } from "./Identify.ts";

const BufferedAnalyticsEventSchema = Schema.Struct({
  event: Schema.String,
  properties: Schema.optional(Schema.Record(Schema.String, Schema.Unknown)),
  capturedAt: Schema.String,
});

type BufferedAnalyticsEvent = typeof BufferedAnalyticsEventSchema.Type;

const PendingAnalyticsEvents = Schema.fromJsonString(Schema.Array(BufferedAnalyticsEventSchema));

const decodePendingAnalyticsEvents = Schema.decodeUnknownEffect(PendingAnalyticsEvents);
const encodePendingAnalyticsEvents = Schema.encodeEffect(PendingAnalyticsEvents);

const TelemetryEnvConfig = Config.all({
  posthogKey: Config.string("T3CODE_POSTHOG_KEY").pipe(
    Config.withDefault("phc_XOWci4oZP4VvLiEyrFqkFjP4CZn55mjYYBMREK5Wd6m"),
  ),
  posthogHost: Config.string("T3CODE_POSTHOG_HOST").pipe(
    Config.withDefault("https://us.i.posthog.com"),
  ),
  enabled: Config.boolean("T3CODE_TELEMETRY_ENABLED").pipe(Config.withDefault(true)),
  flushBatchSize: Config.number("T3CODE_TELEMETRY_FLUSH_BATCH_SIZE").pipe(Config.withDefault(20)),
  maxBufferedEvents: Config.number("T3CODE_TELEMETRY_MAX_BUFFERED_EVENTS").pipe(
    Config.withDefault(1_000),
  ),
  wslDistroName: Config.string("WSL_DISTRO_NAME").pipe(Config.option),
});

export class AnalyticsService extends Context.Service<
  AnalyticsService,
  {
    /** Record an anonymous event for best-effort buffered delivery. */
    readonly record: (
      event: string,
      properties?: Readonly<Record<string, unknown>>,
    ) => Effect.Effect<void>;

    /** Flush all currently queued telemetry events. */
    readonly flush: Effect.Effect<void>;
  }
>()("t3/telemetry/AnalyticsService") {
  /** No-op layer for callers that intentionally disable telemetry. */
  static readonly layerTest = Layer.succeed(
    AnalyticsService,
    AnalyticsService.of({
      record: () => Effect.void,
      flush: Effect.void,
    }),
  );
}

export const make = Effect.gen(function* () {
  const telemetryConfig = yield* TelemetryEnvConfig;
  const httpClient = yield* HttpClient.HttpClient;
  const serverConfig = yield* ServerConfig.ServerConfig;
  const fileSystem = yield* FileSystem.FileSystem;
  const identifier = yield* getTelemetryIdentifier;
  const pendingPath = serverConfig.pendingTelemetryPath;

  /**
   * Events spilled by a previous run's shutdown. Reading them back here is what
   * lets the shutdown path skip the network entirely: the file is consumed and
   * removed immediately, so a crash between read and send drops at most one
   * run's tail rather than replaying it forever.
   */
  const restorePendingEvents = Effect.gen(function* () {
    const contents = yield* fileSystem.readFileString(pendingPath).pipe(
      Effect.map(Option.some),
      Effect.catchTag("PlatformError", () => Effect.succeed(Option.none<string>())),
    );
    yield* fileSystem.remove(pendingPath, { force: true }).pipe(Effect.ignore);
    if (Option.isNone(contents)) return [] as ReadonlyArray<BufferedAnalyticsEvent>;
    const trimmed = contents.value.trim();
    if (trimmed.length === 0) return [] as ReadonlyArray<BufferedAnalyticsEvent>;
    return yield* decodePendingAnalyticsEvents(trimmed).pipe(
      Effect.catchCause(() => Effect.succeed([] as ReadonlyArray<BufferedAnalyticsEvent>)),
    );
  });

  const restored = telemetryConfig.enabled
    ? yield* restorePendingEvents
    : ([] as ReadonlyArray<BufferedAnalyticsEvent>);
  const bufferRef = yield* Ref.make<ReadonlyArray<BufferedAnalyticsEvent>>(restored);
  const clientType = serverConfig.mode === "desktop" ? "desktop-app" : "cli-web-client";
  const hostPlatform = yield* HostProcessPlatform;
  const hostArchitecture = yield* HostProcessArchitecture;

  const enqueueBufferedEvent = (event: string, properties?: Readonly<Record<string, unknown>>) =>
    Effect.flatMap(DateTime.now, (now) =>
      Ref.modify(bufferRef, (current) => {
        const appended = [
          ...current,
          {
            event,
            ...(properties ? { properties } : {}),
            capturedAt: DateTime.formatIso(now),
          } satisfies BufferedAnalyticsEvent,
        ];

        const next =
          appended.length > telemetryConfig.maxBufferedEvents
            ? appended.slice(appended.length - telemetryConfig.maxBufferedEvents)
            : appended;

        return [
          {
            size: next.length,
            dropped: next.length !== appended.length,
          } as const,
          next,
        ] as const;
      }),
    );

  const sendBatch = Effect.fn("AnalyticsService.sendBatch")(function* (
    events: ReadonlyArray<BufferedAnalyticsEvent>,
  ) {
    if (!telemetryConfig.enabled || !identifier) return;

    const payload = {
      api_key: telemetryConfig.posthogKey,
      batch: events.map((event) => ({
        event: event.event,
        distinct_id: identifier,
        properties: {
          ...event.properties,
          $process_person_profile: false,
          platform: hostPlatform,
          wsl: Option.getOrUndefined(telemetryConfig.wslDistroName),
          arch: hostArchitecture,
          t3CodeVersion: packageJson.version,
          clientType,
        },
        timestamp: event.capturedAt,
      })),
    };

    yield* HttpClientRequest.post(`${telemetryConfig.posthogHost}/batch/`).pipe(
      HttpClientRequest.bodyJson(payload),
      Effect.flatMap(httpClient.execute),
      Effect.flatMap(HttpClientResponse.filterStatusOk),
    );
  });

  const flush: AnalyticsService["Service"]["flush"] = Effect.gen(function* () {
    while (true) {
      const batch = yield* Ref.modify(bufferRef, (current) => {
        if (current.length === 0) {
          return [[] as ReadonlyArray<BufferedAnalyticsEvent>, current] as const;
        }
        const nextBatch = current.slice(0, telemetryConfig.flushBatchSize);
        const remaining = current.slice(nextBatch.length);
        return [nextBatch, remaining] as const;
      });

      if (batch.length === 0) {
        return;
      }

      yield* sendBatch(batch).pipe(
        Effect.catch((error) =>
          Ref.update(bufferRef, (current) => [...batch, ...current]).pipe(
            Effect.flatMap(() => Effect.fail(error)),
          ),
        ),
      );
    }
  }).pipe(Effect.catch((cause) => Effect.logError("Failed to flush telemetry", { cause })));

  const record: AnalyticsService["Service"]["record"] = Effect.fn("AnalyticsService.record")(
    function* (event, properties) {
      if (!telemetryConfig.enabled || !identifier) return;

      const enqueueResult = yield* enqueueBufferedEvent(event, properties);
      if (enqueueResult.dropped) {
        yield* Effect.logDebug("analytics buffer full; dropping oldest event", {
          size: enqueueResult.size,
          event,
        });
      }
    },
  );

  /**
   * Shutdown must never wait on PostHog. The pooled connection has always gone
   * idle by the time a user quits, so flushing here costs a cold DNS + TCP +
   * TLS round trip (measured at 750-1300ms) on the desktop app's critical quit
   * path. Spill to disk instead and let the next boot deliver it.
   */
  const spillPendingEvents = Effect.gen(function* () {
    const pending = yield* Ref.getAndSet(bufferRef, []);
    if (!telemetryConfig.enabled || pending.length === 0) return;
    const contents = yield* encodePendingAnalyticsEvents(pending);
    yield* writeFileStringAtomically({ filePath: pendingPath, contents });
  }).pipe(Effect.ignore);

  yield* Effect.forever(Effect.sleep(1000).pipe(Effect.flatMap(() => flush)), {
    disableYield: true,
  }).pipe(Effect.forkScoped);

  yield* Effect.addFinalizer(() => spillPendingEvents);

  return AnalyticsService.of({ record, flush });
});

export const layer = Layer.effect(AnalyticsService, make);

export const layerTest = AnalyticsService.layerTest;
