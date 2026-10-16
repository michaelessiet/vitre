# Unified local and cloud conversations in Vitre

## Conversation identity and UI

The composer popup beside reasoning chooses Local, Cloud: GitHub or Cloud: Local. New
conversations begin locally unless explicitly selected otherwise; sending a cloud
draft starts provisioning. Existing conversations request a durable handoff.
`chat/cloud_thread.rs` maps the stable local conversation identity to the active
cloud task, retaining `cloud-<id>` aliases. The sidebar suppresses inactive aliases.
The mirrored/live cloud feed renders through the ordinary conversation UI.

Model, runtime and interaction settings are preserved. Files, search, Git,
terminals and language services use the active environment client and registered
workspace roots. Disconnection never falls back to the desktop filesystem.
Remote image previews use bounded authenticated asset reads. Browser previews use
an authenticated WebSocket-to-loopback TCP tunnel and a desktop loopback listener;
terminal-operate scope is required, and the backend's own port is excluded.

## Durable handoff

`HandoffService.ts` journals switches in SQLite. `handoffCoordinator.ts` advances
wait → prepare → checkpoint → transfer → verify → activate → release. Side effects
use stable operation keys. The relay stores authoritative ownership generations;
`executionOwnership.ts` fences agent and metadata commands inside the engine's
serialized SQL transaction. Provider-account leases transfer atomically with
ownership. Prepared workers cannot start an agent turn before activation.

A pending turn, approval or question remains in the existing conversation until
settled. Editor buffers save before capture. Captures and source verification
reject concurrent filesystem changes. Cancellation consults authoritative
ownership before thawing the source. Persisted journals resume after restart;
ambiguous requests reuse their original IDs. The selector polls status and shows
progress, cancellation and recoverable errors.

Cloud tasks retain their machine workers between turns and recover from checkpoints
after a stopped attempt without replaying a prompt. Cloud-to-cloud moves transfer the current snapshot,
including unpublished work. Returning locally prepares a separate managed
workspace, using the original baseline, current local files and cloud files for a
three-way merge. Conflicts preserve cloud ownership and open private resolution
files in the existing editor. Clean results activate by directory rename. Saved
root identities prevent a returned conversation from inheriting another
conversation's original additional roots.

## Portable state

`workspace.mjs` transfers content-addressed chunks with hashes, resumable uploads,
binary files, executable modes and safe internal symlinks. It respects ignore files
and `.vitreignore`, excludes dependency caches and known credential paths, and
rejects Git histories containing known credential filenames. It is not an
arbitrary secret-content scanner. Git bundles and index patches preserve local
commits and staged changes without machine-specific worktree pointers or
credential configuration. GitHub restores the exact published base and overlays
unpublished state; no automatic push occurs. Local snapshots also support non-Git
projects and additional roots.

Conversation payloads include history, model/runtime settings, attachments and
terminal output with root-relative working directories. Provider sessions use
checkpointed native state where available and normalized conversation context
otherwise. Checkpoint v2 includes all roots and remains compatible with older
archives. Unsent draft state stays in the desktop's persisted conversation draft.

Terminal shells reopen against mapped roots. Explicit app-managed commands are
marked at terminal write time; ordinary terminal input clears that marker. Only
active app-managed commands are eligible for restart after activation. Restart
intent is recorded before writing to the PTY to prevent duplicate command replay
following an ambiguous crash. Arbitrary operating-system processes do not migrate.

## Runtime publishing and verification

AWS persistent machines, the existing relay and R2 artifact infrastructure are in use.
`publish-runtime.mjs` publishes immutable objects using S3 multipart uploads and
verifies the entire downloaded SHA-256 before reporting success. Set
`VITRE_CLOUD_REQUIRE_EXISTING_STACK=true` when deploying the runtime reference;
the deployment rejects replacement stacks and signing identities.

Focused automated tests cover ownership fencing, restart/cancellation paths,
conflicts and managed workspace isolation, attachments, worker/checkpoint behavior,
provider leases, terminal transfer and preview authentication. The opt-in native
pass uses `VITRE_VERIFY_CLOUD_THREADS=1` and a disposable `VITRE_HOME`, then exits
and stops its sidecar. `HandoffService.live.test.ts` is opt-in with
`VITRE_LIVE_HANDOFF=1` and `VITRE_LIVE_CREDENTIAL_FILE`; it uses a connected provider
and paid disposable cloud task, returns the generated file and conversation, and
deletes the task. Ordinary test runs skip this live test.

The recovered stash `7ba3ef71f` remains intact; implementation is isolated on
`feat/seamless-cloud`. Runtime release evidence is recorded after live verification.

### Runtime published on 2026-10-14

This historical release used a retired compute provider. Its runtime is not an
AWS installation artifact; use the persistent-machine exporter below.

