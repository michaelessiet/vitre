# T3 Connect Relay

> [!WARNING]
> T3 Connect is currently in private beta. Join the waitlist in the app under Settings > T3 Connect.

The relay is the hosted control plane for T3 Connect. It helps clients discover and connect to
remote environments, manages the cloud-side records needed for those connections, and delivers
optional mobile notifications and Live Activities.

The relay is intentionally not in the hot path for normal T3 Code traffic. After a client connects,
regular API and WebSocket traffic goes directly between that client and the selected environment.
See the [T3 Connect architecture overview](../../docs/cloud/t3-code-connect-auth-flow.html) for the larger system
design.

## Responsibilities

The relay currently owns:

- Linking T3 Code environments to a cloud account.
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

Before considering a change complete, run the repository-wide checks from the root:

```sh
vp check
vp run typecheck
```

Backend changes should include tests. Prefer testing the real business logic with external
dependencies represented at their boundary rather than mocking internal behavior.

## Deployment

The relay deploys through Alchemy:

```sh
vp run --filter t3code-relay deploy
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
vp run --filter t3code-relay deploy -- --stage prod
vp run --filter t3code-relay deploy -- --env-file .env.local
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

The relay is versioned separately from client releases. `.github/workflows/deploy-relay.yml` deploys
the shared Alchemy `prod` stage on every push to `main`. Stable and nightly release builds both
resolve their static public config from the same
`production` GitHub environment. Pull requests do not deploy relay stages. Developers can
deploy personal non-production stages locally with any stage name other than `prod`.

The repository must define these Actions variables shared by relay deployments:

- `CLOUDFLARE_ACCOUNT_ID`
- `AXIOM_ORG_ID`

The repository must define these Actions secrets shared by relay deployments:

- `CLOUDFLARE_API_TOKEN`
- `AXIOM_TOKEN`

The `production` GitHub environment must define these Actions variables:

- `RELAY_API_ZONE_NAME`
- `RELAY_TUNNEL_ZONE_NAME`
- `RELAY_DOMAIN` if overriding the derived production relay domain
- `CLERK_PUBLISHABLE_KEY`
- `CLERK_JWT_AUDIENCE`
- `CLERK_JWT_TEMPLATE`
- `APNS_ENVIRONMENT`
- `APNS_TEAM_ID`
- `APNS_KEY_ID`
- `APNS_BUNDLE_ID`

The `production` GitHub environment must define these Actions secrets:

- `RELAY_DATABASE_ADMIN_URL`
- `RELAY_DATABASE_URL`
- `CLERK_SECRET_KEY`
- `APNS_PRIVATE_KEY`

For a database using a private CA, also define the paired `RELAY_DATABASE_CA_CERT` and
`RELAY_DATABASE_CA_CERTIFICATE_ID` Actions secrets in `production`. Omit both for system trust;
providing only one fails configuration validation. The workflow passes these database secrets
only to the deployment step, which runs migrations before applying the infrastructure plan.

The account-scoped repository credentials are consumed by Alchemy while provisioning relay stages; they
are not bound into the relay Worker. The production deployment uses an Axiom personal access token,
so `AXIOM_ORG_ID` must accompany `AXIOM_TOKEN`. The release workflow reads the production relay's
derived public URL and Clerk publishable key from the same environment for downstream desktop, CLI,
and hosted web builds.

See:

- [T3 Connect Clerk Setup](../../docs/cloud/t3-connect-clerk.md) for Clerk keys, JWT templates, and waitlist
  setup.
- [Relay Observability](../../docs/relay-observability.md) for deployment tracing and diagnostics.
- [T3 Connect Architecture Overview](../../docs/cloud/t3-code-connect-auth-flow.html) for the full link,
  connect, endpoint, and notification flows.

## Lens

[Cloud Lens](src/cloud/lens.ts) exposes authenticated account-wide reviews, model
and schedule settings, read markers, and permission-gated cleanup. Existing
auxiliary-job maintenance runs scheduled sweeps. Deploy the matching machine agent
and runtime image for the new `lens` job mode. See [Lens](../../docs/lens.md) for
behavior, inventory limits, isolation, verification, and coordinated rollout.
