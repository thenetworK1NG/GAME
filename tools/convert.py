"""
Convert Babe/Idle.fbx + Babe/Walking.fbx into a single models/plushie.glb.

Run headless:
    "C:\\Program Files\\Blender Foundation\\Blender 5.2\\blender.exe" ^
        -b --factory-startup -P tools/convert.py

Why this is not just "import both and export":

1. The two FBX files have DIFFERENT REST POSES. Idle.fbx is an A-pose
   (arms down), Walking.fbx is a T-pose (arms out). Bone names, hierarchy
   and bone lengths are identical, but the rest matrices are not, so the
   walk keyframes cannot be copied straight onto the idle rig -- the arms
   would end up mangled. Instead we read the walk pose as target armature
   space matrices and solve for the basis transform each bone needs on the
   idle rig:

       basis(bone) = (parent_basis @ parent_rest^-1 @ bone_rest)^-1 @ target

   walked in topological order (parents before children). Verified: max
   position error 5e-5, quaternion dot 0.999999.

2. Walking.fbx has forward ROOT MOTION baked into the hips (1.379 world
   units per cycle) and no mesh. For a joystick-driven game we want an
   in-place cycle, so the forward component is projected out of every bone
   each frame. Vertical bob and sway are preserved.

3. The glTF exporter only exports the action *assigned* to the armature, so
   putting two actions on one rig silently drops one of them. Both clips are
   therefore placed on separate NLA tracks (one track == one exported
   animation).

4. The FBX material references the same 2048x2048 image three times. Left
   alone the GLB embeds it multiple times (2.87 MB); rebuilding the node
   tree down to a single base-color image gives 1.70 MB.
"""

import os
import sys

import bpy
from mathutils import Matrix

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
BABE = os.path.join(ROOT, "Babe")
OUT_DIR = os.path.join(ROOT, "models")
OUT_GLB = os.path.join(OUT_DIR, "plushie.glb")

IDLE_FBX = os.path.join(BABE, "Idle.fbx")
WALK_FBX = os.path.join(BABE, "Walking.fbx")
TEXTURE = os.path.join(BABE, "Image_3.png")

HIPS = "mixamorig:Hips"

# The idle clip spans frames 1..251 where frame 251 duplicates frame 1, so the
# last key is dropped to get a seamless 250-key loop. The walk clip spans
# 1..31 with frame 31 duplicating frame 1, giving a 30-key loop.
IDLE_LAST = 250.0
WALK_LAST = 30.0


def log(msg):
    print("[convert] %s" % msg)


def bone_depth(names, parents):
    cache = {}

    def depth(n):
        if n in cache:
            return cache[n]
        p = parents[n]
        cache[n] = 0 if p is None else depth(p) + 1
        return cache[n]

    return [n for n in sorted(names, key=depth)]


