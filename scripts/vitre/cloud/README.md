# Vitre Cloud worker development

The cloud implementation is available behind disabled-by-default capabilities.
Keep `VITRE_CLOUD_ENABLED=false` until the live compatibility proof below passes.
Local tests cover the control plane, isolated login/publication jobs, session
checkpoints, shared transports and native Cloud controls. Local checks do not
prove subscription login, managed tunnels or worker lifecycle behavior on AWS.

## Persistent-machine transfers

Workspace v2 packs small files into content-addressed chunks. Retries check owned
chunks before uploading; the relay hashes canonical manifest JSON. AWS restores
chunks concurrently with a bounded disk cache. Both snapshots and checkpoints
exclude `node_modules`, Rust build output, virtual environments and common caches,
including in plain folders without `.gitignore`. `.vitreignore` adds exclusions.
Tracked source and test fixtures inside dependency directories are preserved,
including files added by unpublished commits or staged changes.

Node projects install on the cloud host using their package manager and lockfile.
Automatic installation failures remain visible and do not prevent conversation;
explicit repository setup commands still fail the run. Package caches persist on
the user's machine. Only successful setup with matching dependency fingerprints
is reused; failed setup is retried with its real output saved to
`/home/vitre/setup-output.log`.

Dedicated-machine conversation workers retain their backend, tunnel and workspace
between turns. A provider lease covers authentication and one active provider
session. On idle, the worker waits for that process to exit, saves refreshed
credentials, removes idle Codex credentials, and releases the lease. The next
turn installs the latest credential before resuming its provider session. Native
clients retain their connections across navigation. Fresh provisioning and model
response time remain separate from reconnect latency.

Resident workers opt into a process-lifetime bootstrap grant through the backend's
trusted launch pipe. This lets a mobile client reconnect after a workspace has
been running for several days. The cloud grant uses standard client scopes;
ordinary desktop bootstrap grants still expire after 24 hours, and one-time
pairing links retain their short expiry. Existing backends must be recreated
after an idle checkpoint to adopt this policy.

Follow-up permission and interaction changes are persisted before the next turn
starts. Changing permissions does not resolve an approval from an active turn.

Resident Codex backends set `VITRE_CLOUD_RESIDENT_PROVIDER=codex`, retaining their
first successful provider probe so background health checks cannot refresh
credentials outside the lease. Deploy the relay, worker, machine agent and backend
as one drained upgrade. AWS is the only configured compute provider. Dedicated
machine billing is independent of the number of resident conversations; task
estimates and auxiliary-job deadlines do not bound the host's bill or uptime.

Pin provider tooling to a version tested with the desktop's selected model.
A backend-only test or a model catalog is not a successful native round trip:
verify a real response, follow-up, and return to Local in the desktop app.

## Worker image

Build from the repository root with explicitly pinned provider versions:

```sh
node scripts/vitre/cloud/build-image.mjs vitre-cloud:dev-20261015 0.156.1 2.1.236
curl -fsSL https://raw.githubusercontent.com/microsoft/playwright/v1.60.0/utils/docker/seccomp_profile.json -o /tmp/vitre-playwright-seccomp.json
VITRE_SMOKE_SECCOMP_PROFILE=/tmp/vitre-playwright-seccomp.json node scripts/vitre/cloud/smoke-image.mjs vitre-cloud:dev-20261015
```

The smoke test runs the packaged Linux backend in a disposable local container,
performs the bootstrap token exchange, reads an authenticated orchestration
snapshot, requests a WebSocket ticket, captures a PNG with sandboxed Chromium,
and removes the container. The Docker seccomp profile permits Chromium's user
namespaces; production workers use the machine's bubblewrap isolation. It does not
authenticate subscriptions or prove the deployed machine's lifecycle behavior.

See [linked accounts and screenshots](../../../docs/architecture/vitre-cloud-accounts-and-screenshots.md)
for user flows, access rules, and deployment acceptance checks.

Export the tested image into a complete machine runtime filesystem:

```sh
node scripts/vitre/cloud/export-machine-runtime.mjs vitre-cloud:dev-20261015 /tmp/vitre-rootfs-20261015.tar
```

The exporter prints the archive SHA-256. Publish an immutable version using
`publish-runtime.mjs`, verify that checksum on the AWS host, and install with
`install-machine.sh ROOTFS.tar SHA256`. The rootfs contains the packaged backend,
pinned provider tooling and machine supervisor, with no credentials or private
application data. The installer refuses to overwrite an installed runtime.
Existing hosts use versioned runtimes through the automatic deployment below.
Drain workers before incompatible protocol upgrades. Unlink targets before
replacing files that may be hardlinked to an older runtime.

