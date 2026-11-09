import importlib.util
import io
import json
import os
from pathlib import Path
import shutil
import stat
import tempfile
import unittest
from unittest import mock
from urllib.parse import unquote, urlsplit
import posixpath
import re
import warnings
import zipfile


ROOT = Path(__file__).resolve().parents[1]
SPEC = importlib.util.spec_from_file_location("release", ROOT / "scripts/release.py")
release = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(release)
TAG = "v0.1.0"


class ReleaseTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name) / "source"
        self.root.mkdir()
        for name in release.RUNTIME_FILES:
            target = self.root / name
            target.parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(ROOT / name, target)
        for name in ("assets", "skills"):
            shutil.copytree(ROOT / name, self.root / name)
        for name in release.MANIFESTS:
            self.update_json(name, lambda data: data.update(version=TAG[1:]))
        catalog_path = self.root / ".claude-plugin/marketplace.json"
        catalog = json.loads(catalog_path.read_bytes())
        for entry in catalog["plugins"]:
            if "version" in entry:
                entry["version"] = TAG[1:]
        catalog_path.write_text(json.dumps(catalog))
        self.out = Path(self.temporary.name) / "dist"

    def update_json(self, name, change):
        path = self.root / name
        data = json.loads(path.read_bytes())
        change(data)
        path.write_text(json.dumps(data))

    def build(self):
        release.build(self.root, TAG, self.out)
        return self.out / release.archive_name(TAG)

    def replace_archive(self, entries):
        source = self.out / release.archive_name(TAG)
        output = io.BytesIO()
        with zipfile.ZipFile(output, "w") as archive:
            with warnings.catch_warnings():
                warnings.simplefilter("ignore", UserWarning)
                for name, content in entries:
                    archive.writestr(name, content)
        source.write_bytes(output.getvalue())
        checksums_path = self.out / "SHA256SUMS"
        checksums = release.read_checksums(checksums_path, TAG)
        checksums[source.name] = release.digest(source.read_bytes())
        checksums_path.write_text("".join(f"{checksums[name]}  {name}\n" for name in sorted(checksums)))
        return source

    def test_build_is_deterministic_and_only_contains_runtime_files(self):
        for name in (".github/workflows/private.yml", "scripts/private.py", "tests/private.py",
                     ".git/config", "unrelated.txt", "assets/.DS_Store"):
            path = self.root / name
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text("must not ship")
        shutil.rmtree(self.root / ".git")
        source = self.build()
        before = {path.name: path.read_bytes() for path in self.out.iterdir()}
        for path in self.root.rglob("*"):
            if path.is_file():
                os.utime(path, (1700000000, 1700000000))
                path.chmod(0o600)
        release.build(self.root, TAG, self.out)
        self.assertEqual(before, {path.name: path.read_bytes() for path in self.out.iterdir()})
        self.assertEqual(set(before), release.asset_names(TAG) | {"SHA256SUMS"})
        with zipfile.ZipFile(source) as archive:
            self.assertEqual(archive.namelist(), sorted(archive.namelist()))
            self.assertTrue(release.RUNTIME_FILES <= set(archive.namelist()))
            for entry in archive.infolist():
                self.assertNotIn("must not ship", archive.read(entry).decode("utf-8", errors="replace"))
                self.assertEqual(entry.date_time, (1980, 1, 1, 0, 0, 0))
                self.assertEqual(entry.external_attr >> 16, stat.S_IFREG | 0o644)
        release.verify(TAG, self.out)

    def test_check_infers_tag_and_rejects_invalid_or_mismatched_versions(self):
        _, tag = release.check(self.root)
        self.assertEqual(tag, TAG)
        for tag in ("0.1.0", "v00.1.0", "v0.01.0", "v0.1.00", "v0.1.0-alpha", "v0.1.0+build", "v0.1.1"):
            with self.subTest(tag=tag), self.assertRaises(ValueError):
                release.check(self.root, tag)
        for manifest in release.MANIFESTS:
            with self.subTest(manifest=manifest):
                original = (self.root / manifest).read_bytes()
                self.update_json(manifest, lambda data: data.update(version="0.2.0"))
                with self.assertRaisesRegex(ValueError, "version does not match"):
                    release.check(self.root, TAG)
                (self.root / manifest).write_bytes(original)

    def test_required_metadata_schemas_and_public_default_are_enforced(self):
        cases = [
            ("plugin.json", lambda data: data.pop("$schema")),
            ("plugin.json", lambda data: data.update(repository="https://example.com")),
            (".claude-plugin/plugin.json", lambda data: data.update(mcpServers={"private": {"url": "https://example.com"}})),
            ("mcp.json", lambda data: data.pop("$schema")),
            (".mcp.json", lambda data: data["mcpServers"]["budna"].update(url="https://api.budna.se/account/mcp")),
            ("mcp.json", lambda data: data["mcpServers"]["budna"].update(headers={"Authorization": "secret"})),
            ("gemini-extension.json", lambda data: data["mcpServers"]["budna"].update(env={"TOKEN": "secret"})),
            (".claude-plugin/plugin.json", lambda data: data.update(icon="../outside.png")),
            (".codex-plugin/plugin.json", lambda data: data.update(mcpServers="./missing.json")),
            (".claude-plugin/marketplace.json", lambda data: data["plugins"][0].update(source="../outside")),
        ]
        for manifest, change in cases:
            with self.subTest(manifest=manifest):
                original = (self.root / manifest).read_bytes()
                self.update_json(manifest, change)
                with self.assertRaises(ValueError):
                    release.check(self.root, TAG)
                (self.root / manifest).write_bytes(original)

    def test_checkout_symlinks_and_submodules_are_rejected(self):
        path = self.root / "assets/icon.svg"
        path.unlink()
        path.symlink_to(self.root / "README.md")
        with self.assertRaisesRegex(ValueError, "regular file required"):
            release.check(self.root, TAG)
        path.unlink()
        path.write_text("<svg/>")
        (self.root / ".gitmodules").write_text("[submodule \"external\"]")
        with self.assertRaisesRegex(ValueError, "submodules"):
            release.check(self.root, TAG)

    def test_export_uses_complete_pinned_payload_and_target_manifest_subset(self):
        source = self.build()
        before = (self.root / "README.md").read_bytes()
        shutil.rmtree(self.root)
        expected_manifests = {
            "claude": {".claude-plugin/plugin.json"},
            "openai": {".codex-plugin/plugin.json"},
            "gemini": set(),
            "cursor": set(),
            "copilot": set(),
            "grok": {".claude-plugin/plugin.json"},
        }
        with zipfile.ZipFile(source) as universal:
            common = {name for name in universal.namelist()
                      if name.startswith(("skills/", "assets/")) or name in
                      ("README.md", "LICENSE", "plugin.json", "mcp.json", ".mcp.json", "gemini-extension.json")}
            for target, manifests in expected_manifests.items():
                with self.subTest(target=target):
                    out = Path(self.temporary.name) / "exported" / target
                    release.export(TAG, target, source, self.out / "SHA256SUMS", out)
                    name = release.archive_name(TAG, target)
                    self.assertEqual((out / name).read_bytes(), (self.out / name).read_bytes())
                    self.assertEqual((out / (name + ".sha256")).read_text(),
                                     f"{release.digest((out / name).read_bytes())}  {name}\n")
                    with zipfile.ZipFile(out / name) as archive:
                        self.assertEqual(set(archive.namelist()), common | manifests)
                        self.assertEqual(archive.read("README.md"), before)
                        for href in re.findall(r"\[[^\]]*\]\(([^)]+)\)", before.decode()):
                            parsed = urlsplit(href)
                            if not parsed.scheme and not parsed.netloc and parsed.path:
                                path = posixpath.normpath(unquote(parsed.path))
                                self.assertIn(path, archive.namelist(), f"broken README link in {target}: {href}")
                        for file in common:
                            self.assertEqual(archive.read(file), universal.read(file))
                        if target == "openai":
                            metadata = json.loads(archive.read(".codex-plugin/plugin.json"))
                            self.assertIn(metadata["mcpServers"][2:], archive.namelist())

    def test_corrupted_universal_and_target_assets_fail_verification(self):
        source = self.build()
        original = source.read_bytes()
        source.write_bytes(original + b"corrupted")
        with self.assertRaisesRegex(ValueError, "universal ZIP checksum mismatch"):
            release.export(TAG, "claude", source, self.out / "SHA256SUMS", self.out / "exported")
        source.write_bytes(original)
        target = self.out / release.archive_name(TAG, "claude")
        target.write_bytes(target.read_bytes() + b"corrupted")
        with self.assertRaisesRegex(ValueError, "target ZIP checksum mismatch"):
            release.verify(TAG, self.out)

    def test_unsafe_and_duplicate_zip_entries_are_rejected_before_writing(self):
        self.build()
        files, _ = release.check(self.root, TAG)
        cases = ["../outside", "/absolute", "assets\\outside", "assets//outside", "./README.md", ".git/config", "scripts/run.py"]
        for name in cases:
            with self.subTest(name=name):
                source = self.replace_archive([*files.items(), (name, b"untrusted")])
                with self.assertRaises(ValueError):
                    release.export(TAG, "claude", source, self.out / "SHA256SUMS", self.out / "exported")
        source = self.replace_archive([*files.items(), ("README.md", b"duplicate")])
        with self.assertRaisesRegex(ValueError, "duplicate ZIP entry"):
            release.export(TAG, "claude", source, self.out / "SHA256SUMS", self.out / "exported")
        self.assertFalse((self.out / "exported").exists())

    def test_symlink_directory_and_oversized_zip_entries_are_rejected(self):
        self.build()
        files, _ = release.check(self.root, TAG)
        for mode, name in ((stat.S_IFLNK | 0o777, "assets/linked"),
                           (stat.S_IFDIR | 0o755, "assets/directory/")):
            entry = zipfile.ZipInfo(name)
            entry.create_system = 3
            entry.external_attr = mode << 16
            source = self.replace_archive([*files.items(), (entry, b"README.md")])
            with self.subTest(name=name), self.assertRaises(ValueError):
                release.export(TAG, "gemini", source, self.out / "SHA256SUMS", self.out / "exported")
        source = self.replace_archive(list(files.items()))
        with mock.patch.object(release, "MAX_FILE_BYTES", 1), self.assertRaisesRegex(ValueError, "oversized ZIP entry"):
            release.export(TAG, "claude", source, self.out / "SHA256SUMS", self.out / "exported")

    def test_checksum_asset_set_and_target_snapshot_hash_are_enforced(self):
        source = self.build()
        path = self.out / "SHA256SUMS"
        original = path.read_text()
        for text in (original + original.splitlines()[0] + "\n", original.splitlines()[0] + "\n",
                     original.replace("budna-v0.1.0-grok.zip", "../outside.zip")):
            with self.subTest(text=text[-70:]):
                path.write_text(text)
                with self.assertRaises(ValueError):
                    release.export(TAG, "claude", source, path, self.out / "exported")
        checksums = dict(line.split("  ")[::-1] for line in original.splitlines())
        checksums[release.archive_name(TAG, "claude")] = "0" * 64
        path.write_text("".join(f"{value}  {name}\n" for name, value in sorted(checksums.items())))
        with self.assertRaisesRegex(ValueError, "derived target checksum mismatch"):
            release.export(TAG, "claude", source, path, self.out / "exported")
        self.assertFalse((self.out / "exported").exists())

    def test_ambiguous_zip_paths_are_rejected(self):
        self.build()
        files, _ = release.check(self.root, TAG)
        for name in ("skills/recommerce-buy", "assets/ICON.png"):
            source = self.replace_archive([*files.items(), (name, b"ambiguous")])
            with self.subTest(name=name), self.assertRaisesRegex(ValueError, "collision"):
                release.export(TAG, "claude", source, self.out / "SHA256SUMS", self.out / "exported")
        source = self.replace_archive([*files.items(), ("assets/Parent", b"file"),
                                       ("assets/parent/child.txt", b"ambiguous")])
        with self.assertRaisesRegex(ValueError, "collision"):
            release.export(TAG, "claude", source, self.out / "SHA256SUMS", self.out / "exported")


if __name__ == "__main__":
    unittest.main()
