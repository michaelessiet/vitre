# Vitre Relay

The relay is the hosted control plane for Vitre remote environments and cloud conversations. It helps clients discover and connect to
remote environments, manages the cloud-side records needed for those connections, and delivers
optional mobile notifications and Live Activities.

The relay is intentionally not in the hot path for normal local Vitre traffic. After a client connects,
regular API and WebSocket traffic goes directly between that client and the selected environment.
See the [remote connection architecture overview](../../docs/cloud/t3-code-connect-auth-flow.html) for the larger system
design.

## Responsibilities

The relay currently owns:

- Linking Vitre environments to a cloud account.
- Provisioning and tracking managed environment endpoints.
- Issuing short-lived credentials used to connect clients to linked environments.
- Listing linked environments and registered mobile devices for an account.
- Registering mobile notification preferences and APNs tokens.
- Receiving published agent activity and delivering notifications or Live Activity updates.
- Persisting relay state and exposing relay-specific traces for diagnostics.

The environment server and relay have separate credentials and trust boundaries. Read
[Environment Authentication Profile](../../docs/environment-auth.md) before changing token,
credential, or authorization behavior.

## Code Map

- [`alchemy.run.ts`](./alchemy.run.ts) defines the deployed Alchemy stack.
- [`src/worker.ts`](./src/worker.ts) wires Cloudflare bindings, runtime layers, queues, and HTTP APIs.
- [`src/http/Api.ts`](./src/http/Api.ts) contains the relay HTTP handlers and authentication
  boundaries.
- [`src/environments`](./src/environments) contains environment linking, credentials, endpoint
  provisioning, and connection flows.
- [`src/agentActivity`](./src/agentActivity) contains mobile device registration, activity state,
  APNs delivery, and queue processing.
- [`src/auth`](./src/auth) contains relay token and DPoP proof handling.
- [`src/persistence/schema.ts`](./src/persistence/schema.ts) defines persisted relay state. Keep
  schema and migration changes together.

Shared request and response schemas live in
[`packages/contracts/src/relay.ts`](../../packages/contracts/src/relay.ts). Shared client-side relay
calls live in
[`packages/client-runtime/src/relay/managedRelay.ts`](../../packages/client-runtime/src/relay/managedRelay.ts).

## Working Locally

Install dependencies from the repository root, then run relay-focused checks from this directory:

```sh
vp install
cd infra/relay
vp test run
vp run typecheck
```

To run a smaller test set while iterating:

```sh
vp test run src/environments/EnvironmentLinker.test.ts
```

Run targeted formatting, lint, and type checks for the affected scope. Full
workspace checks run in GitHub Actions.

Backend changes should include tests. Prefer testing the real business logic with external
dependencies represented at their boundary rather than mocking internal behavior.

## Deployment

The relay deploys through Alchemy:

```sh
vp run --filter ./infra/relay deploy
```

The stack provisions the Cloudflare Worker and queues, managed endpoint resources, database
connectivity, and relay tracing resources. Copy [`infra/relay/.env.example`](./.env.example) to
`infra/relay/.env` and fill in the deployment-specific values before deploying. Alchemy loads that
file from the relay directory. Runtime secrets include Clerk and APNs credentials. Production adopts
the configured API and tunnel DNS zones as retained Cloudflare resources. Personal stages reference
the production-owned zones.

Personal deployments disable detailed Axiom HTTP span export by default to reduce
per-request CPU work. Cloudflare invocation logs and metrics remain available.
Set `RELAY_HTTP_TRACING_ENABLED=true` when detailed HTTP diagnostics are needed;
production deployments keep tracing enabled by default. API documentation is
compiled once per Worker isolate, and each HTTP request initializes only its API's routes.

The relay uses a user-owned PostgreSQL database through Cloudflare Hyperdrive.
Set `RELAY_DATABASE_ADMIN_URL` to the database owner's **direct, unpooled** connection URL,
including `sslmode=require`. Set `RELAY_DATABASE_URL` to the same endpoint and database,
with username `vitre_relay` and a separate strong, URL-encoded password. Deployment creates
that restricted SQL role, applies the migrations in `migrations/postgres` transactionally,
and grants access to the application tables. The owner credential stays in deployment tooling;
Hyperdrive receives only the runtime credential. Let deployment create the runtime role with
restricted SQL permissions; provider consoles may grant additional role memberships. Migration TLS
verifies the server certificate and hostname using system trust by default.

