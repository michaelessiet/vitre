import importlib.util
import io
import os
import pathlib
import tarfile
import tempfile
import unittest
from types import SimpleNamespace
from unittest.mock import patch

spec = importlib.util.spec_from_file_location("upgrade", pathlib.Path(__file__).with_name("upgrade-machine.py"))
upgrade = importlib.util.module_from_spec(spec)
spec.loader.exec_module(upgrade)


class UpgradeTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.base = pathlib.Path(self.temp.name)
        self.old = self.base / "old"
        self.old.mkdir()
        self.new = self.base / "new"
        self.archive = self.base / "runtime.tar.gz"

    def archive_files(self, additions=None):
        files = {"usr/local/bin/node": b"node", "opt/vitre/cloud/machine-agent.mjs": b"new agent", "opt/vitre/cloud/worker.mjs": b"worker", "opt/vitre/server/dist/bin.mjs": b"server"}
        files.update(additions or {})
        with tarfile.open(self.archive, "w:gz") as archive:
            for name, content in files.items():
                info = tarfile.TarInfo(name)
                info.size = len(content)
                info.mode = 0o644
                info.uid, info.gid = os.getuid(), os.getgid()
                archive.addfile(info, io.BytesIO(content))

    def test_reuses_unchanged_files_without_mutating_old_workers(self):
        self.archive_files()
        shared = self.old / "usr/local/bin/node"
        shared.parent.mkdir(parents=True)
        shared.write_bytes(b"node")
        shared.chmod(0o644)
        changed = self.old / "opt/vitre/cloud/machine-agent.mjs"
        changed.parent.mkdir(parents=True)
        changed.write_bytes(b"old agent")
        upgrade.extract_runtime(self.archive, self.new, self.old)
        self.assertEqual(shared.stat().st_ino, (self.new / "usr/local/bin/node").stat().st_ino)
        self.assertEqual(changed.read_bytes(), b"old agent")
        self.assertEqual((self.new / "opt/vitre/cloud/machine-agent.mjs").read_bytes(), b"new agent")

    def test_rejects_traversal_before_extracting(self):
        self.archive_files({"../escaped": b"bad"})
        with self.assertRaisesRegex(RuntimeError, "Unsafe"):
            upgrade.extract_runtime(self.archive, self.new, self.old)
        self.assertFalse(self.new.exists())
        self.assertFalse((self.base / "escaped").exists())

    def test_keeps_disk_reserve_for_existing_workers(self):
        self.archive_files()
        with patch.object(upgrade.shutil, "disk_usage", return_value=SimpleNamespace(free=1)):
            with self.assertRaisesRegex(RuntimeError, "Insufficient disk space"):
                upgrade.extract_runtime(self.archive, self.new, self.old)
        self.assertEqual(list(self.old.iterdir()), [])

    def test_rejects_files_beneath_an_archive_symlink(self):
        self.archive_files()
        with tarfile.open(self.archive, "r:gz") as source:
            original = [(m, source.extractfile(m).read()) for m in source.getmembers()]
        with tarfile.open(self.archive, "w:gz") as archive:
            link = tarfile.TarInfo("opt/vitre")
            link.type, link.linkname = tarfile.SYMTYPE, "/tmp/outside"
            archive.addfile(link)
            for member, content in original:
                archive.addfile(member, io.BytesIO(content))
        with self.assertRaisesRegex(RuntimeError, "traverses a link"):
            upgrade.extract_runtime(self.archive, self.new, self.old)
        self.assertFalse(self.new.exists())

    def test_unhealthy_activation_restores_previous_configuration(self):
        env, drop = self.base / "env", self.base / "drop"
        env.write_bytes(b"old environment")
        env.chmod(0o600)
        drop.write_bytes(b"old service")
        with patch.object(upgrade, "ENV", env), patch.object(upgrade, "DROP", drop), patch.object(upgrade, "run"), patch.object(upgrade, "workers", return_value={"worker": "123"}), patch.object(upgrade, "health", side_effect=[RuntimeError("unhealthy"), None]) as health:
            with self.assertRaisesRegex(RuntimeError, "unhealthy"):
                upgrade.activate(self.new, self.old)
            self.assertEqual(env.read_bytes(), b"old environment")
            self.assertEqual(drop.read_bytes(), b"old service")
            self.assertEqual(health.call_args.args, (self.old,))

    def test_activation_checks_existing_workers_survive(self):
        env, drop = self.base / "env", self.base / "drop"
        with patch.object(upgrade, "ENV", env), patch.object(upgrade, "DROP", drop), patch.object(upgrade, "run"), patch.object(upgrade, "health"), patch.object(upgrade, "workers", side_effect=[{"worker": "123"}, {"worker": "456"}]):
            with self.assertRaisesRegex(RuntimeError, "existing worker changed"):
                upgrade.activate(self.new, self.old)
        self.assertFalse(env.exists())
        self.assertFalse(drop.exists())


if __name__ == "__main__":
    unittest.main()
