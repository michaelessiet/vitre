# Vitre performance and RAM work

## Scope and status

Target: the native client plus local Node backend on a Raspberry Pi 4/5 with
2 GB RAM. Pi hardware, Linux renderer compatibility, and total tool workload
acceptance remain unverified. This implementation keeps Node and changes no
public schema. It does not promise support for arbitrary machines, repositories,
websites, providers, or language servers.

The working tree already contained substantial unrelated changes. Measurements
record its commit, status, and executable/bundle hashes; they are not a clean
before/after comparison against HEAD.

## Implemented

| Area                     | Change                                                                                                                                                                                                                                                                               | Limits / regression risk                                                                                                                                                                                                                |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Terminal                 | Feed output events directly into the VT parser. Reset only for snapshot, restart, or clear. Avoid retained-string clones and prefix reconciliation.                                                                                                                                  | Snapshot and reconnect tests preserve UTF-8 boundaries. Existing bounded VT scrollback remains.                                                                                                                                         |
| Conversation publication | Apply every event in each RPC batch, then ACK. Coalesce thread view publication at 16 ms and flush on stream end. Settled views share an `Arc`.                                                                                                                                      | Active overlays still materialize the history; this is not structural sharing of individual messages. No durable protocol events are dropped.                                                                                           |
| Stream animation         | Store reveal byte positions for actively streaming messages only.                                                                                                                                                                                                                    | Unicode boundaries are checked; completed message strings are not duplicated in the animation map.                                                                                                                                      |
| Markdown                 | LRU eviction at 128 entries / 8 MiB source text.                                                                                                                                                                                                                                     | Soft limits: recent viewport entries and selected text remain pinned. Parsed layout memory is larger than source bytes. History remains accessible and still resides in the thread.                                                     |
| Images                   | 1024-pixel chat thumbnails, 4096-pixel detail on demand, direct RGBA-to-BGRA conversion, one concurrent chat load/decode, 32-entry / 64 MiB decoded pixel cache. Sign attachment URLs only as rows render.                                                                           | Cache limits are soft for recently rendered assets. Decoder scratch space and GPU storage are additional; full source decoding still precedes resizing. Explorer previews use direct conversion but do not share the chat cache budget. |
| Editor gutter            | Diff on a background executor using a shared baseline; reject stale generations/revisions; only one worker per panel and one pending refresh.                                                                                                                                        | Full document text is still materialized on the worker. LSP remains debounced full-document synchronization.                                                                                                                            |
| Node startup             | Start sidecar before native font/theme setup; async login-shell PATH discovery with a five-minute cache; stdout readiness signal with HTTP fallback; move graph sweep/rebuild starts after command readiness; load independent initial configuration reads with bounded concurrency. | Cold PATH discovery still waits for correctness. Indirectly sourced shell changes may remain cached for five minutes. HTTP fallback retains the existing listener-readiness semantics. Other service layers still initialize eagerly.   |

The PATH cache is local to desktop backend state, keyed by platform, shell,
inherited PATH, home/ZDOTDIR and shell configuration file metadata. Missing,
expired, malformed, and unwritable caches fall back to discovery. It does not
cache failed discovery. Newline-free child log output is forwarded in bounded
chunks so readiness scanning cannot accumulate an unbounded log string.

## Platform capabilities

`crates/vitre-app/src/platform_capabilities.rs` is the capability gate. UI
controls, browser offers, automation registration and advertised operations use
it. Unsupported restored panels show an explanation; direct unsupported actions
fail explicitly.

| Native feature                   | macOS                   | Windows                 | Linux / Raspberry Pi                    |
| -------------------------------- | ----------------------- | ----------------------- | --------------------------------------- |
| Embedded browser                 | Implemented             | Implemented             | Unavailable; gated                      |
| Browser snapshot / GIF recording | Implemented             | Unavailable; gated      | Unavailable; gated                      |
| Chat, editor, terminals          | Existing implementation | Existing implementation | Hardware/renderer acceptance not tested |

This is an implementation capability matrix, not a claim that each platform was
built or tested in this audit. Linux browser porting remains separate work.

## Reproduce measurements

Build the backend with `vp pack` from `apps/server`, then from the repository root:

```sh
cargo build -p vitre-app --release
python3 scripts/vitre/measure-resources.py --output /tmp/vitre-performance/idle.json
cargo run --release -p vitre-state --example performance > /tmp/vitre-performance/micro.json
```

The resource runner launches three isolated disposable homes, waits for backend
readiness, then samples five minutes per run. It records process groups, RSS,
one-core CPU percentage, and Linux PSS where readable. Startup logs separately
report backend launch-to-ready and client-start-to-shell-snapshot timings; these
have different start points and should not simply be added. The shell timing
excludes some native startup and is not a measured first-paint latency.

macOS RSS sums double-count shared pages. GPU allocations and subprocesses
reparented outside the tree are not attributed. Node-based providers/LSPs are
included in the Node group if present. Use a quiet host for acceptance runs;
compilation or other verification can distort startup and peak values.

