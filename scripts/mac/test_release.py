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


if __name__ == "__main__":
    unittest.main()
