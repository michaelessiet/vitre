#!/usr/bin/env python3
"""Activate a verified runtime on an existing host without rewriting running workers."""
import hashlib
import json
import os
import pathlib
import re
import shutil
import stat
import subprocess
import sys
import tarfile
import tempfile
import time
import urllib.request

BASE = pathlib.Path("/opt/vitre-machine")
SERVICE = "vitre-machine.service"
ENV = pathlib.Path("/etc/vitre-machine-ci.env")
DROP = pathlib.Path("/etc/systemd/system/vitre-machine.service.d/zzzz-cloud-ci.conf")


def run(*args):
    result = subprocess.run(args, capture_output=True, text=True)
    if result.returncode:
        # Do not echo command output: machine configuration contains credentials.
        raise RuntimeError("Command failed: " + args[0])
    return result.stdout.strip()


def digest(path):
    value = hashlib.sha256()
    with open(path, "rb") as source:
        for chunk in iter(lambda: source.read(1024 * 1024), b""):
            value.update(chunk)
    return value.hexdigest()


def atomic(path, data, mode):
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, temporary = tempfile.mkstemp(prefix="." + path.name, dir=path.parent)
    try:
        with os.fdopen(fd, "wb") as output:
            os.fchmod(output.fileno(), mode)
            output.write(data)
            output.flush()
            os.fsync(output.fileno())
        os.replace(temporary, path)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)


def archive_path(name):
    path = pathlib.PurePosixPath(name)
    if path.is_absolute() or ".." in path.parts:
        raise RuntimeError("Unsafe runtime archive path")
    return path


def extract_runtime(archive, destination, previous):
    """Reuse identical immutable files; never change an older runtime's bytes or modes."""
    with tarfile.open(archive) as source:
        members = source.getmembers()
        names = {}
        links = set()
        for member in members:
            name = archive_path(member.name)
            if str(name) == "." and member.isdir():
                continue
            if name in names or not (member.isfile() or member.isdir() or member.issym() or member.islnk()):
                raise RuntimeError("Unsupported or duplicate runtime archive entry")
            names[name] = member
            if member.issym() or member.islnk():
                links.add(name)
            if member.islnk():
                archive_path(member.linkname)
        if any(parent in links for name in names for parent in name.parents):
            raise RuntimeError("Runtime archive traverses a link")
        required = ["usr/local/bin/node", "opt/vitre/cloud/machine-agent.mjs", "opt/vitre/cloud/worker.mjs", "opt/vitre/server/dist/bin.mjs"]
        if any(pathlib.PurePosixPath(name) not in names for name in required):
            raise RuntimeError("Incomplete runtime archive")
        destination.mkdir(mode=0o755)
        for name, member in names.items():
            target = destination / name
            target.parent.mkdir(parents=True, exist_ok=True)
            if member.isdir():
                target.mkdir(exist_ok=True)
            elif member.isfile():
                if shutil.disk_usage(destination).free < member.size + 512 * 1024 * 1024:
                    raise RuntimeError("Insufficient disk space; previous runtime remains active")
                with source.extractfile(member) as reader, open(target, "xb") as writer:
                    shutil.copyfileobj(reader, writer)
                old = previous / name
                old_stat = old.stat() if old.is_file() and old.resolve().is_relative_to(previous.resolve()) else None
                if (old_stat and stat.S_IMODE(old_stat.st_mode) == member.mode
                        and old_stat.st_uid == member.uid and old_stat.st_gid == member.gid
                        and old_stat.st_size == member.size and digest(old) == digest(target)):
                    target.unlink()
                    os.link(old, target)
                else:
                    os.chmod(target, member.mode)
                    os.chown(target, member.uid, member.gid)
        # Hard links must point directly to regular files in this archive.
        for name, member in names.items():
            target = destination / name
            if member.issym():
                target.symlink_to(member.linkname)
            elif member.islnk():
                linked = archive_path(member.linkname)
                if linked not in names or not names[linked].isfile():
                    raise RuntimeError("Invalid runtime hard link")
                os.link(destination / linked, target)
        for name, member in names.items():
            if member.isdir():
                os.chmod(destination / name, member.mode)
                os.chown(destination / name, member.uid, member.gid)


def properties(unit, *keys):
    return dict(line.split("=", 1) for line in run("systemctl", "show", unit, "--property=" + ",".join(keys)).splitlines())


def process_environment(pid):
    return dict(part.decode().split("=", 1) for part in pathlib.Path("/proc", str(pid), "environ").read_bytes().split(b"\0") if b"=" in part)


def workers():
    result = {}
    for line in run("systemctl", "list-units", "--all", "--type=service", "--plain", "--no-legend", "vitre-attempt-*.service").splitlines():
        unit = line.split()[0]
        props = properties(unit, "MainPID", "ActiveState", "PartOf", "BindsTo")
        if props["ActiveState"] in ["active", "activating"]:
            if SERVICE in (props["PartOf"] + " " + props["BindsTo"]).split():
                raise RuntimeError("A worker depends on the supervisor lifetime; drain before upgrading")
            result[unit] = props["MainPID"]
    return result


