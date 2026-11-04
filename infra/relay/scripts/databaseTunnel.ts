// @effect-diagnostics nodeBuiltinImport:off - Deployment-only local TCP tunnel lifecycle.
import * as NodeChildProcess from "node:child_process";
import * as NodeNet from "node:net";
import * as NodePerfHooks from "node:perf_hooks";
import * as NodeTimersPromises from "node:timers/promises";

export interface DatabaseTunnelConfig {
  hostname: string;
  clientId: string;
  clientSecret: string;
}

export function databaseTunnelConfiguration(
  hostname: string,
  clientId: string,
  clientSecret: string,
) {
  if (!hostname && !clientId && !clientSecret) return undefined;
  if (
    !/^(?=.{1,253}$)[a-z0-9]+(?:[a-z0-9.-]*[a-z0-9])?\.[a-z]{2,}$/i.test(hostname) ||
    !clientId ||
    !clientSecret
  )
    throw new Error("Database tunnel requires a hostname and both Access service credentials");
  return { hostname, clientId, clientSecret };
}

async function unusedPort(): Promise<number> {
  const server = NodeNet.createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address() as NodeNet.AddressInfo;
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
  return address.port;
}

async function listening(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = NodeNet.connect({ host: "127.0.0.1", port });
    const finish = (ready: boolean) => {
      socket.destroy();
      resolve(ready);
    };
    socket.once("connect", () => finish(true));
    socket.once("error", () => finish(false));
    socket.setTimeout(200, () => finish(false));
  });
}

/** Credentials stay out of command arguments and logs; callers must close in a finalizer. */
export async function startDatabaseTunnel(
  config: DatabaseTunnelConfig,
  options: { spawn?: typeof NodeChildProcess.spawn; timeoutMs?: number } = {},
) {
  const port = await unusedPort();
  const child = (options.spawn ?? NodeChildProcess.spawn)(
    "cloudflared",
    ["access", "tcp", "--hostname", config.hostname, "--url", `127.0.0.1:${port}`],
    {
      stdio: "ignore",
      env: {
        ...process.env,
        TUNNEL_SERVICE_TOKEN_ID: config.clientId,
        TUNNEL_SERVICE_TOKEN_SECRET: config.clientSecret,
      },
    },
  );
  let stopped = false;
  const done = new Promise<void>((resolve) => {
    const finish = () => {
      stopped = true;
      resolve();
    };
    child.once("error", finish);
    child.once("close", finish);
  });
  const close = async () => {
    if (stopped) return;
    child.kill("SIGTERM");
    const cancellation = new AbortController();
    const force = NodeTimersPromises.setTimeout(2000, undefined, { signal: cancellation.signal })
      .then(() => {
        child.kill("SIGKILL");
      })
      .catch(() => {});
    try {
      await done;
    } finally {
      cancellation.abort();
      await force;
    }
  };
  try {
    const deadline = NodePerfHooks.performance.now() + (options.timeoutMs ?? 10000);
    while (NodePerfHooks.performance.now() < deadline) {
      if (stopped) break;
      if (await listening(port)) {
        if (!stopped) return { port, close };
        break;
      }
      await NodeTimersPromises.setTimeout(50);
    }
    throw new Error(
      "Database tunnel could not start; check cloudflared installation and Access configuration",
    );
  } catch (error) {
    await close();
    throw error;
  }
}
