// @effect-diagnostics nodeBuiltinImport:off - Deployment configuration validates the supplied X.509 trust anchor.
import * as NodeCrypto from "node:crypto";

import * as Redacted from "effect/Redacted";
import * as Data from "effect/Data";

export class DatabaseSetupError extends Data.TaggedError("DatabaseSetupError")<{
  message: string;
}> {}

/** Hyperdrive supplies pooling; use the database's direct endpoint. */
export function parseDatabaseUrl(value: Redacted.Redacted<string>) {
  try {
    const url = new URL(Redacted.value(value));
    const database = decodeURIComponent(url.pathname.slice(1));
    const user = decodeURIComponent(url.username);
    const password = decodeURIComponent(url.password);
    if (
      !["postgres:", "postgresql:"].includes(url.protocol) ||
      !url.hostname ||
      url.hostname.includes("-pooler.") ||
      !database ||
      database.includes("/") ||
      !user ||
      !password ||
      !["require", "verify-full"].includes(url.searchParams.get("sslmode") ?? "")
    )
      throw new Error();
    return {
      scheme: "postgres" as const,
      host: url.hostname,
      port: Number(url.port || 5432),
      database,
      user,
      password: Redacted.make(password),
    };
  } catch {
    throw new Error(
      "Database URL must be a direct PostgreSQL URL with credentials and sslmode=require or verify-full",
    );
  }
}

export function databaseConfiguration(
  admin: Redacted.Redacted<string>,
  runtime: Redacted.Redacted<string>,
) {
  const owner = parseDatabaseUrl(admin);
  const origin = parseDatabaseUrl(runtime);
  if (
    owner.host !== origin.host ||
    owner.port !== origin.port ||
    owner.database !== origin.database ||
    owner.user === origin.user ||
    origin.user !== "vitre_relay"
  ) {
    throw new Error(
      "Database URLs must target the same database with a separate vitre_relay runtime role",
    );
  }
  return { owner, origin };
}

/** Custom private CAs require matching trust configuration in both clients. */
export function databaseTlsConfiguration(caCertificate = "", caCertificateId = "") {
  const ca = caCertificate.trim();
  const id = caCertificateId.trim();
  if (!ca && !id)
    return {
      client: { rejectUnauthorized: true as const },
      hyperdrive: undefined,
    };
  try {
    if (
      !id ||
      !/^-----BEGIN CERTIFICATE-----\r?\n[A-Za-z0-9+/=\r\n]+\r?\n-----END CERTIFICATE-----$/.test(
        ca,
      ) ||
      !new NodeCrypto.X509Certificate(ca).ca
    )
      throw new Error();
  } catch {
    throw new Error(
      "Custom database TLS requires one PEM CA certificate and its Cloudflare CA certificate ID",
    );
  }
  return {
    client: {
      rejectUnauthorized: true as const,
      ca,
      // A private database CA authenticates this service through a TCP proxy
      // whose public hostname is absent from the service's certificate. Match
      // Hyperdrive's verify-ca mode while retaining signature/expiry checks.
      checkServerIdentity: () => undefined,
    },
    hyperdrive: { caCertificateId: id, sslmode: "verify-ca" as const },
  };
}
