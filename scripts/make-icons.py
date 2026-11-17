"""Generate the app's original geometric icon without external image packages."""
from pathlib import Path
import math
import struct
import zlib

ROOT = Path(__file__).resolve().parent.parent / "assets"
ROOT.mkdir(exist_ok=True)


def segment_distance(x, y, ax, ay, bx, by):
    vx, vy = bx - ax, by - ay
    t = max(0, min(1, ((x - ax) * vx + (y - ay) * vy) / (vx * vx + vy * vy)))
    return math.hypot(x - ax - t * vx, y - ay - t * vy)


def png(size, tray=False):
    data = bytearray()
    border = [(0.5, 0.12, 0.81, 0.29), (0.81, 0.29, 0.81, 0.71), (0.81, 0.71, 0.5, 0.88), (0.5, 0.88, 0.19, 0.71), (0.19, 0.71, 0.19, 0.29), (0.19, 0.29, 0.5, 0.12)]
    letter = [(0.34, 0.67, 0.5, 0.32), (0.5, 0.32, 0.66, 0.67), (0.405, 0.55, 0.595, 0.55)]
    for iy in range(size):
        data.append(0)
        for ix in range(size):
            x, y = (ix + 0.5) / size, (iy + 0.5) / size
            d = min([segment_distance(x, y, *s) / 0.012 for s in border] + [segment_distance(x, y, *s) / 0.025 for s in letter])
            gold = max(0, min(1, (1.05 - d) * 3))
            rounded = (max(abs(x - .5) - .31, 0) ** 2 + max(abs(y - .5) - .31, 0) ** 2) ** .5 < .18
            if tray:
                data.extend((255, 255, 255, int(gold * 255)))
            else:
                bg = (20 + int(10 * (1 - y)), 28 + int(10 * (1 - y)), 39 + int(10 * (1 - y)))
                color = tuple(int(b * (1 - gold) + g * gold) for b, g in zip(bg, (224, 194, 133)))
                data.extend((*color, 255 if rounded else 0))
    def chunk(kind, content):
        return struct.pack(">I", len(content)) + kind + content + struct.pack(">I", zlib.crc32(kind + content) & 0xFFFFFFFF)
    return b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", size, size, 8, 6, 0, 0, 0)) + chunk(b"IDAT", zlib.compress(bytes(data), 9)) + chunk(b"IEND", b"")


images = {size: png(size) for size in [16, 32, 48, 128, 256, 512, 1024]}
(ROOT / "icon.png").write_bytes(images[512])
(ROOT / "tray.png").write_bytes(png(36, tray=True))
blocks = b"".join(code + struct.pack(">I", len(images[size]) + 8) + images[size] for size, code in [(16, b"icp4"), (32, b"icp5"), (128, b"ic07"), (256, b"ic08"), (512, b"ic09"), (1024, b"ic10")])
(ROOT / "icon.icns").write_bytes(b"icns" + struct.pack(">I", len(blocks) + 8) + blocks)
sizes = [16, 32, 48, 256]
offset = 6 + 16 * len(sizes)
entries = bytearray()
for size in sizes:
    entries.extend(struct.pack("<BBBBHHII", size % 256, size % 256, 0, 0, 1, 32, len(images[size]), offset))
    offset += len(images[size])
(ROOT / "icon.ico").write_bytes(struct.pack("<HHH", 0, 1, len(sizes)) + entries + b"".join(images[size] for size in sizes))
print("Generated PNG, ICNS, ICO and tray icon.")
