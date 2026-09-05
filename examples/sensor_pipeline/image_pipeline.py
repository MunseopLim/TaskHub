"""Python 표준 라이브러리로 센서 프레임 바이너리를 생성하고 검증합니다."""

import hashlib
import json
from pathlib import Path
import struct
import sys
import zlib


BUILD = Path(__file__).resolve().parent / "build"
IMAGE = BUILD / "sensor-node.bin"
MANIFEST = BUILD / "manifest.json"
COUNT = 1048576
HEADER = b"THUBDEMO" + struct.pack("<Q", COUNT)


def build():
    BUILD.mkdir(exist_ok=True)
    print("Build | Sensor Node binary image", flush=True)
    data = bytearray(HEADER)
    for sequence in range(COUNT):
        payload = struct.pack("<I", sequence)
        data.extend(payload)
        data.extend(struct.pack("<I", zlib.crc32(payload)))
    IMAGE.write_bytes(data)
    manifest = {"name": "Sensor Node", "frameCount": COUNT, "sizeBytes": len(data),
                "sha256": hashlib.sha256(data).hexdigest()}
    MANIFEST.write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf-8")
    print("  Created {:,} frames | {:,} bytes".format(COUNT, len(data)))
    print("  SHA-256 " + manifest["sha256"], flush=True)


def verify():
    print("Verify | Header, frame ordering, CRC32 and SHA-256", flush=True)
    data = IMAGE.read_bytes()
    manifest = json.loads(MANIFEST.read_text(encoding="utf-8"))
    if data[:16] != HEADER or len(data) != 16 + COUNT * 8:
        raise ValueError("Invalid binary header or file size")
    for sequence in range(COUNT):
        offset = 16 + sequence * 8
        number, checksum = struct.unpack_from("<II", data, offset)
        if number != sequence or checksum != zlib.crc32(data[offset:offset + 4]):
            raise ValueError("Frame {} failed ordering or CRC32 verification".format(sequence))
    if manifest["frameCount"] != COUNT or manifest["sizeBytes"] != len(data):
        raise ValueError("Manifest metadata mismatch")
    if manifest["sha256"] != hashlib.sha256(data).hexdigest():
        raise ValueError("SHA-256 mismatch")
    print("  PASS | {:,} frame CRC32 checks".format(COUNT))
    print("  PASS | Header, frame ordering and manifest SHA-256", flush=True)


if __name__ == "__main__":
    if sys.argv[1:] == ["build"]:
        build()
    elif sys.argv[1:] == ["verify"]:
        verify()
    else:
        raise SystemExit("Usage: python3 examples/sensor_pipeline/image_pipeline.py build|verify")
