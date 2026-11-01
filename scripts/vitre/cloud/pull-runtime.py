#!/usr/bin/env python3
"""Pull reviewed releases from one root-configured HTTPS origin; no AWS credentials."""
import fcntl
import hashlib
import json
import os
import pathlib
import re
import shutil
import subprocess
import sys
import tempfile
import urllib.error
import urllib.parse
import urllib.request

BASE = pathlib.Path("/opt/vitre-machine")
CONFIG = pathlib.Path("/etc/vitre-runtime-pull.json")
STATE = BASE / ".runtime-pull.json"


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        raise RuntimeError("Runtime distribution must not redirect")


def origin_url(value):
    url = urllib.parse.urlsplit(value)
    if (url.scheme != "https" or not url.hostname or url.username or url.password
            or url.query or url.fragment or url.path not in ["", "/"]):
        raise RuntimeError("Runtime origin must be HTTPS without credentials or a path")
    return value.rstrip("/") + "/"


def validate(manifest):
    if not isinstance(manifest, dict) or type(manifest.get("version")) is not int or manifest["version"] != 1:
        raise RuntimeError("Unsupported runtime release")
    for key, length in [("revision", 40), ("sha256", 64), ("installerSha256", 64)]:
        if not isinstance(manifest.get(key), str) or not re.fullmatch("[a-f0-9]{" + str(length) + "}", manifest[key]):
            raise RuntimeError("Invalid release identity")
    for key, limit in [("sizeBytes", 32 * 1024 ** 3), ("installerSizeBytes", 1024 ** 2), ("publishedAt", 2 ** 53 - 1)]:
        if type(manifest.get(key)) is not int or not 0 < manifest[key] <= limit:
            raise RuntimeError("Invalid release bounds")
    return manifest


def fetch(url):
    request = urllib.request.Request(url, headers={"Cache-Control": "no-cache", "User-Agent": "Vitre-runtime-updater/1"})
    return urllib.request.build_opener(NoRedirect).open(request, timeout=60)


def download(url, target, size, sha256, fetcher=fetch):
    value = hashlib.sha256()
    remaining = size
    with fetcher(url) as response, open(target, "xb") as output:
        while True:
            chunk = response.read(min(1024 * 1024, remaining + 1))
            if not chunk:
                break
            remaining -= len(chunk)
            if remaining < 0:
                raise RuntimeError("Release download exceeded its declared size")
            value.update(chunk)
            output.write(chunk)
    if remaining or value.hexdigest() != sha256:
        raise RuntimeError("Release download checksum or length mismatch")


def save_state(path, manifest):
    fd, temporary = tempfile.mkstemp(prefix=".runtime-state-", dir=path.parent)
    try:
        with os.fdopen(fd, "w") as output:
            os.fchmod(output.fileno(), 0o600)
            json.dump(manifest, output)
            output.flush()
            os.fsync(output.fileno())
        os.replace(temporary, path)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)


def install(installer, archive, manifest):
    result = subprocess.run(["/usr/bin/python3", str(installer), str(archive), manifest["sha256"], manifest["revision"]],
                            capture_output=True, text=True, timeout=1800)
    if result.returncode:
        raise RuntimeError("Runtime activation failed; previous runtime retained")
    result = json.loads(result.stdout.strip().splitlines()[-1])
    if any(result.get(key) != manifest[key] for key in ["revision", "sha256"]) or result.get("health") != "ready":
        raise RuntimeError("Runtime activation did not verify the release")


def poll(origin, base=BASE, state=STATE, fetcher=fetch, installer=install):
    origin = origin_url(origin)
    try:
        with fetcher(origin + "runtime-production.json") as response:
            data = response.read(16 * 1024 + 1)
        if len(data) > 16 * 1024:
            raise RuntimeError("Runtime release manifest is too large")
    except urllib.error.HTTPError as error:
        if error.code == 404:
            return "No release published"
        raise
    manifest = validate(json.loads(data))
    previous = validate(json.loads(state.read_text())) if state.exists() else None
    if previous:
        if manifest == previous:
            return "Release already installed"
        if manifest["publishedAt"] <= previous["publishedAt"]:
            return "Ignored older release pointer"
    if shutil.disk_usage(base).free < manifest["sizeBytes"] + 512 * 1024 ** 2:
        raise RuntimeError("Insufficient runtime download space")
    with tempfile.TemporaryDirectory(prefix=".runtime-pull-", dir=base) as directory:
        archive = pathlib.Path(directory) / "runtime.tar.gz"
        script = pathlib.Path(directory) / "upgrade.py"
        download(origin + "runtime-" + manifest["revision"] + "-" + manifest["sha256"] + ".tar.gz",
                 archive, manifest["sizeBytes"], manifest["sha256"], fetcher)
        download(origin + "runtime-installer-" + manifest["revision"] + "-" + manifest["installerSha256"] + ".py",
                 script, manifest["installerSizeBytes"], manifest["installerSha256"], fetcher)
        installer(script, archive, manifest)
    save_state(state, manifest)
    return "Installed runtime " + manifest["revision"]


def main():
    if os.geteuid() != 0:
        raise RuntimeError("Run the updater as root on the existing host")
    os.umask(0o077)
    with open("/run/lock/vitre-cloud-deploy.lock", "a") as lock:
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            return
        print(poll(json.loads(CONFIG.read_text())["origin"]))


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        print(str(error) if isinstance(error, RuntimeError) else type(error).__name__, file=sys.stderr)
        sys.exit(1)
