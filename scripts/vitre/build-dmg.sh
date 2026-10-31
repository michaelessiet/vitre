#!/bin/sh
set -eu

REPO_ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/../.." && pwd)
cd "$REPO_ROOT"

for tool in cargo codesign ditto hdiutil iconutil node plutil pnpm sips vp; do
  command -v "$tool" >/dev/null 2>&1 || {
    echo "missing required tool: $tool" >&2
    exit 1
  }
done

ARCH=$(uname -m)
if [ "$ARCH" != "arm64" ]; then
  echo "the current Vitre DMG recipe is verified only for Apple Silicon" >&2
  exit 1
fi

SIGNING_IDENTITY=${VITRE_SIGNING_IDENTITY:-}
if [ -z "$SIGNING_IDENTITY" ]; then
  echo "[vitre-dmg] set VITRE_SIGNING_IDENTITY to a stable code-signing certificate" >&2
  echo "[vitre-dmg] use VITRE_SIGNING_IDENTITY=- only for a disposable local build" >&2
  exit 1
fi

VERSION=$(node -p "require('./apps/server/package.json').version")
NODE_BINARY=${VITRE_NODE:-$(node -p 'process.execPath')}
if [ "$("$NODE_BINARY" -p 'process.arch')" != "arm64" ]; then
  echo "the packaged Node runtime must be Apple Silicon" >&2
  exit 1
fi
OUTPUT_DIR=${VITRE_RELEASE_DIR:-$REPO_ROOT/release}
OUTPUT_DMG="$OUTPUT_DIR/Vitre-$VERSION-$ARCH.dmg"
BUILD_ROOT=$(mktemp -d "${TMPDIR:-/tmp}/vitre-dmg.XXXXXX")
APP="$BUILD_ROOT/Vitre.app"
CONTENTS="$APP/Contents"
RESOURCES="$CONTENTS/Resources"
ICON_SOURCE="$REPO_ROOT/assets/vitre/icon.png"
ICONSET="$BUILD_ROOT/AppIcon.iconset"
DEPLOY_ROOT="$BUILD_ROOT/server-deploy"
DMG_ROOT="$BUILD_ROOT/dmg"
SELFTEST_HOME="$BUILD_ROOT/selftest-home"

cleanup() {
  if [ "${VITRE_KEEP_BUILD:-0}" = "1" ]; then
    echo "[vitre-dmg] retained build root for inspection: $BUILD_ROOT"
  else
    rm -rf "$BUILD_ROOT"
  fi
}
trap cleanup EXIT HUP INT TERM

echo "[vitre-dmg] building server bundle"
(cd apps/server && vp run build:bundle)

echo "[vitre-dmg] deploying production server dependencies"
pnpm --filter ./apps/server deploy --prod --legacy "$DEPLOY_ROOT"
node scripts/vitre/prune-packaged-node-modules.mjs "$DEPLOY_ROOT/node_modules"

echo "[vitre-dmg] building release binary"
cargo build --locked --release -p vitre-app --bin vitre

mkdir -p "$CONTENTS/MacOS" "$RESOURCES/node/bin" "$RESOURCES/server" "$DMG_ROOT" "$SELFTEST_HOME" "$OUTPUT_DIR"
ditto target/release/vitre "$CONTENTS/MacOS/Vitre"
ditto "$NODE_BINARY" "$RESOURCES/node/bin/node"
ditto "$DEPLOY_ROOT/dist" "$RESOURCES/server"
ditto "$DEPLOY_ROOT/node_modules" "$RESOURCES/server/node_modules"
mkdir -p "$ICONSET"
for size in 16 32 128 256 512; do
  double_size=$((size * 2))
  sips -z "$size" "$size" "$ICON_SOURCE" --out "$ICONSET/icon_${size}x${size}.png" >/dev/null
  sips -z "$double_size" "$double_size" "$ICON_SOURCE" --out "$ICONSET/icon_${size}x${size}@2x.png" >/dev/null
done
iconutil -c icns "$ICONSET" -o "$RESOURCES/AppIcon.icns"
ditto scripts/vitre/Info.plist "$CONTENTS/Info.plist"

plutil -replace CFBundleShortVersionString -string "$VERSION" "$CONTENTS/Info.plist"
plutil -replace CFBundleVersion -string "$(git rev-list --count HEAD)" "$CONTENTS/Info.plist"
chmod 755 "$CONTENTS/MacOS/Vitre" "$RESOURCES/node/bin/node"

if [ "$SIGNING_IDENTITY" = "-" ]; then
  echo "[vitre-dmg] warning: ad-hoc signing changes Vitre's macOS permission identity on every build" >&2
  echo "[vitre-dmg] set VITRE_SIGNING_IDENTITY to an Apple Development or Developer ID certificate to preserve Screen Recording access" >&2
else
  echo "[vitre-dmg] signing bundle with $SIGNING_IDENTITY"
fi
# The production pnpm tree contains internal symlinks. Let codesign seal that
# tree as resources instead of recursively following every link as nested code.
# Public distribution still needs Developer ID signing and notarization.
BUNDLE_IDENTIFIER=$(plutil -extract CFBundleIdentifier raw -o - "$CONTENTS/Info.plist")
codesign --force --sign "$SIGNING_IDENTITY" --identifier "$BUNDLE_IDENTIFIER" "$APP"
codesign --verify --strict --verbose=2 "$APP"

echo "[vitre-dmg] running packaged sidecar/auth/RPC self-test without shell PATH"
env -i \
  HOME="$SELFTEST_HOME" \
  PATH="/usr/bin:/bin:/usr/sbin:/sbin" \
  TMPDIR="${TMPDIR:-/tmp}" \
  USER="$(id -un)" \
  VITRE_HOME="$SELFTEST_HOME" \
  VITRE_SELFTEST=1 \
  "$CONTENTS/MacOS/Vitre"

ditto "$APP" "$DMG_ROOT/Vitre.app"
ln -s /Applications "$DMG_ROOT/Applications"
rm -f "$OUTPUT_DMG"

echo "[vitre-dmg] creating $OUTPUT_DMG"
hdiutil create \
  -volname "Vitre $VERSION" \
  -srcfolder "$DMG_ROOT" \
  -ov \
  -format UDZO \
  "$OUTPUT_DMG"
hdiutil verify "$OUTPUT_DMG"
node scripts/ci/artifact.ts "$OUTPUT_DMG"
cat "$OUTPUT_DMG.sha256"
echo "[vitre-dmg] ready: $OUTPUT_DMG"
