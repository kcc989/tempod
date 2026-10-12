"""Generate the app icon at the macOS iconset resolutions without extra packages."""
import pathlib
import struct
import sys
import zlib


def chunk(kind, data):
    return struct.pack(">I", len(data)) + kind + data + struct.pack(">I", zlib.crc32(kind + data))


def png(size):
    rows = bytearray()
    for y in range(size):
        rows.append(0)
        for x in range(size):
            nx, ny = x / size, y / size
            inside = 0.1 < nx < 0.9 and 0.1 < ny < 0.9
            mark = (0.28 < nx < 0.72 and 0.28 < ny < 0.4) or (0.44 < nx < 0.56 and 0.4 <= ny < 0.74)
            rows.extend((245, 247, 250, 255) if mark else (40, 58, 86, 255) if inside else (0, 0, 0, 0))
    return (b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", size, size, 8, 6, 0, 0, 0))
            + chunk(b"IDAT", zlib.compress(rows)) + chunk(b"IEND", b""))


if __name__ == "__main__":
    folder = pathlib.Path(sys.argv[1])
    folder.mkdir(parents=True, exist_ok=True)
    for size in (16, 32, 128, 256, 512):
        for scale in (1, 2):
            suffix = "@2x" if scale == 2 else ""
            (folder / f"icon_{size}x{size}{suffix}.png").write_bytes(png(size * scale))