def health(expected):
    until = time.monotonic() + 20
    while time.monotonic() < until:
        try:
            props = properties(SERVICE, "MainPID", "ActiveState")
            env = process_environment(props["MainPID"])
            if props["ActiveState"] == "active" and env.get("VITRE_MACHINE_ROOTFS") == str(expected):
                request = urllib.request.Request("http://127.0.0.1:9077/v1/health", headers={
                    "Authorization": "Bearer " + env["VITRE_MACHINE_TOKEN"],
                    "x-vitre-owner": env["VITRE_MACHINE_OWNER"],
                })
                with urllib.request.urlopen(request, timeout=2) as response:
                    result = json.load(response)
                    if result.get("ready") is True and result.get("protocol") == 1:
                        return
        except (OSError, ValueError, KeyError, RuntimeError):
            pass
        time.sleep(0.25)
    raise RuntimeError("Runtime health verification failed")


def activate(new, old):
    before = workers()
    prior = {path: (path.read_bytes(), stat.S_IMODE(path.stat().st_mode)) if path.exists() else None for path in [ENV, DROP]}
    try:
        atomic(ENV, ("VITRE_MACHINE_ROOTFS=" + str(new) + "\n").encode(), 0o600)
        config = "[Service]\nEnvironmentFile=" + str(ENV) + "\nExecStart=\nExecStart=" + str(new / "usr/local/bin/node") + " " + str(new / "opt/vitre/cloud/machine-agent.mjs") + "\n"
        atomic(DROP, config.encode(), 0o644)
        run("systemctl", "daemon-reload")
        run("systemctl", "restart", SERVICE)
        health(new)
        after = workers()
        if any(after.get(unit) != pid for unit, pid in before.items()):
            raise RuntimeError("An existing worker changed during runtime activation")
        return len(before)
    except BaseException:
        for path, saved in prior.items():
            if saved is None:
                path.unlink(missing_ok=True)
            else:
                atomic(path, *saved)
        run("systemctl", "daemon-reload")
        run("systemctl", "restart", SERVICE)
        health(old)
        raise


def main(archive, sha256, revision):
    if os.geteuid() != 0:
        raise RuntimeError("Run on the existing machine as root")
    if not re.fullmatch(r"[a-f0-9]{64}", sha256) or not re.fullmatch(r"[a-f0-9]{40}", revision):
        raise RuntimeError("Invalid runtime checksum or source revision")
    if digest(archive) != sha256:
        raise RuntimeError("Runtime checksum mismatch")
    props = properties(SERVICE, "MainPID", "ActiveState", "DropInPaths")
    if props["ActiveState"] != "active":
        raise RuntimeError("Existing machine supervisor must be active")
    if any(pathlib.Path(path).name > DROP.name for path in props["DropInPaths"].split()):
        raise RuntimeError("Unexpected later systemd override")
    old = pathlib.Path(process_environment(props["MainPID"]).get("VITRE_MACHINE_ROOTFS", str(BASE / "rootfs")))
    if old.parent != BASE or not re.fullmatch(r"rootfs[A-Za-z0-9_-]*", old.name) or old.is_symlink() or not old.is_dir():
        raise RuntimeError("Unexpected current runtime directory")
    new = BASE / ("rootfs-ci-" + revision[:12] + "-" + sha256[:12])
    metadata = {"revision": revision, "sha256": sha256}
    if new.exists():
        if json.loads((new / ".vitre-runtime.json").read_text()) != metadata:
            raise RuntimeError("Runtime directory has conflicting contents")
    else:
        with tempfile.TemporaryDirectory(prefix=".cloud-upgrade-", dir=BASE) as directory:
            staged = pathlib.Path(directory) / "rootfs"
            extract_runtime(archive, staged, old)
            for source in ["machine-agent.mjs", "worker.mjs", "lens.mjs"]:
                run(str(staged / "usr/local/bin/node"), "--check", str(staged / "opt/vitre/cloud" / source))
            atomic(staged / ".vitre-runtime.json", (json.dumps(metadata) + "\n").encode(), 0o644)
            os.rename(staged, new)
    count = activate(new, old)
    # Future reviewed releases can update the small polling client as well.
    updater = new / "opt/vitre/cloud/pull-runtime.py"
    if updater.is_file() and updater.resolve().is_relative_to(new.resolve()):
        atomic(BASE / "pull-runtime.py", updater.read_bytes(), 0o755)
    print(json.dumps({**metadata, "rootfs": str(new), "previousRootfs": str(old), "warmWorkersPreserved": count, "health": "ready"}))


if __name__ == "__main__":
    try:
        if len(sys.argv) != 4:
            raise RuntimeError("Usage: upgrade-machine.py ROOTFS.tar.gz SHA256 REVISION")
        main(*sys.argv[1:])
    except Exception as error:
        print(str(error) if isinstance(error, RuntimeError) else type(error).__name__, file=sys.stderr)
        sys.exit(1)