The multipart publisher verified all 427,075,038 downloaded bytes. The personal
relay applied an API update with the existing stack and signing key unchanged.
A disposable legacy worker verified the archive, performed an unprivileged GitHub clone,
and returned a local folder with binary data and attachments; it was deleted.

Live verification uncovered and fixed two issues that mocked transport tests had
missed: recently imported messages looked like pending turns, and stopped workers
retained all managed endpoint slots. Imported history is now excluded from queued
turn detection; a known busy freeze rejection can retry with a fresh receipt,
while ambiguous responses retain their original idempotency key. Endpoint capacity
is reserved before paid compute starts, and stopped-worker endpoints are released
through serialized cleanup operations without removing conversation checkpoints.

A subsequent live run exposed root-owned app-data parent directories during a
fresh worker startup. The worker now assigns the complete app-data tree to its
unprivileged backend account. The Linux verification checks both parent access
and root-identity reads as that account. A separate local Linux check started the
actual packaged backend, authenticated and read its orchestration snapshot. Failed
destination preparation now surfaces its recorded error without activating cloud
ownership. Focused tests exercise failure followed by recovery in the same handoff.

Before accepting a cloud destination, the packaged backend refreshes the selected
provider's account/model catalog and validates the exact model and option values.
The worker checks this before starting a new task; the handoff coordinator checks
it before ownership activation. Unsupported choices produce an error rather than
substituting a provider, model or option. Claude's canonical `claudeAgent` desktop
instance maps to the existing `claude` cloud account and back to `claudeAgent` in
the worker. The live fixture uses the repository's current default model instead
of a hard-coded retired model.

The real provider run also exposed a projection bug: session completion cleared
`latestTurnId`, leaving non-Git conversations without a completed-turn record
because they emit no later Git checkpoint. Session updates now preserve the last
turn reference while clearing only the active session turn. A regression test
reproduced the failure before the fix; all 25 projection tests and both handoff
integration cases pass afterward.

### Final verification on 2026-10-14

- The opt-in live handoff test passed in 197 seconds against the deployed runtime,
  using Codex with `gpt-5.6-sol`. It moved an existing non-Git conversation to Cloud:
  Local, ran a real provider turn that created `cloud-proof.txt`, and returned
  locally. Assertions verified the exact file contents, an independent local edit,
  history without duplicated seed messages, and active local execution ownership.
- The test deleted its disposable task. A separate legacy-provider lookup confirmed its
  worker was gone (HTTP 404). Earlier failed verification workers were also deleted.
- The exact published archive passed an unprivileged GitHub clone, a local-folder
  round trip, binary/attachment integrity checks, and backend-home access checks
  in a disposable legacy worker. That worker was deleted too. The multipart publisher's
  full download checksum verification passed on retry after a connection abort.
- The integrated native Vitre pass succeeded with isolated local state, including
  stable sidebar identity, draft attachments, active-environment tools, disconnect
  fencing, and return to the local conversation. The app and sidecar exited.
- Focused backend/native tests, targeted server type checking, lint, Rust checking,
  Clippy, formatting, and diff-whitespace checks passed. No full workspace suite
  was run. Claude compatibility is covered by focused mapping/preflight tests;
  the connected account used for the paid live run was Codex.

Changes remain in the isolated `feat/seamless-cloud` worktree; the original stash
and the original checkout's unrelated changes are preserved.

Desktop sidecars share only the cloud OAuth credential through
`VITRE_CLOUD_SHARED_AUTH_DIR` (default `~/.vitre/userdata/secrets`). Other secrets
and project state remain scoped to each instance. Cross-process file locks serialize
login, refresh, store and sign-out. Verification instances retain isolated credentials.

The flow-fixes runtime was multipart-published and its downloaded checksum verified.
A disposable legacy worker passed the unprivileged GitHub clone and local-folder return
checks and was deleted. The existing personal relay stack was updated in place.
Shared-login tests cover persistence across separate homes, isolation of other
secrets, concurrent login locking, failure cleanup and cancellation. Native checks
cover popup selection and composer placement; the integrated native pass succeeded.

## Provider-independent persistent machines

The execution boundary is `infra/relay/src/cloud/compute.ts`. `ComputeExecutor`
starts and stops attempts; `MachineProvisioner` describes the separate, administrative
creation/resizing/destruction of a user's machine. The execution path never calls
machine destruction. No AWS, DigitalOcean or other hosting SDK is required.

The first implementation connects an **existing Linux machine**. The current personal
relay binds it to `VITRE_CLOUD_ALLOWED_USER_ID`; this is not a multi-tenant assignment
registry. Each host validates both the account identity and its machine credential.
Future provisioners must reconcile by stable machine identity, not task identity.

