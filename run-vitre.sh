#!/bin/sh
# Dev launcher for manual testing: real ~/.vitre home, repo-local server bundle.
# The sidecar needs Node on PATH; set VITRE_NODE_BIN to a Node bin directory when
# launching from an environment without it (for example a GUI launcher).
cd "$(dirname "$0")" || exit 1
if [ -n "$VITRE_NODE_BIN" ]; then
  PATH="$VITRE_NODE_BIN:$PATH"
  export PATH
fi
command -v node >/dev/null 2>&1 || { echo "node is not on PATH; set VITRE_NODE_BIN" >&2; exit 1; }
VITRE_SERVER_ENTRY="$PWD/apps/server/dist/bin.mjs"
export VITRE_SERVER_ENTRY
cargo build -p vitre-app --bin vitre || exit 1
exec ./target/debug/vitre