For a database with a private CA, set both `RELAY_DATABASE_CA_CERT` to its complete, quoted,
multiline PEM certificate and `RELAY_DATABASE_CA_CERTIFICATE_ID` to the ID returned when uploading
that same certificate to Cloudflare. Both settings are required together. Obtain the CA through
authenticated service access and keep these settings in the deployment environment. Use a CA
dedicated to this database: custom trust validates the certificate chain and expiry, while allowing
the public TCP proxy hostname to differ from the server certificate. Hyperdrive uses `verify-ca`;
the migration client keeps `rejectUnauthorized: true` with the same CA. Leave both variables unset
for a database with a publicly trusted certificate. See [Cloudflare's CA upload instructions](https://developers.cloudflare.com/hyperdrive/configuration/tls-ssl-certificates-for-hyperdrive/).

Railway's `postgres-ssl` template stores its CA at
`/var/lib/postgresql/data/certs/root.crt`. Through an authenticated SSH session, extract PEM-only
contents with `openssl x509 -in /var/lib/postgresql/data/certs/root.crt -outform PEM` and upload
that certificate. The template can regenerate its CA when certificates are missing, incomplete,
or nearing expiry. Coordinate rotation: retrieve the replacement CA, upload it to Cloudflare,
update both settings together, redeploy, and verify the relay connection. A stale CA fails closed
and interrupts new database connections until trust is updated. Monitor certificate expiry before
the template's renewal window; see the [template's certificate lifecycle](https://github.com/railwayapp-templates/postgres-ssl/blob/main/init-ssl.sh).

Create a separate database for each stage and supply its URLs explicitly.
Stages do not create databases automatically or require a prior `prod` deployment:

```sh
vp run --filter ./infra/relay deploy -- --stage prod
vp run --filter ./infra/relay deploy -- --env-file .env.local
```

Alchemy defaults personal deployments to the `dev_$USER` stage. Relay custom domains apply the same
DNS-safe sanitization as Alchemy physical resource names, so `prod` uses
`relay.<RELAY_API_ZONE_NAME>` and `dev_julius` uses
`relay-dev-julius.<RELAY_API_ZONE_NAME>`. Managed environment endpoints are provisioned below
`RELAY_TUNNEL_ZONE_NAME`, which may be a different Cloudflare zone. Production tunnel hostnames use
`prod-<digest>.<RELAY_TUNNEL_ZONE_NAME>`; personal stages use
`<stage>-<digest>.<RELAY_TUNNEL_ZONE_NAME>`. `RELAY_DOMAIN` remains available as an explicit API
domain override.

After a successful deploy, the wrapper updates the repository-root `.env` file with the derived relay
URL. That makes subsequent source builds point at the relay that was just deployed without copying
the URL manually.

### Deployment CI

`.github/workflows/deploy-relay.yml` automatically deploys cloud changes after
successful main validation in `Vitre CI`. No opt-in flag is required. Set the
repository variable `RELAY_DEPLOY_ENABLED=false` to pause deployments explicitly.
Pull requests and manual CI builds never deploy. Development DMGs do not read
deployment secrets or tracing credentials.

Use the existing `production` GitHub environment. Configure its values to match
the existing installation; do not rename the stack, switch the database, or
replace encryption keys while enabling CI. The workflow requires an existing
stack using `VITRE_CLOUD_REQUIRE_EXISTING_STACK=true`.

Required variables:

- `RELAY_STACK_NAME` and `RELAY_STAGE`: the exact existing Alchemy installation
  and stage; neither defaults to an inherited upstream name.
- `RELAY_PERSONAL_DEPLOYMENT`, `RELAY_MOBILE_ENABLED`, and `VITRE_CLOUD_ENABLED`:
  explicit `true` or `false`, matching the deployed configuration.
- `CLOUDFLARE_ACCOUNT_ID`, `AXIOM_ORG_ID`.
- `RELAY_API_ZONE_NAME`, `RELAY_TUNNEL_ZONE_NAME`.
- `CLERK_PUBLISHABLE_KEY`, `CLERK_JWT_AUDIENCE`.

Required secrets:

- `CLOUDFLARE_API_TOKEN`, `AXIOM_TOKEN`.
- `RELAY_DATABASE_ADMIN_URL`, `RELAY_DATABASE_URL`.
- `CLERK_SECRET_KEY`.

Optional configuration and feature-dependent requirements:

- `RELAY_DOMAIN` overrides the derived domain. `RELAY_HTTP_TRACING_ENABLED`
  overrides the deployment's tracing default when set to `true` or `false`.
- Private database CAs require both secrets `RELAY_DATABASE_CA_CERT` and
  `RELAY_DATABASE_CA_CERTIFICATE_ID`. Omit both when using system trust.
- Mobile-enabled deployments require variables `APNS_ENVIRONMENT`, `APNS_TEAM_ID`,
  `APNS_KEY_ID`, `APNS_BUNDLE_ID`, and secret `APNS_PRIVATE_KEY`.
- Cloud-enabled deployments require variables `VITRE_CLOUD_ALLOWED_USER_ID`,
  `VITRE_CLOUD_MACHINE_URL`, and secrets `VITRE_CLOUD_MACHINE_TOKEN` and
  `VITRE_CLOUD_ENCRYPTION_KEY`. Preserve these settings when disabling new cloud
  starts so existing accounts, workers, and cleanup continue to function.
- An existing GitHub App integration requires variables `VITRE_GITHUB_APP_ID`,
  `VITRE_GITHUB_INSTALLATION_IDS`, and secret `VITRE_GITHUB_PRIVATE_KEY` together.
- Machine runtime updates require variables `VITRE_CLOUD_RUNTIME_BUCKET` and
  `VITRE_CLOUD_RUNTIME_URL`, plus the cloud machine URL, owner ID, and token above.
  The HTTPS origin must serve the root of the existing runtime distribution bucket.
  Install the [host release updater](../../scripts/vitre/cloud/README.md#automatic-production-deployment)
  once using existing administrative access. GitHub needs no AWS role, OIDC provider,
  login session, or access key. It publishes through the existing Cloudflare token
  and waits for authenticated health to confirm the exact installed runtime.

Account-wide credentials can be repository secrets; installation-specific values
belong in `production`. Restrict this environment to the `main` branch. No secrets
are copied automatically. Build and smoke-test steps receive no deployment secrets.
Preflight errors name missing fields without printing their values, before runtime
installation, migrations, or infrastructure changes.

The workflow serializes baseline selection and deployment. It compares the exact
validated commit with the last successful production deployment, including all
intervening changes. Cloud inputs include `infra/relay`, `scripts/vitre/cloud`,
`apps/server`, shared packages, and their build dependencies. Unchanged and
superseded commits are skipped; divergent or unreadable history fails closed.
With no recorded success, the configured existing stack and runtime are deployed.

For runtime changes, CI builds the pinned Linux image, runs the backend/browser
smoke test, exports and verifies an immutable archive, and installs it through SSM
before updating the relay. Existing conversations keep their original filesystem;
new workers use the new runtime. Protocol changes incompatible with resident
workers still require a coordinated drain. Relay-only changes skip image building.
GitHub records success only after installation, relay deployment, and live health,
Lens-route, and GitHub-account-route checks pass. An old Worker returning a healthy
`/health` response but missing feature routes is a failed deployment.

See [Vitre CI and development builds](../../docs/operations/release.md) for artifact
triggers, metadata, and local verification.

See:

- [Clerk setup](../../docs/cloud/t3-connect-clerk.md) for Clerk keys, JWT templates, and waitlist
  setup.
- [Relay Observability](../../docs/operations/relay-observability.md) for deployment tracing and diagnostics.
- [remote connection architecture overview](../../docs/cloud/t3-code-connect-auth-flow.html) for the full link,
  connect, endpoint, and notification flows.

## Lens

[Cloud Lens](src/cloud/lens.ts) exposes authenticated account-wide reviews, model
and schedule settings, read markers, and permission-gated cleanup. Existing
auxiliary-job maintenance runs scheduled sweeps. Deploy the matching machine agent
and runtime image for the new `lens` job mode. See [Lens](../../docs/lens.md) for
behavior, inventory limits, isolation, verification, and coordinated rollout.

## GitHub repository connections

Vitre sign-in and repository authorization are separate. Clerk supports a single
GitHub sign-in identity per user; do not use createExternalAccount to promise
multiple GitHub identities. The account management page uses the existing Vitre
session and the t3-relay JWT template, then starts GitHub's device authorization
flow for additional repository accounts. Sign in to the same Vitre account on
desktop and mobile to use those connections.

Enable **Device Flow** in the existing Vitre GitHub App's settings. The server
derives its client ID from the authenticated App API, requests expiring
offline_access credentials, and intersects account permissions with installed
App repository access before issuing worker credentials. No new client secret
or broad personal access token is required. Each person still approves the
specific GitHub authorization in their browser.

Device codes, access tokens, and refresh tokens are encrypted with the existing
cloud credential vault and bound to their owner and connection version.
Polling and refresh use durable leases; disconnecting during a refresh cannot
restore the connection. Disconnect removes the repository credential from
Vitre without changing its sign-in identities or deleting conversations.

### Account write concurrency regression

Cloud mutations lock the account row inside a PostgreSQL transaction. This keeps
background reconciliation and user commands from exhausting optimistic retries.
Reducers perform no external I/O; rejected reducers roll back the whole transaction.
The lock wait is bounded to ten seconds.

The focused `src/cloud/store.postgres.test.ts` integration test uses the real
request-bound connection adapter and runs two batches of 32 concurrent mutations.
It is opt-in: set `VITRE_STORE_TEST_DATABASE_URL` to a disposable PostgreSQL database
named `vitre_store` on `127.0.0.1`, then run that test with `vp test run`. The test
refuses other database targets and removes its account records afterwards.