`machine-agent.mjs` stays running under systemd. An operator installs a pinned runtime
filesystem once. Workers run as local, isolated processes using that filesystem,
without downloading/extracting a runtime or starting another VM/container per task.
Each conversation has persistent workspace/home/state directories and retains a
unique backend port across attempts. The scheduler configures the existing tunnel with
that port. PID/mount isolation prevents a worker from accessing the machine agent's
credentials or another conversation's filesystem. Host metadata addresses are denied
by the attempt's systemd service. Provider processes still run as unprivileged users.

Receipts are synced before process launch. Retries and daemon restarts do not replay
an attempt. A new attempt for the same conversation requires confirmed termination
of the previous one. Stopping/deleting an attempt kills its entire systemd control
group, but preserves the machine and conversation disk. Workspace retirement is an
explicit administrative operation; current task deletion does not erase retained
machine directories. Host disk capacity therefore needs operational monitoring.

### Install and assign a host

Supported initial target: Linux amd64, Debian 12/Ubuntu 24.04 or newer, systemd,
root installation access, and kernel support for bubblewrap namespaces. The host
must reserve ports 20000–59999 for conversation backends. The agent binds only
127.0.0.1:9077; expose it through an authenticated HTTPS tunnel/reverse proxy.

1. Build the existing cloud Dockerfile with explicitly pinned provider CLI versions.
   It includes the machine agent and current worker scripts. Docker is a build/export
   tool, not a requirement on the user's cloud host.
2. Export the image with `node scripts/vitre/cloud/export-machine-runtime.mjs IMAGE ROOTFS.tar`.
   Transfer the archive and verify its printed SHA256 on the host.
3. Create root-only `/etc/vitre-machine.env` containing `VITRE_MACHINE_OWNER`,
   `VITRE_MACHINE_TOKEN` (a fresh random secret of at least 32 characters), and
   `VITRE_MACHINE_CONTROL_URL` (the exact relay HTTPS origin). Do not bake this
   credential into the runtime image or supply cloud-provider admin credentials to workers.
4. Run `scripts/vitre/cloud/install-machine.sh ROOTFS.tar SHA256` as root.
   The installer rejects overwriting an existing runtime; updates require draining
   active attempts and installing a versioned replacement.
5. Configure a permanent HTTPS endpoint for the loopback agent. Verify authenticated
   `/v1/health` before assigning the machine.
6. Drain old provisioning operations, then set `VITRE_CLOUD_MACHINE_URL` and
   `VITRE_CLOUD_MACHINE_TOKEN` on the existing personal relay. Preserve its deployment
   identity. AWS is the only execution provider; missing machine configuration
   fails closed. Ambiguous machine failures never automatically provision a
   second machine. Do not remove machine configuration
   while machine-backed attempts still need cleanup.

The VM stays billable while idle. Existing relay usage figures are legacy task-compute
estimates, **not the hosting provider's VM bill or a host spending cap**. Accurate host
billing/limits and automatic provider provisioning are separate follow-up integrations;
this opt-in execution path does not claim to implement them.

Verification: focused relay/agent/worker tests cover ownership, repeated requests,
restart receipts, stop failure, retained workspace files, allocated ports and
rejection of unassigned or unsupported compute. A disposable Linux sandbox check exercised the installed runtime,
unprivileged writable workspace/home, and host-file isolation.

On 2026-10-14, a disposable Ubuntu 22.04 `t3.small` in AWS `eu-north-1`
passed a real installation and `verify-machine-systemd.mjs`: authenticated access,
systemd worker startup/stop, host filesystem and credential isolation, blocked EC2
metadata access, repeated-request idempotency across agent restart, exclusive
conversation ownership, and workspace/home retention across attempts. After an EC2
reboot, the installed agent recovered automatically and the same verification passed
again. The host had encrypted EBS, required IMDSv2, no inbound security-group rules,
and SSM-only management. The disposable instance and its test IAM/security-group
resources were removed after verification.

Repeat only on a disposable host with the runtime installed:

```sh
sudo VITRE_VERIFY_MACHINE_SYSTEMD=1 /opt/vitre-machine/rootfs/usr/local/bin/node \
  /path/to/verify-machine-systemd.mjs
```

The verifier substitutes a fixture worker in a separate hard-linked rootfs copy; it
does not run a provider conversation. The later round-trip verification below runs
real provider conversations. The installed Vitre app was not changed by these tests.

Base artifact from the initial infrastructure-only verification: `https://artifacts.usevitre.app/vitre-machine-aws-20261014.tar.gz`
(664554332 bytes), SHA256
`3146066deff72c035f88b58fadfa6df216639dfdf06122bc6174cbdd45f0acfa`.
Decompress before using `install-machine.sh`; the tar SHA256 is
`4d6c38ed745d1143bfe8a051e39c149a1195fdefa57da51a1092c3c26024fdc4`.
The verifier was added after this artifact was built; copy it separately.