The microbenchmark repeats three times with 100 / 1,000 / 10,000-message
histories. It compares owned versus shared settled snapshots, per-event versus
synthetic 16-event streaming batches, and old terminal reconciliation versus
direct playback for ANSI/Unicode output exceeding 512 KiB repeatedly. It asserts
that the final streamed text is unchanged. Terminal timings exclude actual VT
parsing and painting; synthetic batch sizes do not predict real UI frame rates.

## Measurements collected on this host

Host: Apple M5 Max, 64 GiB RAM, arm64, macOS 27.0.1. This is substantially more
capable hardware than the Pi target. Background builds and native checks ran
alongside parts of the collection; treat timings and peaks as exploratory.

[Three five-minute idle runs](vitre-performance-idle.json):

| Run | Settled tree RSS (MiB) | Peak tree RSS (MiB) | Settled CPU, one core | Backend launch-to-ready (ms) |
| --- | ---------------------- | ------------------- | --------------------- | ---------------------------- |
| 1   | 346.8                  | 745.2               | 0.81%                 | 2782                         |
| 2   | 337.5                  | 772.8               | 0.98%                 | 2265                         |
| 3   | 332.0                  | 656.8               | 1.58%                 | 2365                         |

Settled values are means of the last 60 samples. Peaks include transient child
processes. The measured release precedes the final gutter single-worker and log
buffer refinements; the recorded hashes identify exactly which binary was run.
Raw samples and startup logs are in `/tmp/vitre-performance/idle.*` on this host.
No baseline was collected, so these values do not quantify total RAM savings.

[Microbenchmark raw results](vitre-performance-micro.json) show:

- 3.25 MiB of terminal output results in 3.25 MiB of direct parser input versus
  217.50 MiB with retained-buffer reconciliation. This is a byte-volume result,
  not a measured parser/frame speedup.
- At 10,000 messages, 256 synthetic deltas took 148–158 ms with per-item view
  materialization versus 10.8–12.4 ms with sixteen-event batches. Both paths
  produce the same final text. Actual batches depend on arrival rate.
- One hundred settled 10,000-message owned snapshots took 55–57 ms, versus
  approximately 4 microseconds sharing snapshots. This excludes UI merging and
  timeline/layout work.

Focused checks include projection ordering/UTF-16/reconnect tests, terminal
reducers and native terminal unit tests, image HTTP/data-URL/thumbnail/conversion
tests, capability gates, backend startup/cache tests, TypeScript checking and
lint, Rust app checking, and debug/release builds. The live client smoke test
passed shell sync, thread creation and subsequent events. The native Markdown
pass verified scrolling, retained parsed state and stable row heights. Native
image interaction verification was attempted in disposable homes but did not
reach its assertions before timeout; thumbnails/lightbox navigation are not
certified by that pass. Decoding unit tests passed. Debug and release builds
were rerun after the final source changes.

## Acceptance work and sequenced backlog

| Order | Remaining work                                                                                                                                                                                                 | Evidence / confidence                                                                                                                                            | Effort and risk                                              |
| ----- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------ |
| 1     | Profile active long-history streaming and adopt message-level shared data if history copying dominates.                                                                                                        | Copy remains in `shared_view` with active overlays; high confidence. Synthetic streaming results quantify publication savings only.                              | Medium–high; selection and event-order regression risk.      |
| 2     | Complete native workload measurements: scrolling, 100 KiB/1 MiB edits with LSP, large images, repeated browser/workspace open-close. Capture CPU, peak/settled memory, p95 frames, input latency and plateaus. | Empty idle and microbenchmarks cannot establish these budgets.                                                                                                   | Medium; requires controlled fixtures and platform tooling.   |
| 3     | Measure subscription queue depth/bytes and consumer lag under slow-consumer/reconnect stress. Add backpressure only where growth is demonstrated.                                                              | RPC acknowledgements already pace subscriptions. Unbounded queues are a risk, not a demonstrated leak. Live subscription smoke test is not a stress measurement. | Medium; high correctness risk if durable events are dropped. |
| 4     | Profile remaining Node startup layers and provider/config discovery.                                                                                                                                           | Measured startup is still seconds, not near-instant. No startup before/after baseline exists.                                                                    | Medium; defer only work that commands do not require.        |
| 5     | Design backward-compatible paged history.                                                                                                                                                                      | Entire thread detail is still loaded; high confidence.                                                                                                           | High; protocol, selection/search and reconnect semantics.    |
| 6     | Measure LSP full-text serialization; design incremental sync if justified.                                                                                                                                     | Full-document work still exists; impact unmeasured.                                                                                                              | Medium–high; server sync capability handling.                |
| 7     | Validate Pi GPU/GPUI, packaging, process-tree PSS and external tools on actual hardware.                                                                                                                       | No Pi available.                                                                                                                                                 | High; platform and driver dependent.                         |

Acceptance targets remain: UI+backend at most 350 MiB settled idle / 600 MiB
chat-editor workload; a defined provider+LSP+terminal+lightweight-preview tree at
most 1.2 GiB PSS; idle CPU below 2% of one core; p95 frames at most 33 ms and input
response at most 100 ms. Repeated resource cycles must plateau, with no lost
events, unexpected terminal resets or broken selections. None of the combined
workload or Pi targets is certified by the Mac idle measurements.

