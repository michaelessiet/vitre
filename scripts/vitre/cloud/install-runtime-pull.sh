#!/bin/sh
# Run once on an existing host. The CI publisher needs no AWS permissions.
set -eu
test "$(id -u)" = 0 || { echo 'Run as root on the existing host' >&2; exit 1; }
test "$#" = 1 || { echo 'Usage: install-runtime-pull.sh HTTPS_ARTIFACT_ORIGIN' >&2; exit 1; }
script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
systemctl is-active --quiet vitre-machine.service
python3 - "$script_dir" "$1" <<'PY'
import importlib.util, json, pathlib, sys
directory = pathlib.Path(sys.argv[1])
spec = importlib.util.spec_from_file_location("pull_runtime", directory / "pull-runtime.py")
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
origin = module.origin_url(sys.argv[2])
config = pathlib.Path("/etc/vitre-runtime-pull.json")
if config.exists() and json.loads(config.read_text()).get("origin") != origin:
    raise RuntimeError("Existing runtime origin differs; review it before changing trust")
with open(config, "w") as output:
    config.chmod(0o600)
    json.dump({"origin": origin}, output)
PY
install -o root -g root -m 0755 "$script_dir/pull-runtime.py" /opt/vitre-machine/pull-runtime.py
install -o root -g root -m 0644 "$script_dir/vitre-runtime-pull.service" "$script_dir/vitre-runtime-pull.timer" /etc/systemd/system/
systemd-analyze verify /etc/systemd/system/vitre-runtime-pull.service /etc/systemd/system/vitre-runtime-pull.timer
systemctl daemon-reload
systemctl enable --now vitre-runtime-pull.timer