### AWS relay round-trip verification (2026-10-15)

Two clean-start live cases passed through the existing personal relay and an AWS
`eu-north-1` Ubuntu `t3.small`, using the connected Codex account. Each asserted a
`machine-` sandbox ID, verifying that the expected AWS machine executed the work. This
verification moved an existing local conversation to cloud, ran a real provider
turn creating `cloud-proof.txt`, and returned locally with that edit, an independent
local edit, binary bytes, baseline content, unduplicated history, and active local
execution ownership intact. The GitHub case additionally preserved an unpublished
commit SHA and distinct staged/unstaged content. Nothing was pushed to GitHub.

The live test is `apps/server/src/cloud/HandoffService.live.test.ts`; opt in with
`VITRE_LIVE_HANDOFF=1`, `VITRE_LIVE_EXPECT_COMPUTE=machine`,
`VITRE_LIVE_GITHUB_REPOSITORY=owner/repository`, and a private
`VITRE_LIVE_CREDENTIAL_FILE`. Optional `VITRE_LIVE_SOURCE` selects `cloud-local`
or `cloud-github`. The two final cases passed in 303 seconds total. Logs:
`/tmp/vitre-aws-roundtrip-both.log`.

Live verification exposed and fixed three runtime problems:

- Cloudflare rejects fetch redirect mode `error`; machine requests now use `manual`
  and reject non-success responses without forwarding credentials to redirects.
- Workspace and private worker state are different bind mounts. Moving non-Git
  baseline metadata now stages a complete copy on the destination mount before
  removing the source; provider credentials are staged privately on their own mount.
- The sandbox's private `/tmp` was mode 0755. It now uses 01777, allowing the
  unprivileged backend to export conversations. The systemd verifier checks this.

The test host used the base artifact above plus the current `worker.mjs` and
`machine-agent.mjs`. **That earlier artifact does not contain these fixes; rebuild
from current source before provisioning another machine.** No replacement runtime
artifact was published during this round-trip verification.

The relay's temporary machine configuration was removed afterward, and disposable
cloud tasks, EC2, IAM, SSM parameter, tunnel, and DNS resources were cleaned up.
The relay retains the code fixes while using its previous compute configuration.
This is backend handoff evidence, not a native UI click test or a claim that all
conflict, attachment, additional-root, disconnect, and restart scenarios were tested.

### Persistent AWS rollout (2026-10-15)

The user requested a retained AWS host for hands-on verification and subsequently
directed that AWS be the only execution provider.
Do not delete this host as disposable verification infrastructure. Keep the
provider-independent machine protocol; AWS is the selected hosting provider.

- EC2: `i-09701643eb79622b9`, Ubuntu 22.04, `t3.small`, `eu-north-1`.
- Storage: encrypted 30 GiB gp3, retained on instance termination.
- Access: SSM and an outbound HTTPS tunnel, no inbound security-group rules.
- Endpoint: `https://aws-personal.usevitre.app`.
- Deployment inventory and credentials: `~/.config/vitre/aws-persistent.json`
  (private, never commit). The pre-AWS relay configuration is backed up alongside it.
- Runtime: `https://artifacts.usevitre.app/vitre-machine-persistent-20261015.tar.gz`.
- Archive SHA256: `5bf8fd38db1d5f8e099553efad3b49ef9820fb6c75a4599701dd288553cf9531`.
- Extracted tar SHA256: `d1546ead044c5220eaa1452db0cd1793563e05bd8e7ca4894da7d980a3b978ff`.

The runtime publisher verified all 588,508,469 bytes against the archive SHA256;
the host independently verified the archive and extracted tar. The systemd
verification passed isolation, metadata denial, exclusive ownership, stop/restart,
and workspace/home persistence checks. The authenticated HTTPS health endpoint
returned ready; unauthenticated access returned 401.

The existing personal relay was updated in place (one API update, fourteen noops).
Its persistent machine configuration is saved in `~/.config/vitre/cloud.env`.
Both live handoff cases passed on this host in 293.82 seconds, asserting
`machine-` worker IDs, conversation history, binary files, independent local edits,
and GitHub unpublished HEAD plus staged/unstaged content. Disposable test tasks
were removed; the host and its tunnel remain running for user testing. Logs:
`/tmp/vitre-persistent-live-roundtrip.log` and
`/tmp/vitre-persistent-relay-deploy.log`. Focused runtime tests: 23 passed.

This section records automated backend verification; it does not establish native
interaction latency. The retired provider's execution, credential configuration and
runtime tooling have been removed. That source removal does not delete remote
resources or retained data belonging to the former provider.
