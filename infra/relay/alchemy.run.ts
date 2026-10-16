// @effect-diagnostics anyUnknownInErrorContext:off layerMergeAllWithDependencies:off - Alchemy provider helpers expose framework-owned any requirements.
import * as Alchemy from "alchemy";
import * as Axiom from "alchemy/Axiom";
import * as Cloudflare from "alchemy/Cloudflare";
import * as Drizzle from "alchemy/Drizzle";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as RelayDb from "./src/db.ts";
import { RelayObservability } from "./src/observability.ts";
import { ManagedEndpointZone, RelayApiZone } from "./src/zone.ts";
import Api from "./src/worker.ts";

export default Alchemy.Stack(
  process.env.RELAY_STACK_NAME?.trim() || "T3CodeRelay",
  {
    providers: Layer.mergeAll(Axiom.providers(), Cloudflare.providers(), Drizzle.providers()),
    state: Cloudflare.state(),
  },
  Effect.gen(function* () {
    const db = yield* RelayDb.RelayDatabase;
    const hyperdrive = yield* RelayDb.RelayHyperdrive;
    const managedEndpointZone = yield* ManagedEndpointZone.pipe(Effect.orDie);
    const relayApiZone = yield* RelayApiZone.pipe(Effect.orDie);
    const observability = yield* RelayObservability;
    const api = yield* Api;

    return {
      databaseName: db.origin.database,
      hyperdriveName: hyperdrive.name,
      workerName: api.workerName,
      url: api.url,
      relayApiZoneId: relayApiZone.zoneId,
      managedEndpointZoneId: managedEndpointZone.zoneId,
      mobileTracingUrl: observability.traces.otelTracesEndpoint,
      mobileTracingDataset: observability.traces.name,
      mobileTracingToken: observability.mobileIngestToken.token,
      clientTracingUrl: observability.traces.otelTracesEndpoint,
      clientTracingDataset: observability.traces.name,
      clientTracingToken: observability.clientIngestToken.token,
    };
  }),
);
