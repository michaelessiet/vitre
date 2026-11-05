# Cloud worker latency follow-up — 2026-11-05

The benchmarks in this follow-up were collected against `main` at `882f9e3af4da7f9fa4e41c6bef2725b4165deeb6`. [PR #71](https://github.com/michaelessiet/vitre/pull/71) already merged compact account reads/writes, the combined poll/lease API, fewer scheduler wakeups, and combined startup prerequisite persistence. Those improvements are part of every variant's baseline below; this follow-up does not change the relay implementation.

For publication, the worker changes were applied to `main` at `90d255c3`, preserving the subsequently merged conversation recovery and agent PR-publication changes. The focused checks were repeated on that base; the benchmark samples below were not rerun.

The remaining changes connect the worker to the combined poll API and coalesce startup progress reports. **Production readiness within 10 seconds and near-local first-token latency remain unverified.** No production deployment or live conversation benchmark was performed for this follow-up.

## Worker changes

- Discover pending turns and receive their provider lease in one authenticated poll, including the current attempt ID and last durably submitted turn ID. Use the grant for that exact turn instead of making another lease request. Existing dispatch-intent journaling remains in place.
- Keep a retained provider session's rotated credential. Install a granted credential only when acquiring ownership, and preserve stop/persist/release ordering when admission is denied.
- Retry transient poll failures on the same endpoint. Fall back to the legacy bootstrap/lease sequence only after HTTP 404, and remember that fallback for the worker process. Authentication errors and ambiguous failures do not trigger fallback.
- Allow one preparation progress request in flight and one merged pending update. Workspace/backend preparation continues while progress is sent. Drain the pending updates before publishing running state and during failure/teardown; preserve dependency warnings and surface the final failed report when flushing.

## Comparison against current main

Both runs use real local PostgreSQL 15.19 and the same 1,332,862-byte synthetic account, including retained history and 100 Lens inventory entries. Infrastructure and provider execution are mocked. The benchmark varies only the worker request sequence and preparation reporting; every variant uses the current relay services.

### Modeled database transport

Five runs per variant. The transport model adds 50 ms per estimated database round trip, JSON transfer at 2.5 MB/s, and 50 ms per scheduler wake. It injects delays around real SQL operations rather than shaping a real network. [Raw samples](cloud-latency-followup-transport.json).

| Variant                  | Startup control, median / p95 | Warm acknowledgement, median / p95 | Warm admission, median / p95 |
| ------------------------ | ----------------------------: | ---------------------------------: | ---------------------------: |
| Current main worker      |             11.579 / 12.124 s |                    0.134 / 0.148 s |              0.970 / 0.976 s |
| Progress coalescing only |               5.033 / 5.349 s |                    0.132 / 0.143 s |              0.948 / 1.238 s |
| Combined polling only    |             11.803 / 11.879 s |                    0.133 / 0.232 s |              0.720 / 1.031 s |
| Both worker changes      |               5.022 / 5.376 s |                    0.132 / 0.179 s |              0.747 / 1.021 s |

Together, the worker changes reduced median measured startup control time by **57%** and warm admission time by **23%** in this model. Progress coalescing targets startup; combined polling targets warm-turn admission. Acknowledgement differences are measurement variation: all variants use the same already-optimized command service.

The combined warm-admission maximum/p95 was 1.021 seconds versus 0.976 seconds for the baseline. The median improved, but these samples do not demonstrate better tail latency or meet a strict one-second p95 threshold.

These startup control stages fit within 10 seconds with progress coalescing in this experiment. They exclude substantial real startup work, so this is not a demonstrated end-to-end 10-second startup. Likewise, warm admission is not an assistant reply or first-token measurement. Five-sample p95 is the maximum observed sample, not a reliable production tail estimate.

### Local database without added transport delay

Ten runs per variant, run separately from the transport experiment and other verification commands. [Raw samples](cloud-latency-followup-local.json).

| Variant                  | Startup control, median / p95 | Warm acknowledgement, median / p95 | Warm admission, median / p95 |
| ------------------------ | ----------------------------: | ---------------------------------: | ---------------------------: |
| Current main worker      |               1.251 / 1.801 s |                    0.030 / 0.238 s |              0.192 / 0.568 s |
| Progress coalescing only |               0.931 / 1.130 s |                    0.040 / 0.214 s |              0.182 / 0.634 s |
| Combined polling only    |               1.239 / 1.379 s |                    0.034 / 0.191 s |              0.184 / 0.585 s |
| Both worker changes      |               0.786 / 1.038 s |                    0.030 / 0.213 s |              0.172 / 0.584 s |

The sandbox is shared infrastructure; timing variation can still affect these runs. The model's estimated database query count for a warm turn falls from five to four. Coalescing skips intermediate progress callbacks, so its startup query count depends on how many phases finish while a report is in flight.

## What is measured

`startupControlMs` includes command acceptance, scheduling, worker bootstrap, seven representative preparation updates, initial lease acquisition, and the running callback. Each synthetic preparation stage performs 10 ms of fixture work. It excludes actual workspace capture/upload/restore, dependency installation, DNS/tunnel readiness, backend launch, provider validation, and model execution.

`warmAckMs` measures acceptance of a text follow-up. `warmAdmissionMs` adds a fixed 100 ms discovery wait (half of the resident worker's 200 ms polling interval) and lease admission. It excludes client/relay HTTP transport, authentication middleware, transcript mirroring, actual backend dispatch, and model/first-token latency. The runner calls the real control services directly, rather than executing the full worker or an AWS machine.

There are no competing conversations in these timing runs. SQL count and payload estimates assume no revision conflicts and are not packet captures. The transport model does not simulate packet loss, pool saturation, or contention. A persistent local PostgreSQL pool is used, rather than Cloudflare's request pools. All variants run sequentially in a fixed order; small timing differences should not be treated as precise rankings.

## Verification

- **98 focused tests passed** across the worker and relay service suites on the benchmark base plus this follow-up. **99 tests passed** when those suites were repeated on publication base `90d255c3`. These cover progress coalescing/failure draining, exact-turn grants, retained credentials, FIFO admission, cancellation, attempt/token fencing, HTTP 404 compatibility, and recovery from a lost poll response without an extra lease request.
- Scoped relay type checking, changed-file lint/format checks, worker syntax checking, and `git diff --check` passed. The workspace dependencies were synchronized with main's frozen lockfile before the final type check; no dependency version or lockfile is changed by this follow-up.
- Both benchmark runs completed against disposable PostgreSQL. Each run removes its own synthetic account; the temporary server was stopped after verification.
- No frontend/native UI changes or full-workspace test run. Production latency is not validated by these checks.

## Reproduce

Start a disposable local PostgreSQL server and create a database named `vitre_store`. The runner rejects any host other than `127.0.0.1` and any other database name. It never contacts AWS, GitHub, a model provider, or the deployed relay. From the repository root:

```sh
VITRE_STORE_TEST_DATABASE_URL=postgresql://vitre@127.0.0.1:55432/vitre_store \
VITRE_BENCH_SAMPLES=10 \
VITRE_BENCH_LENS_CONVERSATIONS=100 \
VITRE_BENCH_OUTPUT=/tmp/cloud-latency-followup-local.json \
node infra/relay/scripts/benchmark-latency.ts
```

For the transport experiment, use `VITRE_BENCH_SAMPLES=5`, add `VITRE_BENCH_DB_RTT_MS=50` and `VITRE_BENCH_DB_BYTES_PER_MS=2500`, and choose a different output path. `baseCommit` in each output identifies the checked-out base; all relay behavior comes from the current working tree.

Focused checks:

```sh
vp test run scripts/vitre/cloud/worker.test.mjs infra/relay/src/cloud/service.test.ts
vp exec tsgo --noEmit -p infra/relay/tsconfig.json
vp lint scripts/vitre/cloud/worker.mjs scripts/vitre/cloud/worker.test.mjs \
  scripts/vitre/cloud/worker.d.mts infra/relay/scripts/benchmark-latency.ts
node --check scripts/vitre/cloud/worker.mjs
```

## Earlier investigation

The original November 4 experiment compared baseline `9c6fe164` with the combined relay and worker changes. Its raw results remain available: [local database](cloud-latency-local.json), [modeled transport with history](cloud-latency-transport.json), and [modeled transport with history plus Lens](cloud-latency-mixed.json).

Those older results include relay improvements now merged in #71 and must not be attributed solely to this worker follow-up. That runner loaded four baseline relay modules from git; the updated runner instead keeps the current relay fixed across all variants. The old and new runs also occurred in separate sandbox sessions. Use the current-main comparison above to assess the incremental change.

## Rollout and remaining proof

Use a relay version containing #71's poll endpoint before rolling out the updated worker runtime. Existing worker processes need the normal runtime rollout/restart to adopt it. The 404 fallback permits mixed versions, and no database migration is required. This follow-up has not been deployed.

After deployment, verify cloud creation, warm follow-up, recovery, cancellation, and local/cloud handoff with the existing opt-in live tests. Their polling observations establish correctness but are too coarse for first-token timing.

For performance acceptance, timestamp Send, durable acknowledgement, workspace/backend readiness, worker dispatch, and the first streamed assistant delta. Compare at least 20 local/cloud pairs with the same provider, model, reasoning settings, prompt, and context. Separate prepared projects, cold projects, and competing conversations. Require prepared readiness p95 ≤10 seconds and additional warm dispatch overhead p95 ≤1 second; compare model first-token latency separately to local.

The shared account revision, full history/mirror writes, workspace restore, and backend/provider startup can still dominate production latency. Further changes should follow those live phase measurements.
