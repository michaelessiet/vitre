# Vitre CI and development builds

Vitre currently distributes development artifacts for Apple Silicon macOS. These
builds are ad-hoc signed and are not notarized public releases. There is no update
feed. GitHub Actions does not publish npm packages or create version tags.

## Workflows

`Vitre CI` (`.github/workflows/ci.yml`) is the validation entry point for pull
requests, pushes to `main`, and manual dispatches. Its `CI result` check succeeds
only when every required validation job succeeds. The native job may be skipped
only when the change selector determines that native inputs are unchanged.

| Workflow           | Responsibility                                                                                                    |
| ------------------ | ----------------------------------------------------------------------------------------------------------------- |
| `ci.yml`           | Linux formatting, lint, type checks, package tests, sidecar and website builds; selects and aggregates validation |
| `vitre-ci.yml`     | Reusable macOS Rust checks, licensing, contracts drift, and real-sidecar wire/typed/client spikes                 |
| `build-vitre.yml`  | Reusable verified Apple Silicon development DMG build                                                             |
| `issue-labels.yml` | Synchronizes issue and size label definitions from `.github/labels.json`                                          |
| `pr-size.yml`      | Labels PR size using trusted base code and passive Git inspection                                                 |

Linux checks run on every CI invocation. Native inputs include Rust crates and
vendored dependencies, the server sidecar, shared packages, native assets and
scripts, root dependency/toolchain configuration, patches, and CI tooling.
Pull requests compare against their merge base; pushes compare against their
previous commit. An unavailable comparison runs native validation. Manual runs
always validate both TypeScript and native code.

Node and pnpm versions come from `package.json`; Vite+ resolves from the package
manifest/catalog. The shared setup action explicitly installs pnpm and installs
workspace dependencies with `--frozen-lockfile`. Native builds use the pinned Rust
toolchain and locked dependency graph. Superseded PR runs are canceled; main
runs are never canceled.

## Downloading a development build

A relevant push to `main` produces a DMG after validation passes. Pull requests
validate code without producing DMGs. To build another ref, manually run **Vitre
CI** with `build_artifact=true` (the default). Setting it to false runs validation
only.

Open the successful run's artifacts and download:

`Vitre-macos-arm64-<12-character-commit>-<run-id>`

The archive expires after 14 days and contains:

- `Vitre-<version>-arm64.dmg`
- `Vitre-<version>-arm64.dmg.sha256`
- `Vitre-<version>-arm64.dmg.metadata.json`

The version remains the value in `apps/server/package.json`. Metadata includes
`version`, `commit`, `architecture`, `workflowRun`, `workflowAttempt`, `signing`,
`dirty`, `filename`, and `sha256`. Local builds have null workflow fields and
record whether the checkout contains uncommitted changes.

After extracting the artifact, verify it from that directory:

```sh
shasum -a 256 -c Vitre-<version>-arm64.dmg.sha256
```

The build embeds the actual Apple Silicon Node executable, production sidecar
dependencies, and native binary. It verifies the app's signature, launches the
packaged executable with an empty shell environment and disposable home, and
requires the embedded sidecar/auth/RPC self-test to pass before creating and
verifying the DMG. An ad-hoc signature does not provide a stable macOS permission
identity across builds.

For a local build:

```sh
VITRE_SIGNING_IDENTITY=- vp run build:vitre:dmg
```

See [native packaging](../../scripts/vitre/README.md#native-macos-package) for
certificate-based local signing and output-directory options. Developer ID
signing, notarization, public releases, and automatic updates remain future work.

## Verification while changing automation

Run actionlint against `.github/workflows/*.yml`, targeted formatting/lint, the
`scripts/ci/*.test.ts` tests, and the scripts package type check. Use the existing
DMG self-test for packaging changes. Full workspace validation belongs in CI.
No branch-protection settings or old workflow-run history are changed automatically.
