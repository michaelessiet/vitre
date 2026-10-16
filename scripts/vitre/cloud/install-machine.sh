#!/bin/sh
# Provider-independent install on an existing Ubuntu/Debian systemd host.
# Run with a verified Docker-export rootfs tar, its SHA256, and an existing 0600
# /etc/vitre-machine.env containing OWNER, TOKEN, CONTROL_URL (see docs).
set -eu
[ "$(id -u)" = 0 ] || { echo 'Run as root' >&2; exit 1; }
[ "$#" = 2 ] || { echo 'Usage: install-machine.sh ROOTFS.tar SHA256' >&2; exit 1; }
[ -f /etc/vitre-machine.env ] || { echo 'Create /etc/vitre-machine.env first' >&2; exit 1; }
[ ! -e /opt/vitre-machine/rootfs ] || { echo 'Runtime already installed; use a drained, versioned upgrade' >&2; exit 1; }
printf '%s  %s\n' "$2" "$1" | sha256sum --check --status
apt-get update
apt-get install -y --no-install-recommends bubblewrap ca-certificates
install -d -m 755 /opt/vitre-machine/rootfs
# The verified, operator-built archive contains no host credentials.
tar --extract --file "$1" --directory /opt/vitre-machine/rootfs --numeric-owner
chmod 600 /etc/vitre-machine.env
cat > /etc/systemd/system/vitre-machine.service <<'UNIT'
[Unit]
Description=Vitre persistent machine agent
After=network-online.target
Wants=network-online.target
[Service]
Type=simple
EnvironmentFile=/etc/vitre-machine.env
ExecStart=/opt/vitre-machine/rootfs/usr/local/bin/node /opt/vitre-machine/rootfs/opt/vitre/cloud/machine-agent.mjs
Restart=on-failure
RestartSec=3
UMask=0077
[Install]
WantedBy=multi-user.target
UNIT
systemctl daemon-reload
systemctl enable --now vitre-machine.service
printf 'Agent installed on 127.0.0.1:9077. Configure its authenticated HTTPS tunnel before assigning it in the relay.\n'