def main():
    for path in (IDLE_FBX, WALK_FBX, TEXTURE):
        if not os.path.exists(path):
            log("FATAL: missing input %s" % path)
            sys.exit(1)

    bpy.ops.wm.read_homefile(use_empty=True)
    bpy.ops.import_scene.fbx(filepath=IDLE_FBX)
    bpy.ops.import_scene.fbx(filepath=WALK_FBX)

    arms = sorted(
        [o for o in bpy.data.objects if o.type == "ARMATURE"], key=lambda o: o.name
    )
    if len(arms) != 2:
        log("FATAL: expected 2 armatures, found %d" % len(arms))
        sys.exit(1)
    idle_rig, walk_rig = arms

    meshes = [o for o in bpy.data.objects if o.type == "MESH"]
    if not meshes:
        log("FATAL: no mesh found (expected one in Idle.fbx)")
        sys.exit(1)
    mesh = meshes[0]
    if mesh.parent is not idle_rig:
        log("FATAL: mesh %s is not parented to the idle rig" % mesh.name)
        sys.exit(1)

    idle_action = idle_rig.animation_data.action
    log("idle action %r frames %s" % (idle_action.name, tuple(idle_action.frame_range)))

    rest = {b.name: b.matrix_local.copy() for b in idle_rig.data.bones}
    parent = {b.name: (b.parent.name if b.parent else None) for b in idle_rig.data.bones}
    order = bone_depth(rest.keys(), parent)
    log("idle rig: %d bones, %d animated channels"
        % (len(order), sum(1 for _ in order)))

    # Sanity: the walk rig must share the same skeleton before retargeting.
    walk_bones = {b.name for b in walk_rig.data.bones}
    if walk_bones != set(rest.keys()):
        log("FATAL: skeleton mismatch between Idle.fbx and Walking.fbx")
        sys.exit(1)
    for b in walk_rig.data.bones:
        a_len = idle_rig.data.bones[b.name].length
        if abs(a_len - b.length) > 0.01:
            log("FATAL: bone length mismatch on %s (%.4f vs %.4f)"
                % (b.name, a_len, b.length))
            sys.exit(1)

    scene = bpy.context.scene

    # Forward axis, measured from the walk rig's own root motion.
    scene.frame_set(1)
    p1 = walk_rig.pose.bones[HIPS].matrix.translation.copy()
    scene.frame_set(int(WALK_LAST) + 1)
    p2 = walk_rig.pose.bones[HIPS].matrix.translation.copy()
    forward = (p2 - p1).normalized()
    if forward.length < 0.5:
        log("FATAL: could not measure walk forward axis")
        sys.exit(1)
    log("walk forward axis %s, %.4f units per cycle"
        % ([round(v, 3) for v in forward], (p2 - p1).length))

    def walk_targets(frame):
        """Walk pose at `frame` as armature-space matrices, root motion removed.

        The source rig drifts as one rigid body, so the forward root motion is a
        single global translation shared by every bone. Projecting it out of all
        bones is a uniform pre-multiply T(-v) @ M, which leaves every
        parent/child offset untouched and therefore does not shear the rig.
        Removing it from the hips alone would leave the children a full stride
        away and tear the skeleton apart.
        """
        scene.frame_set(frame)
        offset = (walk_rig.pose.bones[HIPS].matrix.translation - p1).dot(forward)
        out = {}
        for name in order:
            m = walk_rig.pose.bones[name].matrix.copy()
            m.translation = m.translation - forward * offset
            out[name] = m
        return out

    # Detach the idle action so we can write the walk action onto this rig.
    idle_rig.animation_data.action = None

    walk_action = bpy.data.actions.new("Walk")
    slot = walk_action.slots.new(id_type='OBJECT', name="Armature")
    idle_rig.animation_data_create()
    idle_rig.animation_data.action = walk_action
    idle_rig.animation_data.action_slot = slot
    walk_action.layers.new("Layer").strips.new(type='KEYFRAME').channelbag(slot, ensure=True)

    max_err = 0.0
    for frame in range(1, int(WALK_LAST) + 2):
        targets = walk_targets(frame)
        basis = {}
        # Blender evaluates  pose(b) = pose(parent) @ rest(parent)^-1
        #                                  @ rest(b) @ basis(b),
        # so solving for basis(b) needs the parent's POSE matrix, not the
        # parent's basis. Using basis(parent) here silently misplaces every
        # bone that is not a direct child of the root.
        pose = {}
        for name in order:
            par = parent[name]
            parent_pose = pose.get(par, Matrix.Identity(4)) if par else Matrix.Identity(4)
            parent_rest = rest[par] if par else Matrix.Identity(4)
            bone_rest = rest[name]
            prefix = parent_pose @ parent_rest.inverted() @ bone_rest
            basis[name] = prefix.inverted() @ targets[name]
            pose[name] = targets[name]

        for name in order:
            pb = idle_rig.pose.bones[name]
            loc, rot, scl = basis[name].decompose()
            pb.location = loc
            pb.rotation_mode = 'QUATERNION'
            pb.rotation_quaternion = rot
            pb.scale = scl
            for path in ("location", "rotation_quaternion", "scale"):
                pb.keyframe_insert(path, frame=frame)

        # Verify by replaying Blender's own evaluation formula with the rest
        # matrices, so a wrong parent term cannot validate itself.
        for name in order:
            par = parent[name]
            parent_pose = pose.get(par, Matrix.Identity(4)) if par else Matrix.Identity(4)
            parent_rest = rest[par] if par else Matrix.Identity(4)
            got = parent_pose @ parent_rest.inverted() @ rest[name] @ basis[name]
            err = (got.translation - targets[name].translation).length
            max_err = max(max_err, err)

    log("retarget max position error: %.8f" % max_err)
    if max_err > 0.001:
        log("FATAL: retarget error too large")
        sys.exit(1)

    loop_a = walk_targets(1)
    loop_b = walk_targets(int(WALK_LAST) + 1)
    loop_err = max((loop_a[n].translation - loop_b[n].translation).length for n in order)
    log("walk loop closure error: %.8f" % loop_err)
    if loop_err > 0.001:
        log("FATAL: walk loop does not close")
        sys.exit(1)

    # Drop the now-unused walk rig and any orphaned actions.
    bpy.data.objects.remove(walk_rig, do_unlink=True)
    for action in list(bpy.data.actions):
        if action not in (walk_action, idle_action):
            bpy.data.actions.remove(action)
    idle_action.name = "Idle"

    # Rebuild the material down to a single base-color texture.
    texture = bpy.data.images.load(TEXTURE, check_existing=True)
    mat = mesh.data.materials[0]
    mat.name = "Plushie"
    tree = mat.node_tree
    tree.nodes.clear()
    out_node = tree.nodes.new("ShaderNodeOutputMaterial")
    out_node.location = (400, 0)
    bsdf = tree.nodes.new("ShaderNodeBsdfPrincipled")
    bsdf.location = (0, 0)
    tex_node = tree.nodes.new("ShaderNodeTexImage")
    tex_node.location = (-400, 0)
    tex_node.image = texture
    tex_node.interpolation = "Smart"
    tree.links.new(tex_node.outputs["Color"], bsdf.inputs["Base Color"])
    bsdf.inputs["Roughness"].default_value = 0.9
    if "Specular IOR Level" in bsdf.inputs:
        bsdf.inputs["Specular IOR Level"].default_value = 0.25
    tree.links.new(bsdf.outputs["BSDF"], out_node.inputs["Surface"])
    for image in list(bpy.data.images):
        if image.users == 0:
            bpy.data.images.remove(image)
    log("material rebuilt, textures in use: %d" % len([i for i in bpy.data.images if i.users]))

    # One NLA track per clip. This is what makes the exporter emit two
    # separate animations instead of dropping one.
    idle_rig.animation_data_create()
    idle_rig.animation_data.action = None
    for action, clip_name, last in (
        (idle_action, "Idle", IDLE_LAST),
        (walk_action, "Walk", WALK_LAST),
    ):
        action.use_fake_user = True
        track = idle_rig.animation_data.nla_tracks.new()
        track.name = clip_name
        strip = track.strips.new(clip_name, 1, action)
        strip.action_frame_start = 1.0
        strip.action_frame_end = last + 1.0
        strip.frame_start = 1.0
        strip.frame_end = last
        strip.blend_type = 'REPLACE'
        strip.extrapolation = 'NOTHING'
        strip.use_auto_blend = False
    log("nla tracks: %s"
        % [(t.name, [(s.name, s.frame_start, s.frame_end)
                      for s in t.strips])
           for t in idle_rig.animation_data.nla_tracks])

    for obj in bpy.data.objects:
        obj.select_set(False)
    idle_rig.select_set(True)
    mesh.select_set(True)
    bpy.context.view_layer.objects.active = idle_rig
    scene.frame_set(1)

    os.makedirs(OUT_DIR, exist_ok=True)
    bpy.ops.export_scene.gltf(
        filepath=OUT_GLB,
        export_format='GLB',
        use_selection=True,
        export_animations=True,
        export_animation_mode='NLA_TRACKS',
        export_anim_single_armature=True,
        export_nla_strips=True,
        export_apply=False,
        export_yup=True,
    )
    log("wrote %s (%d bytes)" % (OUT_GLB, os.path.getsize(OUT_GLB)))
    log("done")


main()
