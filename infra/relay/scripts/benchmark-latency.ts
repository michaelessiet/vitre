// @effect-diagnostics nodeBuiltinImport:off globalDate:off globalProcess:off globalFetch:off preferSchemaOverJson:off - Standalone, disposable PostgreSQL benchmark; JSON contains timings only.
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as NodeCrypto from "node:crypto";
import * as NodeProcess from "node:process";
import * as NodeChildProcess from "node:child_process";
import * as NodeUtil from "node:util";
import * as NodeTimersPromises from "node:timers/promises";
import * as Pg from "pg";
import * as PgClient from "@effect/sql-pg/PgClient";
import * as PgDrizzle from "drizzle-orm/effect-postgres";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as ManagedRuntime from "effect/ManagedRuntime";
import * as Redacted from "effect/Redacted";
import * as Crypto from "@effect/platform-node/NodeCrypto";
import { RelayDb } from "../src/db.ts";
import { CloudStore, emptyDocument, layer as storeLayer } from "../src/cloud/store.ts";
import { CloudService, layer as serviceLayer } from "../src/cloud/service.ts";
import { CloudWorkerControl, layer as workerLayer } from "../src/cloud/workerControl.ts";
import { CloudScheduler, layer as schedulerLayer } from "../src/cloud/scheduler.ts";
import { CloudAuxiliary } from "../src/cloud/auxiliary.ts";
import { CloudConfiguration } from "../src/cloud/config.ts";
import { CloudArtifacts } from "../src/cloud/artifacts.ts";
import { ManagedEndpointProvider } from "../src/environments/ManagedEndpointProvider.ts";
import { CredentialVault, sha256 } from "../src/cloud/crypto.ts";
import { createPreparationReporter } from "../../../scripts/vitre/cloud/worker.mjs";
import { emptyLens } from "@t3tools/shared/lens";

// No production endpoint or credential is accepted. The optional transport model
// adds RTT + JSON bytes / bandwidth to real SQL operations; it is not a live SLA test.
const url = NodeProcess.env.VITRE_STORE_TEST_DATABASE_URL ?? "";
const target = new URL(url);
if (target.hostname !== "127.0.0.1" || target.pathname !== "/vitre_store")
  throw new Error("Use only the disposable local vitre_store database");
const samples = Number(NodeProcess.env.VITRE_BENCH_SAMPLES ?? 10);
const rtt = Number(NodeProcess.env.VITRE_BENCH_DB_RTT_MS ?? 0);
const bytesPerMs = Number(NodeProcess.env.VITRE_BENCH_DB_BYTES_PER_MS ?? 0);
const lensConversations = Number(NodeProcess.env.VITRE_BENCH_LENS_CONVERSATIONS ?? 0);
if (
  !Number.isInteger(samples) ||
  samples < 1 ||
  samples > 100 ||
  !Number.isFinite(rtt) ||
  rtt < 0 ||
  !Number.isFinite(bytesPerMs) ||
  bytesPerMs < 0 ||
  !Number.isInteger(lensConversations) ||
  lensConversations < 0 ||
  lensConversations > 1000
)
  throw new Error("Invalid benchmark parameters");
