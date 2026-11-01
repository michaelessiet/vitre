import hashlib
import importlib.util
import io
import json
import pathlib
import tempfile
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location("pull_runtime", pathlib.Path(__file__).with_name("pull-runtime.py"))
pull = importlib.util.module_from_spec(spec)
spec.loader.exec_module(pull)


class PullRuntimeTest(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.base = pathlib.Path(self.directory.name)
        self.state = self.base / "state.json"
        self.archive = b"verified runtime"
        self.code = b"reviewed installer"
        self.manifest = {
            "version": 1, "revision": "a" * 40, "sha256": hashlib.sha256(self.archive).hexdigest(),
            "sizeBytes": len(self.archive), "installerSha256": hashlib.sha256(self.code).hexdigest(),
            "installerSizeBytes": len(self.code), "publishedAt": 1000,
        }
        self.installs = 0
        self.requests = []

    def fetch(self, url):
        self.requests.append(url)
        self.assertTrue(url.startswith("https://artifacts.example.com/"))
        return io.BytesIO(json.dumps(self.manifest).encode() if url.endswith(".json") else self.code if url.endswith(".py") else self.archive)

    def install(self, script, archive, manifest):
        self.assertEqual(script.read_bytes(), self.code)
        self.assertEqual(archive.read_bytes(), self.archive)
        self.assertEqual(manifest, self.manifest)
        self.assertFalse(self.state.exists())
        self.installs += 1

    def poll(self, installer=None):
        return pull.poll("https://artifacts.example.com", self.base, self.state, self.fetch, installer or self.install)

    def test_verified_release_installs_once_and_old_pointer_cannot_roll_back(self):
        self.assertIn("Installed", self.poll())
        self.assertEqual(json.loads(self.state.read_text()), self.manifest)
        self.assertIn("already installed", self.poll())
        self.manifest = {**self.manifest, "revision": "b" * 40, "publishedAt": 999}
        self.assertIn("older", self.poll())
        self.assertEqual(self.installs, 1)
        self.assertEqual(len(self.requests), 5)
        self.assertEqual(list(self.base.iterdir()), [self.state])

    def test_corrupt_or_truncated_artifact_never_runs_installer(self):
        for content in [b"corrupt runtime!", b"short", self.archive + b"too long"]:
            self.archive = content
            with self.assertRaises(RuntimeError):
                self.poll()
            self.assertEqual(self.installs, 0)
            self.assertFalse(self.state.exists())

    def test_installer_checksum_is_verified_before_execution(self):
        self.code = b"untrusted installer"
        with self.assertRaises(RuntimeError):
            self.poll()
        self.assertEqual(self.installs, 0)
        self.assertFalse(self.state.exists())

    def test_failed_activation_retries_without_marking_success(self):
        def fail(*_):
            raise RuntimeError("Activation failed")
        with self.assertRaises(RuntimeError):
            self.poll(fail)
        self.assertFalse(self.state.exists())
        self.assertIn("Installed", self.poll())

    def test_invalid_urls_manifests_and_redirects_fail_closed(self):
        for origin in ["http://example.com", "https://user:pass@example.com", "https://example.com/path", "https://example.com?token=secret"]:
            with self.assertRaises(RuntimeError):
                pull.origin_url(origin)
        for bad in [{"revision": "../other"}, {"sha256": "bad"}, {"sizeBytes": -1}, {"sizeBytes": True}, {"installerSizeBytes": 2 * 1024 ** 2}, {"publishedAt": 0}, {"version": 2}]:
            with self.assertRaises(RuntimeError):
                pull.validate({**self.manifest, **bad})
        with self.assertRaises(RuntimeError):
            pull.NoRedirect().redirect_request(None, None, 302, "", {}, "https://other.example")

    def test_installer_receipt_must_match_requested_release(self):
        with patch.object(pull.subprocess, "run") as run:
            run.return_value.returncode = 0
            for receipt in [{"health": "ready", "revision": "b" * 40, "sha256": self.manifest["sha256"]}, {"health": "failed", **self.manifest}]:
                run.return_value.stdout = json.dumps(receipt)
                with self.assertRaises(RuntimeError):
                    pull.install("installer", "archive", self.manifest)


if __name__ == "__main__":
    unittest.main()
