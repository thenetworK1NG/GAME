"""Ground-truth check of models/plushie.glb: resolve each joint's WORLD
transform by composing the node hierarchy with the animation applied, then
confirm the walk cycle keeps the root still and plants the feet.

Run:  python tools/verify_anim.py
"""
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
    print("[%s] %s%s" % ("PASS" if condition else "FAIL", label,
                         (" -> " + detail) if detail else ""))
    if not condition:
        failures.append(label)


def quat_to_matrix(q):
    x, y, z, w = q
    return np.array([
        [1 - 2 * (y * y + z * z), 2 * (x * y - z * w), 2 * (x * z + y * w)],
        [2 * (x * y + z * w), 1 - 2 * (x * x + z * z), 2 * (y * z - x * w)],
        [2 * (x * z - y * w), 2 * (y * z + x * w), 1 - 2 * (x * x + y * y)],
    ])


def compose(t, r, s):
    m = np.eye(4)
    m[:3, :3] = quat_to_matrix(r) @ np.diag(s)
    m[:3, 3] = t
    return m


def main():
    with open(GLB, "rb") as fh:
        data = fh.read()

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
        return np.frombuffer(binary, dtype=np.dtype(COMPONENT[acc["componentType"]]),
                             count=count, offset=start).reshape(-1, NCOMP[acc["type"]])

    nodes = gltf["nodes"]
    parent = {}
    for index, node in enumerate(nodes):
        for child in node.get("children", []):
            parent[child] = index

    joints = gltf["skins"][0]["joints"]
    names = {i: nodes[i].get("name", "?") for i in joints}

    def world_positions(anim_name):
        anim = next(a for a in gltf["animations"] if a["name"] == anim_name)

        # node -> {path: (times, values)}
        tracks = {}
        times_all = []
        for channel in anim["channels"]:
            sampler = anim["samplers"][channel["sampler"]]
            times = accessor(sampler["input"]).ravel()
            values = accessor(sampler["output"])
            tracks.setdefault(channel["target"]["node"], {})[channel["target"]["path"]] = (times, values)
            times_all.append(times)
        times_all = np.unique(np.concatenate(times_all))

        out = {name: [] for name in names.values()}
        for t in times_all:
            local = {}
            for i, node in enumerate(nodes):
                track = tracks.get(i, {})
                if "translation" in track:
                    kt = int(np.argmin(np.abs(track["translation"][0] - t)))
                    trans = track["translation"][1][kt]
                else:
                    trans = node.get("translation", [0, 0, 0])
                if "rotation" in track:
                    kr = int(np.argmin(np.abs(track["rotation"][0] - t)))
                    v = track["rotation"][1][kr]
                    rot = [v[3], v[0], v[1], v[2]]
                else:
                    q = node.get("rotation", [0, 0, 0, 1])
                    rot = [q[3], q[0], q[1], q[2]]
                if "scale" in track:
                    ks = int(np.argmin(np.abs(track["scale"][0] - t)))
                    scl = track["scale"][1][ks]
                else:
                    scl = node.get("scale", [1, 1, 1])
                local[i] = compose(trans, rot, scl)

            # Resolve parents before children: node indices are NOT
            # topologically sorted, so walk the tree rather than the array.
            world = {}
            stack = [i for i in range(len(nodes)) if i not in parent]
            while stack:
                i = stack.pop()
                m = local[i]
                p = parent.get(i)
                if p is not None:
                    m = world[p] @ m
                world[i] = m
                stack.extend(nodes[i].get("children", []))

            for j in joints:
                out[names[j]].append(world[j][:3, 3])
        return {k: np.array(v) for k, v in out.items()}

    walk = world_positions("Walk")
    idle = world_positions("Idle")

    scale = 3.043 / 62.27  # derived earlier; only used to sanity-scale prints

    # --- Root must not travel while walking ---
    for bone in ("mixamorig:Hips", "mixamorig:Spine", "mixamorig:Head"):
        travel = np.ptp(walk[bone], axis=0)
        print("[info] %-22s walk world span = %s" % (bone, np.round(travel, 4)))
    root_span = np.ptp(walk["mixamorig:Hips"], axis=0)
    # vertical bob is legitimate; horizontal drift is not.
    vertical = root_span[1]
    horizontal = max(root_span[0], root_span[2])
    check("walk root stays planted horizontally", horizontal < 0.05,
          "%.4f" % horizontal)
    check("walk root keeps vertical bob", vertical > 0.005,
          "%.4f" % vertical)

    # --- Feet must swap which one is planted (that is what sells walking) ---
    left = walk["mixamorig:LeftFoot"][:, 1]
    right = walk["mixamorig:RightFoot"][:, 1]
    left_low_first = left[0] < right[0]
    swapped = left_low_first != (left[-1] < right[-1])
    check("feet swap contact across cycle", swapped,
          "left low at start=%s, at end=%s" % (left_low_first, left[-1] < right[-1]))
    check("foot heights differ (real stride)", np.ptp(left - right) > 0.01,
          "max diff %.4f" % np.ptp(left - right))

    # --- Feet should not sink far below or float above the ground ---
    # Scale: mesh bbox height 3.043 corresponds to hips->headtop 62.27.
    foot_min = min(left.min(), right.min())
    ground = min(
        walk["mixamorig:LeftToeBase"][:, 1].min(),
        walk["mixamorig:RightToeBase"][:, 1].min(),
    )
    print("[info] toe min world y = %.5f  (foot min y = %.5f)" % (ground, foot_min))
    check("toes reach the ground plane", abs(ground) < 0.05, "%.5f" % ground)

    # --- Idle should be a standing sway, not locomotion ---
    idle_root = np.ptp(idle["mixamorig:Hips"], axis=0)
    check("idle root is nearly static", max(idle_root[0], idle_root[2]) < 0.5,
          "x %.4f z %.4f" % (idle_root[0], idle_root[2]))
    print("[info] idle root span = %s" % np.round(idle_root, 4))

    # --- Idle vs walk should be visibly different poses ---
    pose_gap = np.linalg.norm(idle["mixamorig:LeftHand"].mean(axis=0)
                              - walk["mixamorig:LeftHand"].mean(axis=0))
    print("[info] mean hand gap idle vs walk = %.4f" % pose_gap)
    check("idle and walk are different poses", pose_gap > 0.5, "%.4f" % pose_gap)

    print()
    if failures:
        print("FAILED: %s" % ", ".join(failures))
        return 1
    print("All animation checks passed.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
