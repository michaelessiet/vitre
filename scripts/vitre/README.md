# Vitre contracts export (Stage A)

- `node scripts/vitre/export-contracts.ts` — exports the sidecar's Effect-RPC surface
  (`WsRpcGroup`, 101 methods) as wire-side JSON Schema into
  `crates/vitre-contracts/contracts.gen.json` (deterministic; asserts internally).
- `node scripts/vitre/export-fixtures.ts` — writes golden wire fixtures to
  `crates/vitre-contracts/fixtures/*.json`, each validated by a decode → re-encode
  fixed point through `Schema.toCodecJson` (the codec the rpc transport actually uses).
- `lib.ts` — shared annotate pass naming `$defs` after contract export names.

Regeneration flow (what CI's drift gate must mirror): run both scripts, then
`vp fmt crates/vitre-contracts` — the committed canonical form is the
formatted one. Regenerate + fmt is byte-stable.

Consumer: Stage B Rust emitter (`vitre-contracts-gen`) in `crates/vitre-contracts`.

## Native macOS package

From the repository root, build the desktop app and DMG with:

```sh
VITRE_SIGNING_IDENTITY="Apple Development: …" vp run build:vitre:dmg
```

The output is `release/Vitre-<version>-arm64.dmg`, accompanied by a `.sha256`
checksum and `.metadata.json` with version, commit, architecture, signing mode,
checkout state, and workflow provenance. Set `VITRE_RELEASE_DIR` to choose another
output directory. The actual Node executable is resolved through `process.execPath`;
`VITRE_NODE` can override it with another Apple Silicon Node executable.

GitHub Actions produces ad-hoc development builds after relevant main changes pass
CI, or through a manual **Vitre CI** run. Artifacts expire after 14 days. See
[CI and development builds](../../docs/operations/release.md) for download and
verification instructions.

- `vp run build:vitre:dmg` runs `scripts/vitre/build-dmg.sh` to build the current server bundle and release
  binary, deploys production Node dependencies, embeds the active Apple Silicon
  Node runtime, signs `Vitre.app`, and creates a compressed DMG under `release/`.
  Set `VITRE_SIGNING_IDENTITY` to an Apple Development or Developer ID certificate
  to keep macOS Screen Recording permission across rebuilds. The package build
  requires this setting; `VITRE_SIGNING_IDENTITY=-` explicitly opts into a
  disposable ad-hoc build whose permission identity changes with each rebuild.
  Check available certificates with `security find-identity -v -p codesigning`.
- `VITRE_SIGNING_IDENTITY="Apple Development: …" node apps/vitre/dev.mjs` also
  runs local development through a signed `target/vitre-dev/Vitre.app`. Use the
  same certificate for each rebuild so macOS keeps the permission grant.
- Before creating the DMG, the script launches the packaged executable with an
  empty shell environment and a disposable `VITRE_HOME`. Its self-test must
  boot the embedded sidecar and complete token exchange, WebSocket setup,
  `server.getConfig`, and application ping.
- The local DMG is suitable for installation and full testing on this Mac, but
  it is not Developer ID signed or notarized. Public distribution still needs
  the M6 signing/notarization and update-feed work.

## Native performance measurements

`python3 scripts/vitre/measure-resources.py --output /tmp/vitre-performance/idle.json`
measures three five-minute release idle runs with disposable homes. Run
`cargo run --release -p vitre-state --example performance` for repeatable terminal
and conversation publication microbenchmarks. See
[the optimization status and measurement limits](../../docs/operations/vitre-performance.md).

## Lens preview

`node scripts/vitre/lens-preview.ts` serves sample Lens data on loopback port 4897.
A debug native build with `VITRE_LENS_PREVIEW=1` uses it for Lens only. See
[the Lens development guide](../../docs/lens.md#development-and-rollout) for both
desktop and mobile preview commands and rollout requirements.
