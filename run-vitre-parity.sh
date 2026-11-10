#!/bin/sh
# Same as run-vitre.sh but against an isolated, seeded home, so sidebar grouping
# can be exercised without touching the real ~/.vitre. Build first with run-vitre.sh.
cd "$(dirname "$0")" || exit 1
if [ -n "$VITRE_NODE_BIN" ]; then
  PATH="$VITRE_NODE_BIN:$PATH"
  export PATH
fi
command -v node >/dev/null 2>&1 || { echo "node is not on PATH; set VITRE_NODE_BIN" >&2; exit 1; }
VITRE_SERVER_ENTRY="$PWD/apps/server/dist/bin.mjs"
export VITRE_SERVER_ENTRY
VITRE_HOME="/tmp/vitre-parity-home"
export VITRE_HOME
exec ./target/debug/vitre
