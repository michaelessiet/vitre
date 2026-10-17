# CLI release

The `Publish CLI` workflow (`.github/workflows/release.yml`) publishes the `t3` server package to npm. It runs on stable version tags (`vX.Y.Z`) and by manual dispatch. A manual dispatch can select the `nightly` channel; nightly versions are derived from `apps/server/package.json`.

Before publishing, the workflow runs workspace checks, type checks, and tests. It reads the production relay URL, Clerk public configuration, and relay tracing configuration, then builds the server bundle. Stable releases use the npm `latest` dist tag; manual nightly releases use `nightly`.

Vitre's native application has a separate build and distribution process. This workflow no longer creates Electron installers, hosts a React web application, or publishes desktop update manifests.
