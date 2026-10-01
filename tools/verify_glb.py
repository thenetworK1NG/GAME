"""Validate models/plushie.glB without loading three.js: clip names, loop
closure, texture count, bounds. Run:  python tools/verify_glb.py"""
import json
import os
import struct
import sys

import numpy as np

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
GLB = os.path.join(ROOT, "models", "plushie.glb")

COMPONENT = {5126: "f4", 5123: "u2", 5125: "u4", 5121: "u1"}
NCOMP = {"SCALAR": 1, "VEC2": 2, "VEC3": 3, "VEC4": 4, "MAT4": 16}

failures = []


def check(label, condition, detail=""):
    status = "PASS" if condition else "FAIL"
    print("[%s] %s%s" % (status, label, (" -> " + detail) if detail else ""))
    if not condition:
        failures.append(label)


def main():
    if not os.path.exists(GLB):
        print("missing %s" % GLB)
        return 1

    with open(GLB, "rb") as fh:
        data = fh.read()

    magic, version, _total = struct.unpack("<III", data[:12])
    check("glb magic", magic == 0x46546C67, hex(magic))
    check("glb version 2", version == 2, str(version))

    offset = 12
    json_len, _ = struct.unpack("<II", data[offset:offset + 8])
    gltf = json.loads(data[offset + 8:offset + 8 + json_len].decode("utf-8"))

    bin_offset = offset + 8 + json_len
    bin_len, _ = struct.unpack("<II", data[bin_offset:bin_offset + 8])
    binary = data[bin_offset + 8:bin_offset + 8 + bin_len]

    def accessor(index):
        acc = gltf["accessors"][index]
        view = gltf["bufferViews"][acc["bufferView"]]
        start = view.get("byteOffset", 0) + acc.get("byteOffset", 0)
        count = acc["count"] * NCOMP[acc["type"]]
        return np.frombuffer(
            binary, dtype=np.dtype(COMPONENT[acc["componentType"]]),
            count=count, offset=start,
        ).reshape(-1, NCOMP[acc["type"]])

    anims = {a["name"]: a for a in gltf.get("animations", [])}
    check("two clips", len(anims) == 2, ", ".join(sorted(anims)))
    check("clip named Idle", "Idle" in anims)
    check("clip named Walk", "Walk" in anims)

    nodes = gltf["nodes"]
    for name, expected in (("Idle", 8.3), ("Walk", 0.97)):
        if name not in anims:
            continue
        anim = anims[name]
        hips = [
            ch for ch in anim["channels"]
            if ch["target"]["path"] == "translation"
            and "Hips" in nodes[ch["target"]["node"]].get("name", "")
        ]
        check("%s animates Hips translation" % name, len(hips) == 1)
        if not hips:
            continue
        sampler = anim["samplers"][hips[0]["sampler"]]
        times = accessor(sampler["input"]).ravel()
        values = accessor(sampler["output"])

        duration = float(times.max() - times.min())
        check("%s duration ~%.2fs" % (name, expected),
              abs(duration - expected) < 0.1, "%.3fs" % duration)

        # Loop closure: first and last key must agree for a seamless cycle.
        loop_err = float(np.linalg.norm(values[0] - values[-1]))
        check("%s loop closes" % name, loop_err < 0.01, "err %.5f" % loop_err)

        # Walk must be in-place: the root should not travel along the ground.
        if name == "Walk":
            ground = values[:, 1]
            lateral = values[:, 2]
            check("walk is in-place (no root travel)",
                  float(np.ptp(ground)) < 0.05 and float(np.ptp(lateral)) < 0.05,
                  "y-span %.4f z-span %.4f" % (np.ptp(ground), np.ptp(lateral)))
            # ...but vertical bob should survive the root-motion strip.
            check("walk keeps vertical bob",
                  float(np.ptp(values[:, 0])) > 0.5,
                  "x-span %.4f" % np.ptp(values[:, 0]))

    skins = gltf.get("skins", [])
    check("has one skin", len(skins) == 1, str([s.get("name") for s in skins]))
    if skins:
        check("49 joints", len(skins[0]["joints"]) == 49, str(len(skins[0]["joints"])))

    images = gltf.get("images", [])
    check("single texture", len(images) == 1, str([i.get("mimeType") for i in images]))
    check("one texture sampler", len(gltf.get("textures", [])) == 1)

    lo = np.array([1e9] * 3)
    hi = np.array([-1e9] * 3)
    for mesh in gltf.get("meshes", []):
        for prim in mesh["primitives"]:
            pos = accessor(prim["attributes"]["POSITION"])
            lo = np.minimum(lo, pos.min(axis=0))
            hi = np.maximum(hi, pos.max(axis=0))
    size = hi - lo
    print("[info] bbox size = %.3f x %.3f x %.3f" % (size[0], size[1], size[2]))
    print("[info] min y = %.4f (feet should sit on 0)" % lo[1])
    check("feet on ground plane", abs(lo[1]) < 0.02, "%.4f" % lo[1])
    check("upright (Y is tallest)", size[1] > size[0] and size[1] > size[2])

    print("[info] file size = %.2f MB" % (len(data) / 1048576.0))

    print()
    if failures:
        print("FAILED: %s" % ", ".join(failures))
        return 1
    print("All checks passed.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