const output = NodeProcess.env.VITRE_BENCH_OUTPUT ?? "/tmp/vitre-latency.json";
const root = NodePath.resolve(import.meta.dirname, "../../..");
const exec = NodeUtil.promisify(NodeChildProcess.execFile);
const { stdout: baseCommit } = await exec("git", ["rev-parse", "HEAD"], { cwd: root });
const pool = new Pg.Pool({ connectionString: url });
const userId = `latency-${NodeCrypto.randomUUID()}`;
const originalFetch = globalThis.fetch;
const metrics = { queries: 0, bytes: 0 };
const size = (value: unknown) => Buffer.byteLength(JSON.stringify(value));
const modelDelay = (queries: number, bytes: number) => {
  metrics.queries += queries;
  metrics.bytes += bytes;
  const ms = queries * rtt + (bytesPerMs ? bytes / bytesPerMs : 0);
  return ms ? Effect.sleep(ms) : Effect.void;
};
const measuredStore = (store: CloudStore["Service"]): CloudStore["Service"] => ({
  users: store.users,
  read: (user, options) =>
    Effect.gen(function* () {
      const document = yield* store.read(user, options);
      yield* modelDelay(1, size(document));
      return document;
    }),
  mutate: (user, reduce, options) =>
    Effect.gen(function* () {
      let transfer: { queries: number; bytes: number } | undefined;
      const result = yield* store.mutate(
        user,
        (document) => {
          const before = JSON.stringify(document);
          const value = reduce(document);
          const after = JSON.stringify(document);
          // These runs have one writer. Count a no-op's second reducer invocation
          // as part of the same read, rather than inventing another database query.
          transfer ??= {
            queries: before === after ? 1 : 2,
            bytes: Buffer.byteLength(before) + (before === after ? 0 : Buffer.byteLength(after)),
          };
          return value;
        },
        options,
      );
      yield* modelDelay(transfer!.queries, transfer!.bytes);
      return result;
    }),
});
const summary = (values: number[]) => {
  const sorted = values.toSorted((a, b) => a - b);
  return {
    median: sorted[Math.floor(sorted.length / 2)],
    p95: sorted[Math.ceil(sorted.length * 0.95) - 1],
  };
};
const results: unknown[] = [];
try {
  await pool.query(
    "CREATE TABLE IF NOT EXISTS relay_cloud_accounts (user_id varchar(255) PRIMARY KEY, revision integer NOT NULL, document jsonb NOT NULL)",
  );
  const encryptionKey = btoa("b".repeat(32));
  const vault = new CredentialVault(encryptionKey);
  const document = emptyDocument();
  document.state.accounts.codex = {
    provider: "codex",
    state: "connected",
    credentialVersion: 1,
    leasedBy: null,
  };
  document.private.credentials.codex = {
    version: 1,
    sealed: await vault.seal(
      '{"auth_mode":"chatgpt","tokens":{"refresh_token":"synthetic"}}',
      `${userId}:codex:1`,
    ),
  };
  // A reproducible account with retained event history, similar in total size
  // to the previous 1.08 MB observation. No real account content is copied.
  document.state.events = Object.fromEntries(
    Array.from({ length: 10 }, (_, t) => [
      String(t),
      Array.from({ length: 500 }, (_, i) => ({
        cursor: i,
        sequence: i,
        attemptId: "history-attempt",
        phase: "heartbeat",
        detail: "Synthetic retained event for transport measurement",
        createdAt: "2026-11-04T00:00:00.000Z",
      })),
    ]),
  );
  document.state.lensConversations = {};
  if (lensConversations) {
    document.state.lens = emptyLens();
    document.state.lens.inventories.desktop = {
      sourceId: "desktop",
      sourceLabel: "Desktop",
      collectedAt: "2026-11-04T00:00:00Z",
      projects: [],
      conversations: Array.from({ length: lensConversations }, (_, i) => ({
        id: `lens-${i}`,
        projectId: "fixture",
        title: "Synthetic conversation",
        updatedAt: "2026-11-04T00:00:00Z",
        lastAssistantAt: null,
        readAt: null,
        busy: false,
        needsInput: false,
        archived: false,
        model: null,
        turns: 1,
        excerpt: "Synthetic inventory excerpt. ".repeat(140),
      })),
    };
  }
  const manifest = new TextEncoder().encode(
    JSON.stringify({ version: 2, roots: [{ id: "root", name: "benchmark" }], entries: [] }),
  );
  const hash = await sha256(manifest);
  const variants = [
    { name: "main_worker", combined: false, progress: false },
    { name: "progress_only", combined: false, progress: true },
    { name: "combined_poll_only", combined: true, progress: false },
    { name: "both_worker_changes", combined: true, progress: true },
  ];
  for (const variant of variants) {
    let worker: { token: string; attemptId: string } | undefined;
    // Only the scheduler's machine boundary is stubbed; never contact AWS/GitHub.
    globalThis.fetch = async (input, init) => {
      const request = new URL(String(input));
      if (request.origin !== "https://machine.invalid")
        throw new Error("Unexpected external request");
      if (request.pathname === "/v1/attempts") return Response.json([]);
      if (request.pathname.endsWith("/prepare")) return Response.json({ port: 20000 });
      if (init?.method === "PUT") {
        worker = JSON.parse(String(init.body));
        return Response.json({ id: `machine-${worker!.attemptId}` });
      }
      throw new Error("Unexpected machine operation");
    };
    const dbLayer = Layer.effect(RelayDb, PgDrizzle.makeWithDefaults()).pipe(
      Layer.provide(PgClient.layer({ url: Redacted.make(url), maxConnections: 4 })),
    );
    // Every variant uses the same current relay. Only the worker's request
    // sequence changes; improvements already merged in #71 are in the baseline.
    const selectedStore = storeLayer.pipe(Layer.provide(dbLayer));
    const instrumented = Layer.effect(CloudStore, Effect.map(CloudStore, measuredStore)).pipe(
      Layer.provide(selectedStore),
    );
    const runtime = ManagedRuntime.make(
      Layer.mergeAll(serviceLayer, workerLayer, schedulerLayer).pipe(
        Layer.provide([
          instrumented,
          Crypto.layer,
          Layer.succeed(CloudConfiguration, {
            enabled: true,
            allowedUserId: userId,
            controlUrl: "https://relay.invalid",
            encryptionKey,
            machine: { url: "https://machine.invalid", token: "b".repeat(64), ownerId: userId },
            github: { appId: "", privateKey: "", installationIds: [] },
            wake: () => (rtt ? Effect.sleep(rtt) : Effect.void),
          }),
          Layer.succeed(CloudArtifacts, {
            get: async () => manifest,
            head: async () => null,
            put: async () => {},
            delete: async () => {},
          }),
          Layer.succeed(CloudAuxiliary, {
            tick: () => Effect.void,
            publicRepository: () => Effect.die("Unexpected auxiliary work"),
            repositories: () => Effect.die("Unexpected auxiliary work"),
            login: () => Effect.die("Unexpected auxiliary work"),
            status: () => Effect.die("Unexpected auxiliary work"),
            bootstrap: () => Effect.die("Unexpected auxiliary work"),
            chunk: () => Effect.die("Unexpected auxiliary work"),
            callback: () => Effect.die("Unexpected auxiliary work"),
          }),
          Layer.succeed(ManagedEndpointProvider, {
            provision: () =>
              Effect.succeed({
                endpoint: {
                  httpBaseUrl: "https://worker.invalid",
                  wsBaseUrl: "wss://worker.invalid/ws",
                  providerKind: "cloudflare_tunnel" as const,
                },
                runtime: {
                  providerKind: "cloudflare_tunnel" as const,
                  connectorToken: "synthetic",
                  tunnelId: "test",
                  tunnelName: "test",
                },
              }),
            deprovision: () => Effect.void,
          }),
        ]),
      ),
    );
    try {
      const service = await runtime.runPromise(CloudService);
      const control = await runtime.runPromise(CloudWorkerControl);
      const scheduler = await runtime.runPromise(CloudScheduler);
      const runs = [];
      for (let sample = 0; sample < samples; sample++) {
        await pool.query(
          "INSERT INTO relay_cloud_accounts VALUES ($1, 1, $2) ON CONFLICT (user_id) DO UPDATE SET revision = 1, document = EXCLUDED.document",
          [userId, document],
        );
        metrics.queries = metrics.bytes = 0;
        const start = performance.now();
        const created = await runtime.runPromise(
          service.command(userId, {
            type: "task.create",
            idempotencyKey: `create-${sample}`,
            repositoryId: "local",
            baseBranch: "main",
            provider: "codex",
            kind: "ask",
            prompt: "Reply OK",
            issueNumber: null,
            source: { kind: "local", name: "Benchmark", snapshot: { id: hash, sha256: hash } },
          }),
        );
        const accepted = performance.now() - start;
        await runtime.runPromise(scheduler.tick(userId));
        const taskId = created.entityId;
        const token = worker!.token;
        const bootstrap = await runtime.runPromise(control.bootstrap(taskId, token));
        let sequence = bootstrap.attempt.lastSequence;
        const callback = (
          phase: "heartbeat" | "running",
          progress?: { phase?: string },
          idle = false,
        ) =>
          runtime.runPromise(
            service.callback(token, {
              taskId,
              attemptId: bootstrap.attempt.id,
              generation: bootstrap.attempt.generation,
              sequence: ++sequence,
              phase,
              detail: "",
              idle,
              ...(progress?.phase
                ? {
                    preparation: {
                      attemptId: bootstrap.attempt.id,
                      sequence,
                      phase: progress.phase as "ready",
                      startedAt: new Date().toISOString(),
                      updatedAt: new Date().toISOString(),
                    },
                  }
                : {}),
            }),
          );
        const reporter = createPreparationReporter((progress: { phase?: string }) =>
          callback("heartbeat", progress),
        );
        for (const phase of [
          "restoring",
          "restoring",
          "dependencies",
          "provider",
          "backend",
          "provider",
          "ready",
        ]) {
          if (variant.progress) reporter.report({ phase });
          else await callback("heartbeat", { phase });
          // Equal tiny fixture work in every variant; excludes real cloning,
          // installs, backend launch, provider validation and model inference.
          await NodeTimersPromises.setTimeout(10);
        }
        await runtime.runPromise(control.lease(taskId, token, bootstrap.attempt.id, "acquire"));
        await reporter.flush();
        await callback("running", undefined, true);
        const ready = performance.now() - start;
        const startupQueries = metrics.queries;
        const startupBytes = metrics.bytes;
        metrics.queries = metrics.bytes = 0;
        const sent = performance.now();
        await runtime.runPromise(
          service.command(userId, {
            type: "task.continue",
            taskId,
            idempotencyKey: "warm",
            prompt: "Reply OK",
          }),
        );
        const acknowledged = performance.now() - sent;
        // A fixed half-interval wait models discovery at the current 200 ms poll.
        await NodeTimersPromises.setTimeout(100);
        if (variant.combined) {
          const status = await runtime.runPromise(
            control.poll(
              taskId,
              token,
              bootstrap.attempt.id,
              bootstrap.task.turnRequestId ?? undefined,
            ),
          );
          if (!status.turnLease?.acquired) throw new Error("Turn was not admitted");
        } else {
          await runtime.runPromise(control.bootstrap(taskId, token));
          const lease = await runtime.runPromise(
            control.lease(taskId, token, bootstrap.attempt.id, "acquire", "warm"),
          );
          if (!lease.acquired) throw new Error("Turn was not admitted");
        }
        runs.push({
          accepted,
          ready,
          acknowledged,
          admitted: performance.now() - sent,
          startupQueries,
          startupBytes,
          warmQueries: metrics.queries,
          warmBytes: metrics.bytes,
        });
      }
      const result = {
        variant: variant.name,
        samples,
        startupAcceptedMs: summary(runs.map((r) => r.accepted)),
        startupControlMs: summary(runs.map((r) => r.ready)),
        warmAckMs: summary(runs.map((r) => r.acknowledged)),
        warmAdmissionMs: summary(runs.map((r) => r.admitted)),
        runs,
      };
      results.push(result);
      NodeProcess.stdout.write(JSON.stringify({ ...result, runs: undefined }) + "\n");
    } finally {
      await runtime.dispose();
    }
  }
  await NodeFSP.writeFile(
    output,
    JSON.stringify(
      {
        baseCommit: baseCommit.trim(),
        comparison:
          "Current relay in every variant; legacy worker requests versus worker follow-up",
        samples,
        databaseRttMs: rtt,
        bytesPerMs,
        fixtureBytes: size(document),
        lensConversations,
        scope:
          "Local PostgreSQL control-path benchmark with mocked infrastructure and optional modeled transport; excludes model/first-token and real workspace/backend startup",
        results,
      },
      null,
      2,
    ) + "\n",
  );
} finally {
  globalThis.fetch = originalFetch;
  await pool.query("DELETE FROM relay_cloud_accounts WHERE user_id = $1", [userId]).catch(() => {});
  await pool.end();
}
