import type { PgClient } from "@effect/sql-pg/PgClient";
import * as Cloudflare from "alchemy/Cloudflare";
import * as Drizzle from "alchemy/Drizzle";
import type { EffectPgDatabase } from "drizzle-orm/effect-postgres";
import * as Context from "effect/Context";
import * as Config from "effect/Config";
import * as Effect from "effect/Effect";

import { DatabaseSetupError, databaseTlsConfiguration, parseDatabaseUrl } from "./dbConfig.ts";

export class RelayDb extends Context.Service<
  RelayDb,
  EffectPgDatabase & {
    readonly $client: PgClient;
  }
>()("t3code-relay/db/RelayDb") {}

export const RelayDatabase = Effect.gen(function* () {
  yield* Drizzle.Schema("RelaySchema", {
    schema: "./src/persistence/schema.ts",
    out: "./migrations/postgres",
    dialect: "postgres",
  });

  const url = yield* Config.redacted("RELAY_DATABASE_URL");
  const origin = yield* Effect.try({
    try: () => parseDatabaseUrl(url),
    catch: () => new DatabaseSetupError({ message: "Invalid direct runtime database URL" }),
  }).pipe(Effect.orDie);
  if (origin.user !== "vitre_relay")
    return yield* Effect.die(
      new DatabaseSetupError({
        message: "RELAY_DATABASE_URL must use the vitre_relay runtime role",
      }),
    );
  return { origin };
});

export const RelayHyperdrive = Effect.gen(function* () {
  const { origin } = yield* RelayDatabase;
  const caCertificate = yield* Config.string("RELAY_DATABASE_CA_CERT").pipe(Config.withDefault(""));
  const caCertificateId = yield* Config.string("RELAY_DATABASE_CA_CERTIFICATE_ID").pipe(
    Config.withDefault(""),
  );
  const tls = yield* Effect.try({
    try: () => databaseTlsConfiguration(caCertificate, caCertificateId),
    catch: () => new DatabaseSetupError({ message: "Invalid database TLS configuration" }),
  }).pipe(Effect.orDie);
  return yield* Cloudflare.Hyperdrive("RelayHyperdrive", {
    origin,
    ...(tls.hyperdrive ? { mtls: tls.hyperdrive } : {}),
    caching: {
      disabled: true,
    },
    originConnectionLimit: 20,
  });
});