## Follow-up startup profiling

The previously reported 2–3 second backend readiness includes a native readiness
probe timeout. It is not all Node initialization. See
[the per-run phase measurements](vitre-startup-profile.json).

Six instrumented launches used the normal application state without removing
caches. The first four used the release native executable; two diagnostic runs
used a debug native executable with opt-in probe timing. The backend was a
temporary copy of the current bundle with phase markers and V8 CPU profiling.
The original server bundle was not edited. Profile logs and CPU profiles are
under `/tmp/vitre-startup-profile/`; the temporary harness is
`/tmp/profile-vitre-startup.py`. All profiling app instances were stopped.

The first three release runs separated these costs:

| Stage                                                            | Observed duration                                        |
| ---------------------------------------------------------------- | -------------------------------------------------------- |
| Node preload reached                                             | 18–21 ms of Node process uptime                          |
| Dependencies loaded and parsed before bundle evaluation          | 258–294 ms                                               |
| Bundle top-level evaluation                                      | 108–117 ms                                               |
| PATH hydration                                                   | Approximately 1 ms in two runs; 447 ms in the slower run |
| Remaining service initialization through command-ready/listening | 108–118 ms                                               |
| Node command-ready/listening, from Node process start            | 518–952 ms                                               |
| First initial-config editor discovery                            | 25–28 ms                                                 |

The slowest and most actionable delay occurs **after** the backend is ready.
`wait_until_ready` performs a blocking HTTP probe with a 1,500 ms read timeout.
The Node HTTP server binds its socket while its layer is acquired, before
`HttpRouter.serve` installs its request handler. The probe can arrive in that
interval. The final diagnostic run observed **zero request listeners** when
`/.well-known/t3/environment` arrived; subsequent auth and shell requests had
one listener. The early request never received a response. The native thread
remained inside its blocking read even after its separate stdout reader had
received `VITRE_BACKEND_READY_V1`.

In diagnostic run 5, Node reached readiness at 508 ms of process uptime, the
HTTP probe took 1,501 ms and failed, and the native supervisor reported readiness
at 1,917 ms from its launch timer. These clocks have different origins, but
HTTP event timestamps and the stdout-receipt log independently demonstrate the
wait. Run 6 confirmed the zero-listener race. Authentication and the shell HTTP
snapshot completed in milliseconds to tens of milliseconds after this wait;
no selected-thread snapshot or first-paint timing was captured.

V8 samples put approximately 89–99 ms of the first second in module compilation,
with additional dependency evaluation, schema construction and garbage
collection costs. Approximately 450–477 ms of that sampled first second was
idle. The first profiled launch also had an unexplained approximately 1.6-second
interval before the Node preload hook; repeat launches did not reproduce that
interval. Do not attribute this outlier to Node module initialization.

The readiness fix now allows the stdout signal to interrupt an in-flight HTTP
probe. Socket reads check the signal every 20 ms while retaining the 1,500 ms
HTTP fallback response budget for older backends. The probe also accumulates
split HTTP status lines and respects the overall startup deadline. Backend
HTTP readiness is now marked only after `HttpRouter.serve` has installed its
request handlers, using sequential layer completion rather than a parallel
socket-listening check.

Four focused Rust readiness tests pass, including a stalled HTTP connection
interrupted by a stdout marker, delayed/split HTTP fallback responses, and the
startup deadline. Eleven backend startup tests pass, including delayed and
failed request-handler installation. Targeted lint, formatting, and server
TypeScript checks pass. The live native client smoke test passes shell sync,
thread creation and later detail events. Optional `VITRE_PROFILE` diagnostics
remain available to distinguish probe waiting from backend initialization.

Rust could reduce the approximately 0.4 seconds of JavaScript loading/evaluation,
but a backend rewrite alone would not fix the native probe timeout.

### Release measurements after the readiness fix

[Three launch results and build hashes](vitre-startup-fixed.json), using the
normal application home and production bundle, without V8 CPU profiling:

| Run      | Backend launch-to-ready | Client start-to-shell snapshot | App process launch-to-ready signal |
| -------- | ----------------------- | ------------------------------ | ---------------------------------- |
| First    | 983 ms                  | 972 ms                         | 1,926 ms                           |
| Repeat 1 | 503 ms                  | 481 ms                         | 495 ms                             |
| Repeat 2 | 503 ms                  | 476 ms                         | 506 ms                             |

The in-flight probe waits were 42–83 ms, interrupted by readiness; none waited
for the old 1,500 ms timeout. These are waits that overlap backend initialization,
not additional latency after readiness. The first launch retains approximately
one second of overhead before the backend launch timer; its source has not been
attributed. Repeat launches reached readiness in about half a second. Client
snapshot timings use a separate origin and are not first-paint measurements.
All test instances were stopped after collection. The current release executable
and backend bundle include the fix.