## Automatic production deployment

Validated merges to `main` automatically deploy changed cloud code through
`.github/workflows/deploy-relay.yml`. See the
[production configuration](../../../infra/relay/README.md#deployment-ci) for the
environment variables and secrets. Set `RELAY_DEPLOY_ENABLED=false` only when
intentionally pausing releases. Missing configuration fails the deployment visibly.

Runtime changes build and smoke-test the Linux image using the provider versions
in `toolchain.json`. The archive is published under a key containing its full Git
revision and SHA-256. SSM downloads it on the existing machine, and
`upgrade-machine.py` verifies the checksum before extracting into a new directory.
Identical files can share hard links; changed files never overwrite an older
runtime. The supervisor switches through a durable systemd override, verifies its
authenticated health, and checks that existing worker PIDs survived. Failed
activation restores the previous supervisor configuration. Retained conversation
data and previous runtime directories are preserved. Monitor disk capacity and
retire old runtimes only after no workers use them.

This supports compatible rolling releases. A protocol change that cannot coexist
with existing conversation workers must be drained separately. The workflow
deploys the relay only after the matching runtime is verified, and does not record
success until the live feature routes are present.

Use a dedicated GitHub OIDC role rather than long-lived AWS credentials. Trust
`https://token.actions.githubusercontent.com` with audience `sts.amazonaws.com`
and the exact production environment subject. Read the repository's subject prefix
with `gh api repos/OWNER/REPO/actions/oidc/customization/sub`; newer repositories
include immutable owner/repository IDs. Append `:environment:production` to that
prefix, and restrict the GitHub `production` environment to the `main` branch.

The role needs only these permissions (replace the installation identifiers):

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Action": "ssm:SendCommand",
      "Resource": [
        "arn:aws:ec2:REGION:ACCOUNT:instance/INSTANCE_ID",
        "arn:aws:ssm:REGION::document/AWS-RunShellScript"
      ]
    },
    {
      "Effect": "Allow",
      "Action": "ssm:GetCommandInvocation",
      "Resource": "*",
      "Condition": { "StringEquals": { "aws:RequestedRegion": "REGION" } }
    }
  ]
}
```

`GetCommandInvocation` does not support resource-level restrictions. The role
cannot provision or terminate hosts, read machine secrets through Parameter Store,
or change IAM. SSM command payloads contain the reviewed installer and the public
artifact URL; machine credentials stay on the host. See the
[GitHub OIDC guide](https://docs.github.com/en/actions/how-tos/secure-your-work/security-harden-deployments/oidc-in-aws).

The machine agent stays running under systemd and launches isolated conversation
processes against the installed filesystem. Worker startup does not download or
extract another runtime. Configure its authenticated HTTPS endpoint through
`VITRE_CLOUD_MACHINE_URL` and `VITRE_CLOUD_MACHINE_TOKEN` on the relay. A missing
assignment fails closed; it does not select another compute provider. See the
[machine installation instructions](../../../docs/architecture/vitre-cloud-conversations.md#install-and-assign-a-host).

## Personal relay

Use `deployment.env.example` as a list of deployment settings, with real values
kept outside the repository. `RELAY_PERSONAL_DEPLOYMENT=true` provisions an
independent relay and adopts zones in your own account instead of referring
to the upstream production stage. `RELAY_STACK_NAME` controls the installation name.
Mobile APNs queues and their secrets are not
provisioned when `RELAY_MOBILE_ENABLED=false`.

Provision PostgreSQL near your intended database clients and keep it running for fast
reconnection. On Railway, use the verified `postgres` template with persistent storage
and disable service sleeping. Copy the database-owner URL for its public TCP endpoint
into `RELAY_DATABASE_ADMIN_URL`; Hyperdrive supplies pooling.
For `RELAY_DATABASE_URL`, use the same direct host/database with username `vitre_relay`
and a separate randomly generated password (URL-encode special characters).
Keep `sslmode=require` on both URLs. The deployment runner creates the restricted SQL role.
Railway's template uses a private CA: retrieve it through authenticated SSH and configure
both `RELAY_DATABASE_CA_CERT` and `RELAY_DATABASE_CA_CERTIFICATE_ID` using the
[database TLS instructions](../../../infra/relay/README.md#deployment).

The relay's Cloudflare and Axiom deployment configuration is still required. The normal
relay deploy command applies all pending PostgreSQL migrations, including
`relay_cloud_accounts`, before configuring Hyperdrive. Dry runs do not connect to or
modify the database. Keep these URLs in the private deployment environment, never in
desktop builds. Database deletion remains under your control.

Active cloud work keeps one-minute reconciliation. With no active tasks, workers, leases
or pending operations, the minute cron checks an R2 marker without querying SQL and
runs a database recovery sweep hourly. New commands wake it immediately. Marker writes
use conditional updates so a concurrent command cannot lose its wakeup. When mobile
is disabled, expired-state cleanup also runs hourly; enabling mobile restores its
five-minute sweep. User polling and active tasks still consume database compute.
Keep database sleeping disabled when predictable reconnection latency is required.

Switching URLs does not migrate existing data. To retain cloud history, back up and restore
the application tables **and `relay_migrations` journal**, then verify the restored database
using a separate stage. For an intentional fresh start, initialize an empty database and
retire old workers before reconnecting provider accounts; preserve their workspace files.
Inspect the Alchemy plan before cutover and preserve the existing deployment identity.
Keep the old database until recovery and cutover have been verified.

Never replace the encryption key while
saved encrypted accounts or worker tokens still exist.

Machine, GitHub App and encryption keys belong exclusively to the cloud service's
secret configuration. Desktop/Expo clients need the cloud origin and their own
Clerk login. The worker receives a task credential, a short-lived read-only GitHub
token and its subscription credential, but no machine administration token or GitHub write token.

## Desktop account transport

The local sidecar now exposes `cloud.getDesktopSession` behind
`VITRE_CLOUD_DESKTOP_ENABLED=false` by default. A status request never opens a
browser; an explicit authorization request uses the existing Clerk PKCE loopback
login. Refresh tokens remain in the sidecar secret store. The native
`vitre_client::cloud::CloudClient` requests a fresh access token for each operation
and resolves a new authenticated environment target on every reconnect.

For a future native pilot, configure the **local sidecar**, separately from cloud
service secrets, with `VITRE_CLOUD_DESKTOP_ENABLED=true`, `T3CODE_RELAY_URL`,
`T3CODE_CLERK_PUBLISHABLE_KEY`, and `T3CODE_CLERK_CLI_OAUTH_CLIENT_ID` for your own
deployment. Register `http://127.0.0.1:34338/callback` on that Clerk OAuth client.
Open **Settings → Cloud** (or **Cloud tasks** in the sidebar), sign in, and
connect each provider. Codex opens an isolated machine job for device authorization;
Claude accepts only a subscription token from `claude setup-token`. The Codex
account must permit device-code login: see [official authentication guidance](https://learn.chatgpt.com/docs/auth).

**Connect repository** lists repositories accessible to the configured personal
GitHub App installations. Configure explicit setup and test commands before
creating a Build, Ask, or Investigate task. Conversation updates remain readable
centrally, and completed results include the diff and test output. Input requests remain live so approvals and questions can be answered immediately. Follow-ups
reuse the resident machine backend. Public GitHub repositories clone anonymously;
GitHub App installation is required only for private access or publication.
The local workspace stays separate throughout.

**Review publication** binds the entered title/body to the displayed result
revision. A separate worker verifies and pushes its checkpoint without running
an agent or repository hooks; the service creates the draft PR or exact comment.
On mobile, **Create PR → Save changes for review** captures a ready resident
workspace, including uncommitted changes. New turns are held until the snapshot
is saved; the worker closes after saving, and the conversation can resume with
the next message. Review the saved diff, enter a title and description, then
choose **Create draft PR**. Saving does not publish anything or rerun tests;
the review identifies this explicitly. Local-only and anonymous GitHub workspaces
must first be connected to a personal GitHub App installation with write access.
Publication retries first reconcile GitHub. An uncertain write that cannot be
found is reported as failed rather than posting again. **Retry / reconcile
publication** can recheck that outcome without creating a duplicate.

## Persistent machine lifecycle and cost

The AWS machine stays running and billable while idle. Conversation workers keep
their backend, tunnel and dependency state for follow-ups. Closing the desktop
does not stop them. A host restart requires explicit recovery from durable task
receipts and checkpoints; an ambiguous turn is never replayed automatically.

Stopping an attempt preserves its conversation workspace and home. Only the
attempt's systemd process group is retired; ordinary task execution never deletes
the host. Machine directory retirement remains an administrative operation.
Track disk capacity and AWS billing independently of legacy task usage estimates.

## Execution and recovery boundaries

- The supervisor runs as root. Setup and tests run as UID 10002; the backend and
  provider run as UID 10001. Neither child environment inherits control-plane or
  API billing credentials. Setup finishes before subscription credentials arrive.
- The task pins a resolved GitHub commit and repository configuration revision.
  Dispatch uses stable command IDs. A persisted submission intent prevents a
  restarted supervisor from silently replaying an ambiguous command.
- A checkpoint uses SQLite's backup API, strips pairing/session credentials from
  the copy, and records repository changes in a Git bundle using an independent
  index/configuration. Non-ignored untracked files are included. Known injected
  credentials in source cause checkpointing to fail rather than upload them.
- Checkpoint uploads are content addressed and finalized only after every chunk
  exists. Restore verifies the manifest and each chunk. The last complete
  repository/database checkpoint and Codex/Claude conversation JSONL files are
  restored into a replacement VM. Credential caches, provider settings and
  arbitrary home files are excluded. Session export rejects symlinks, oversized
  bundles and malformed records rather than declaring an incomplete backup safe.
- Cancellation retains the provider lease until the relevant provider session or
  machine attempt is confirmed stopped. A
  bounded 90-second window permits a shutdown checkpoint. A checkpoint racing
  cancellation can be saved without reviving the task. Failure to save the latest
  attempt prevents automatic sandbox retention cleanup.
- Rollback turns off new starts via `VITRE_CLOUD_ENABLED=false`; keep the worker
  secrets, account allowlist, queue/cron and result bucket deployed so existing
  results remain accessible and cleanup can continue.

- Login and publication jobs run as isolated attempts on the assigned machine,
  with bounded deadlines. Login retains the provider lease until its attempt is
  confirmed stopped. Reconciliation is scoped to this machine's owner and durable
  attempt receipts. Explicit task deletion removes its private cloud artifacts;
  retained machine directories are not automatically erased.

## Live verification, performed separately

1. Deploy the personal relay, queue, database migration and private R2 bucket;
   install the verified runtime on the assigned AWS machine and configure its
   authenticated HTTPS endpoint.
2. Enable capabilities in the disposable deployment and local desktop sidecar.
   Connect the allowlisted Clerk account and subscriptions. Configure the GitHub
   App only when testing private repositories or explicit publication.
3. For each provider, create a small task, close/reopen desktop, exercise input
   waiting/response, cancellation, and verify that a replacement attempt restores its last
   checkpoint without replaying interrupted work.
4. Review a result and create one draft PR/comment, then retry the same publication
   to verify reconciliation. Check cancellation during provisioning and allowance
   rejection with a low limit. Confirm GitHub execution credentials cannot write.
5. Delete disposable verification tasks and confirm their attempts stop. Preserve
   the persistent AWS host, conversation disks and retained endpoints intended
   for user testing.

Legacy task compute estimates do not cover AWS machine uptime, storage,
PostgreSQL, Cloudflare, Axiom or subscription usage and are not a provider invoice
ceiling. Verify host billing separately.

## Publishing large runtime archives

Use an immutable versioned key and the existing artifact bucket. The publisher
uploads 16 MiB parts and downloads the completed object to verify its SHA-256:

```sh
node --env-file=/path/to/private/cloud.env scripts/vitre/cloud/publish-runtime.mjs \
  /path/to/runtime.tgz EXISTING_BUCKET runtime-VERSION.tgz
```

Provide `CLOUDFLARE_ACCOUNT_ID` and either `R2_ACCESS_KEY_ID`/`R2_SECRET_ACCESS_KEY`
or an account `CLOUDFLARE_API_TOKEN` with access to that bucket. The script does not
change deployment configuration. Failed multipart uploads are aborted; completed
uploads can be retried safely under the same key only when their checksum matches.

After confirming the intended URL and checksum, preview the existing personal
stack with `VITRE_CLOUD_REQUIRE_EXISTING_STACK=true` and `--dry-run` before applying.
The guard rejects a new stack or cloud signing-key replacement.

`verify-machine-systemd.mjs` exercises authenticated agent access, process and
filesystem isolation, metadata denial, attempt idempotency and retained workspaces
on an explicitly disposable machine. It does not prove provider authentication,
conversation handoff, or native interaction latency.
