// @effect-diagnostics nodeBuiltinImport:off - Verify deployment child-process and loopback socket cleanup.
import * as NodeChildProcess from "node:child_process";
import * as NodeNet from "node:net";
import { describe, expect, it } from "vite-plus/test";
import { databaseTunnelConfiguration, startDatabaseTunnel } from "./databaseTunnel.ts";

const config = {
  hostname: "database.example.com",
  clientId: "test-id",
  clientSecret: "test-secret",
};

describe("deployment database tunnel", () => {
  it("keeps direct deployments optional and rejects partial or URL-shaped configuration", () => {
    expect(databaseTunnelConfiguration("", "", "")).toBeUndefined();
    expect(
      databaseTunnelConfiguration(config.hostname, config.clientId, config.clientSecret),
    ).toEqual(config);
    for (const values of [
      [config.hostname, "", ""],
      ["", config.clientId, config.clientSecret],
      ["https://user:secret@example.com/path", config.clientId, config.clientSecret],
    ])
      expect(() => databaseTunnelConfiguration(values[0]!, values[1]!, values[2]!)).toThrow(
        "requires",
      );
  });

  it("passes credentials only in the environment and closes the real listener", async () => {
    let child: NodeChildProcess.ChildProcess | undefined;
    const tunnel = await startDatabaseTunnel(config, {
      spawn: ((_command, args, options) => {
        expect(args).not.toContain(config.clientSecret);
        expect(options?.env?.TUNNEL_SERVICE_TOKEN_ID).toBe(config.clientId);
        expect(options?.env?.TUNNEL_SERVICE_TOKEN_SECRET).toBe(config.clientSecret);
        expect(options?.stdio).toBe("ignore");
        const port = args!.at(-1)!.split(":")[1]!;
        child = NodeChildProcess.spawn(
          process.execPath,
          [
            "-e",
            "require('node:net').createServer(s => s.pipe(s)).listen(Number(process.argv[1]), '127.0.0.1')",
            port,
          ],
          options ?? {},
        );
        return child;
      }) as typeof NodeChildProcess.spawn,
    });
    try {
      const echo = await new Promise<string>((resolve, reject) => {
        const socket = NodeNet.connect(tunnel.port, "127.0.0.1", () =>
          socket.write("database traffic"),
        );
        socket.on("error", reject);
        socket.once("data", (data) => {
          socket.destroy();
          resolve(data.toString());
        });
      });
      expect(echo).toBe("database traffic");
    } finally {
      await tunnel.close();
    }
    expect(child!.signalCode).toBe("SIGTERM");
    await tunnel.close();
    await expect(
      new Promise<void>((resolve, reject) => {
        const socket = NodeNet.connect(tunnel.port, "127.0.0.1", () => {
          socket.destroy();
          resolve();
        });
        socket.once("error", reject);
      }),
    ).rejects.toMatchObject({ code: "ECONNREFUSED" });
  });

  it("terminates a child that never opens its port", async () => {
    let child: NodeChildProcess.ChildProcess | undefined;
    await expect(
      startDatabaseTunnel(config, {
        timeoutMs: 100,
        spawn: ((_command, _args, options) => {
          child = NodeChildProcess.spawn(
            process.execPath,
            ["-e", "setInterval(() => {}, 1000)"],
            options ?? {},
          );
          return child;
        }) as typeof NodeChildProcess.spawn,
      }),
    ).rejects.toThrow("could not start");
    expect(child!.signalCode).toBe("SIGTERM");
  });

  it("fails cleanly when the cloudflared executable is missing", async () => {
    await expect(
      startDatabaseTunnel(config, {
        spawn: ((_command, args, options) =>
          NodeChildProcess.spawn(
            "/nonexistent/vitre-cloudflared",
            args!,
            options!,
          )) as typeof NodeChildProcess.spawn,
      }),
    ).rejects.toThrow("could not start");
  });
});
