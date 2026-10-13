import hashlib
import importlib.util
import json
import pathlib
import struct
import tempfile
import unittest
import zlib


def module(name):
    spec = importlib.util.spec_from_file_location(name, pathlib.Path(__file__).with_name(name + ".py"))
    value = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(value)
    return value


manifest = module("manifest")
icon = module("icon")


class ReleaseTests(unittest.TestCase):
    def test_versions_must_increase_and_use_canonical_stable_semver(self):
        with tempfile.TemporaryDirectory() as folder:
            previous = pathlib.Path(folder) / "latest.json"
            previous.write_text(json.dumps({"version": "0.9.9"}))
            manifest.main(["newer", "0.10.0", str(previous)])
            for version in ("0.9.9", "0.9.8", "01.0.0", "1.0.0-beta", "1.0"):
                with self.assertRaises(ValueError):
                    manifest.main(["newer", version, str(previous)])

    def test_metadata_describes_final_artifact_bytes(self):
        with tempfile.TemporaryDirectory() as folder:
            dmg = pathlib.Path(folder) / "Tempo.dmg"
            output = pathlib.Path(folder) / "latest.json"
            payload = b"final signed and stapled bytes" * 100_000
            dmg.write_bytes(payload)
            manifest.main(["manifest", "0.2.0", str(dmg), str(output)])
            metadata = json.loads(output.read_text())
            self.assertEqual(metadata["size"], len(payload))
            self.assertEqual(metadata["sha256"], hashlib.sha256(payload).hexdigest())
            self.assertEqual(metadata["version"], "0.2.0")
            self.assertTrue(metadata["publishedAt"].endswith("+00:00"))

    def test_icon_png_has_valid_dimensions_crc_and_pixel_data(self):
        encoded = icon.png(32)
        self.assertEqual(encoded[:8], b"\x89PNG\r\n\x1a\n")
        offset = 8
        compressed = bytearray()
        while offset < len(encoded):
            size = struct.unpack(">I", encoded[offset:offset + 4])[0]
            kind = encoded[offset + 4:offset + 8]
            payload = encoded[offset + 8:offset + 8 + size]
            crc = struct.unpack(">I", encoded[offset + 8 + size:offset + 12 + size])[0]
            self.assertEqual(crc, zlib.crc32(kind + payload))
            if kind == b"IHDR":
                self.assertEqual(struct.unpack(">II", payload[:8]), (32, 32))
            if kind == b"IDAT":
                compressed.extend(payload)
            offset += size + 12
        self.assertEqual(len(zlib.decompress(compressed)), 32 * (32 * 4 + 1))

class DevLaunchTests(unittest.TestCase):
    def run_dev(self, identity=True, mode="--open"):
        import os
        import shutil
        import subprocess
        with tempfile.TemporaryDirectory() as folder:
            root = pathlib.Path(folder)
            scripts = root / "scripts/mac"
            scripts.mkdir(parents=True)
            shutil.copyfile(pathlib.Path(__file__).with_name("dev.sh"), scripts / "dev.sh")
            (scripts / "icon.py").write_text("")
            resources = root / "apps/mac/resources"
            resources.mkdir(parents=True)
            (resources / "Info.plist").write_text("fixture")
            binary = root / "target/debug"
            binary.mkdir(parents=True)
            (binary / "Tempo").write_text("fixture")
            (binary / "TempoKeychain").write_text("fixture")
            helper = root / "crates/tempo-keychain/src"
            helper.mkdir(parents=True)
            (helper / "main.rs").write_text("fixture")
            (helper.parent / "Cargo.toml").write_text("fixture")
            (root / "Cargo.lock").write_text("fixture")
            commands = root / "bin"
            commands.mkdir()
            log = root / "commands.log"
            stubs = {
                "pgrep": "exit 1",
                "uname": 'if [ "$1" = -s ]; then echo Darwin; else echo arm64; fi',
                "security": 'echo \'1) ABCDEF "Tempo Development"\'' if identity else 'echo "0 valid identities found"',
                "cargo": 'echo cargo >> "$TEMPO_TEST_COMMANDS"',
                "iconutil": 'echo iconutil >> "$TEMPO_TEST_COMMANDS"',
                "codesign": 'echo "codesign $*" >> "$TEMPO_TEST_COMMANDS"',
                "open": 'echo open >> "$TEMPO_TEST_COMMANDS"',
            }
            for name, body in stubs.items():
                path = commands / name
                path.write_text("#!/bin/sh\n" + body + "\n")
                path.chmod(0o700)
            env = dict(os.environ, PATH=str(commands) + ":" + os.environ["PATH"], TEMPO_TEST_COMMANDS=str(log))
            env.pop("TEMPO_MAC_SIGN_IDENTITY", None)
            result = subprocess.run(["bash", str(scripts / "dev.sh"), mode], env=env, capture_output=True, text=True)
            return result, log.read_text().splitlines() if log.exists() else []

    def test_missing_identity_stops_before_build_or_launch(self):
        result, commands = self.run_dev(identity=False)
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual(commands, [])
        self.assertIn("setup-dev-signing.sh", result.stderr)

    def test_debug_bundle_is_signed_and_verified_before_launch(self):
        result, commands = self.run_dev()
        self.assertEqual(result.returncode, 0, result.stderr)
        sign = next(i for i, command in enumerate(commands) if "--identifier dev.tempo.mac dist/" in command)
        verify = next(i for i, command in enumerate(commands) if "--verify --deep --strict" in command)
        self.assertIn("--sign Tempo Development", commands[sign])
        self.assertLess(sign, verify)
        self.assertLess(verify, len(commands) - 1)
        self.assertEqual(commands[-1], "open")

    def test_build_only_does_not_open_an_app(self):
        result, commands = self.run_dev(mode="--build-only")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertFalse("open" in commands)


if __name__ == "__main__":
    unittest.main()
