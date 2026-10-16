// @effect-diagnostics nodeBuiltinImport:off - Exercise real local TLS handshakes against disposable fixture keys.
import { describe, expect, it } from "vite-plus/test";
import * as NodeFSP from "node:fs/promises";
import * as NodeTls from "node:tls";

import * as Redacted from "effect/Redacted";
import { databaseConfiguration, databaseTlsConfiguration, parseDatabaseUrl } from "./dbConfig.ts";

const url = (user = "vitre_relay", host = "database.example.com") =>
  Redacted.make(`postgresql://${user}:encoded%40secret@${host}/vitre?sslmode=require`);

describe("PostgreSQL database configuration", () => {
  it("decodes credentials and keeps the password redacted", () => {
    const config = parseDatabaseUrl(url());
    expect(config).toMatchObject({
      host: "database.example.com",
      port: 5432,
      database: "vitre",
      user: "vitre_relay",
    });
    expect(Redacted.value(config.password)).toBe("encoded@secret");
    expect(JSON.stringify(config)).not.toContain("encoded");
  });
  it("rejects pooled endpoints, insecure URLs and malformed credentials without leaking them", () => {
    for (const value of [
      url("vitre_relay", "ep-test-pooler.neon.tech"),
      Redacted.make("postgres://u:secret@host/db"),
      Redacted.make("secret"),
    ]) {
      expect(() => parseDatabaseUrl(value)).toThrow("direct PostgreSQL");
      try {
        parseDatabaseUrl(value);
      } catch (error) {
        expect(String(error)).not.toContain("secret");
      }
    }
  });
  it("requires separate roles on the same database", () => {
    expect(databaseConfiguration(url("vitre_owner"), url()).origin.user).toBe("vitre_relay");
    expect(() => databaseConfiguration(url(), url())).toThrow("separate");
    expect(() =>
      databaseConfiguration(url("vitre_owner"), url("vitre_relay", "different.example.com")),
    ).toThrow("same database");
    expect(() => databaseConfiguration(url("vitre_owner"), url("vitre_owner"))).toThrow("separate");
  });
});

describe("database TLS trust", () => {
  it("keeps system trust by default and rejects incomplete custom trust", () => {
    expect(databaseTlsConfiguration()).toEqual({
      client: { rejectUnauthorized: true },
      hyperdrive: undefined,
    });
    const ca = "-----BEGIN CERTIFICATE-----\nZmFrZQ==\n-----END CERTIFICATE-----";
    for (const [certificate, id] of [
      [ca, ""],
      [ca, "ca-id"],
      ["", "ca-id"],
      ["invalid certificate", "ca-id"],
      [`${ca}\n${ca}`, "ca-id"],
      ["-----BEGIN PRIVATE KEY-----\nprivate\n-----END PRIVATE KEY-----", "ca-id"],
    ]) {
      expect(() => databaseTlsConfiguration(certificate, id)).toThrow("Custom database TLS");
    }
  });

  it("rejects a valid leaf certificate as a CA", async () => {
    const leaf = await NodeFSP.readFile(
      new URL("./fixtures/database-tls/leaf.crt", import.meta.url),
      "utf8",
    );
    expect(() => databaseTlsConfiguration(leaf, "ca-id")).toThrow("Custom database TLS");
  });

  it("authenticates a proxy's private CA and rejects an unrelated certificate authority", async () => {
    const fixture = (name: string) =>
      NodeFSP.readFile(new URL(`./fixtures/database-tls/${name}`, import.meta.url), "utf8");
    const [cert, key, unrelated] = await Promise.all([
      fixture("server.crt"),
      fixture("server.key"),
      fixture("unrelated.crt"),
    ]);
    const server = NodeTls.createServer({ cert, key });
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Missing test TLS listener");
    const connect = (ssl: NodeTls.ConnectionOptions) =>
      new Promise<boolean>((resolve, reject) => {
        const socket = NodeTls.connect({
          ...ssl,
          host: "127.0.0.1",
          port: address.port,
          servername: "tcp-proxy.invalid",
        });
        socket.once("secureConnect", () => {
          resolve(socket.authorized);
          socket.destroy();
        });
        socket.once("error", reject);
        socket.setTimeout(2_000, () => socket.destroy(new Error("TLS test timed out")));
      });
    try {
      const custom = databaseTlsConfiguration(cert, "service-ca-id");
      expect(custom.client.rejectUnauthorized).toBe(true);
      expect(custom.hyperdrive).toEqual({
        caCertificateId: "service-ca-id",
        sslmode: "verify-ca",
      });
      await expect(connect(custom.client)).resolves.toBe(true);
      await expect(
        connect(databaseTlsConfiguration(unrelated, "other-ca-id").client),
      ).rejects.toThrow();
      await expect(connect(databaseTlsConfiguration().client)).rejects.toThrow();
      // The hostname exception is scoped to explicit private trust only.
      await expect(connect({ rejectUnauthorized: true, ca: cert })).rejects.toMatchObject({
        code: "ERR_TLS_CERT_ALTNAME_INVALID",
      });
    } finally {
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    }
  });
});
