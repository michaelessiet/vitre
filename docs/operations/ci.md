# CI quality gates

- `.github/workflows/ci.yml` is the **Vitre CI** entry point for pull requests, pushes to `main`, and manual runs. Linux jobs run formatting, lint, workspace type checks, server and marketing builds, and package tests on every run.
- Relevant source and configuration changes also run `.github/workflows/vitre-ci.yml`: Rust formatting, Clippy, build/tests, licensing, the single-GPUI invariant, generated-contract drift detection, and three live-sidecar spikes. Manual runs always include native validation.
- **CI result** aggregates validation outcomes and rejects failures, cancellations, and unexpected skips.
- After successful validation, relevant main pushes and manual runs with `build_artifact=true` call `.github/workflows/build-vitre.yml`. It uploads an Apple Silicon development DMG with an ad-hoc signature, checksum, and build metadata for 14 days.
- Relay deployment requires a successful main push and `RELAY_DEPLOY_ENABLED=true`, plus explicit configuration in the `production` environment. It stays disabled when the flag is unset. Manual runs never deploy.
- Vendored reference repositories and GPUI component sources are excluded from the JavaScript formatter and linter. The root `.gitmodules` registers the gitlink inherited from the Alchemy reference subtree so checkout can clean up credentials without initializing that submodule.
- See [Build and deployment operations](./release.md) for artifact verification, configuration, and activation steps.
