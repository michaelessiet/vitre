import * as NodeChildProcess from "node:child_process";
import * as NodeFSP from "node:fs/promises";
import * as NodeModule from "node:module";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
import * as Effect from "effect/Effect";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { relayWorkerBuild } from "../src/workerBuild.ts";

// Use the same builder and workerd versions as the locked Alchemy deployment.
const alchemyUrl = import.meta.resolve("alchemy");
const { WorkerBundle } = await import(new URL("Cloudflare/Workers/WorkerBundle.js", alchemyUrl));
const alchemyRequire = NodeModule.createRequire(alchemyUrl);
const runtimeRequire = NodeModule.createRequire(
  alchemyRequire.resolve("@distilled.cloud/cloudflare-runtime"),
);
const workerd = runtimeRequire("workerd").default;
const directory = NodeURL.fileURLToPath(new URL("../.alchemy/startup/", import.meta.url));
await NodeFSP.mkdir(directory, { recursive: true });
const temporary = await NodeFSP.mkdtemp(NodePath.join(directory, "check-"));

try {
  const bundle = await Effect.runPromise(
    Effect.gen(function* () {
      const builder = yield* WorkerBundle;
      return yield* builder.build({
        id: "StartupCheck",
        main: NodeURL.fileURLToPath(new URL("../src/worker.ts", import.meta.url)),
        compatibility: relayWorkerBuild.compatibility,
        entry: { kind: "effect", exports: {} },
        stack: {
          name: process.env.RELAY_STACK_NAME || "VitrePersonalRelay",
          stage: process.env.RELAY_STAGE || "personal",
        },
        extraOptions: relayWorkerBuild.build,
      });
    }).pipe(Effect.provide(NodeServices.layer)),
  );
  const modules = bundle.files.filter((file) => file.path.endsWith(".js"));
  const bytes = modules.reduce((total, file) => total + Buffer.byteLength(file.content), 0);
  if (bytes > 2_000_000) throw new Error(`Relay startup bundle is ${bytes} bytes; budget is 2 MB.`);
  if (modules.some((file) => file.content.includes("/access/ai-controls/mcp/portals"))) {
    throw new Error("Unrelated Zero Trust schemas survived relay tree shaking.");
  }
  for (const file of modules)
    await NodeFSP.writeFile(NodePath.join(temporary, file.path), file.content);
  await NodeFSP.writeFile(
    NodePath.join(temporary, "startup-test.js"),
    `
    import Worker from "./${modules[0].path}";
    export default { test() {
      if (typeof Worker !== "function") throw new Error("Relay Worker export missing");
    } };
  `,
  );
  const entries = ["startup-test.js", ...modules.map((file) => file.path)].map(
    (name) => `(name = ${JSON.stringify(name)}, esModule = embed ${JSON.stringify(name)})`,
  );
  const configuration = NodePath.join(temporary, "config.capnp");
  await NodeFSP.writeFile(
    configuration,
    `
    using Workerd = import "/workerd/workerd.capnp";
    const config :Workerd.Config = (services = [(name = "relay", worker = (
      compatibilityDate = ${JSON.stringify(relayWorkerBuild.compatibility.date)},
      compatibilityFlags = ${JSON.stringify(relayWorkerBuild.compatibility.flags)},
      modules = [${entries.join(",")}]
    ))]);
  `,
  );
  // This starts the actual bundle without production bindings or network calls.
  // Local timing is not Cloudflare's CPU limit; the size and schema gates provide
  // deterministic regressions, followed by Cloudflare validation during deploy.
  const result = NodeChildProcess.spawnSync(workerd, ["test", configuration], {
    stdio: "inherit",
    timeout: 30_000,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`Relay cold-start check failed (${result.status}).`);
  console.log(`Relay startup verified in workerd: ${bytes} bytes (2 MB budget).`);
} finally {
  await NodeFSP.rm(temporary, { recursive: true, force: true });
}
