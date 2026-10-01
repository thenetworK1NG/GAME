/**
 * Authoritative check of models/plushie.glb using the exact three.js code
 * path the browser uses (GLTFLoader + AnimationMixer + SkinnedMesh skeleton).
 *
 * Run:  node tools/verify_glb.mjs
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';

// Node has no DOM, and GLTFLoader's image path reads `self.createImageBitmap`.
// The skeleton/animation checks below do not need real pixels, so hand it a
// minimal stand-in before importing anything that touches textures.
if (typeof globalThis.self === 'undefined') {
  globalThis.self = globalThis;
}
if (typeof globalThis.createImageBitmap === 'undefined') {
  globalThis.createImageBitmap = async () => ({
    width: 2048, height: 2048, close() {},
  });
}
if (typeof globalThis.document === 'undefined') {
  globalThis.document = {
    createElementNS: () => ({
      setAttribute() {}, getContext: () => null, style: {},
    }),
  };
}

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = dirname(HERE);
const GLB_PATH = join(ROOT, 'models', 'plushie.glb');

const failures = [];
const check = (label, ok, detail = '') => {
  console.log(`[${ok ? 'PASS' : 'FAIL'}] ${label}${detail ? ' -> ' + detail : ''}`);
  if (!ok) failures.push(label);
};

/** Minimal loader shim: node has no fetch/XHR, so resolve the GLB from disk.
 *  GLTFLoader detects GLB via `data instanceof ArrayBuffer`, and a Node
 *  Buffer is a Uint8Array, so hand it the real underlying ArrayBuffer. */
function loadFromDisk(url, onLoad, onProgress, onError) {
  const buf = readFileSync(join(ROOT, url.replace(/^\//, '')));
  const bytes = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
  new GLTFLoader().parse(
    bytes, '',
    (gltf) => onLoad(gltf),
    (err) => { if (onError) onError(err); else throw err; }
  );
}

/** Bones are only reachable through the skeleton, not as scene children. */
function boneLookup(gltf) {
  let skinned = null;
  gltf.scene.traverse((o) => { if (o.isSkinnedMesh) skinned = o; });
  const map = new Map();
  for (const bone of skinned.skeleton.bones) map.set(bone.name, bone);
  return { skinned, bone: (name) => map.get(name) ?? null };
}

/** Sample a clip and record world positions of the named bones per keyframe. */
function sampleClip(gltf, clip, boneNames) {
  const { bone } = boneLookup(gltf);
  const mixer = new THREE.AnimationMixer(gltf.scene);
  const action = mixer.clipAction(clip);
  action.setLoop(THREE.LoopRepeat, Infinity);
  action.play();

  const duration = clip.duration;
  const step = 1 / 30;
  const samples = [];

  for (let t = 0; t <= duration + 1e-6; t += step) {
    mixer.setTime(t);
    gltf.scene.updateMatrixWorld(true);
    const frame = { time: t };
    for (const name of boneNames) {
      const b = bone(name);
      frame[name] = b ? b.getWorldPosition(new THREE.Vector3()) : null;
    }
    samples.push(frame);
  }

  action.stop();
  mixer.stopAllAction();
  return samples;
}

const span = (samples, name, axis) => {
  const values = samples.map((s) => s[name]?.[axis]).filter((v) => v !== undefined);
  return Math.max(...values) - Math.min(...values);
};

async function main() {
  const gltf = await new Promise((resolve, reject) => {
    loadFromDisk('models/plushie.glb', resolve, undefined, reject);
  });

  const names = gltf.animations.map((c) => c.name);
  check('two clips', gltf.animations.length === 2, names.join(', '));

  const idle = gltf.animations.find((c) => c.name === 'Idle');
  const walk = gltf.animations.find((c) => c.name === 'Walk');
  check('clip "Idle" present', !!idle);
  check('clip "Walk" present', !!walk);
  if (!idle || !walk) throw new Error('missing clip');

  check('Idle duration ~8.3s', Math.abs(idle.duration - 8.3) < 0.1,
    idle.duration.toFixed(3) + 's');
  check('Walk duration ~0.97s', Math.abs(walk.duration - 0.967) < 0.05,
    walk.duration.toFixed(3) + 's');

  // ---- Scene sanity ----
  let skinned = null;
  gltf.scene.traverse((o) => { if (o.isSkinnedMesh) skinned = o; });
  check('has a SkinnedMesh', !!skinned);
  if (!skinned) throw new Error('no skinned mesh');

  const bones = skinned.skeleton.bones;
  check('49 bones bound', bones.length === 49, String(bones.length));

  const bone = boneLookup(gltf).bone;

  const tex = skinned.material.map;
  check('material has base-color texture', !!tex);
  if (tex) check('texture is sRGB', tex.colorSpace === THREE.SRGBColorSpace, tex.colorSpace);

  skinned.geometry.computeBoundingBox();
  const bb = skinned.geometry.boundingBox;
  const size = new THREE.Vector3();
  bb.getSize(size);
  console.log(`[info] bbox size = ${size.x.toFixed(3)} x ${size.y.toFixed(3)} x ${size.z.toFixed(3)}`);
  console.log(`[info] bbox min = ${bb.min.x.toFixed(3)}, ${bb.min.y.toFixed(3)}, ${bb.min.z.toFixed(3)}`);
  check('feet sit on y=0', Math.abs(bb.min.y) < 0.02, bb.min.y.toFixed(4));
  check('upright (Y tallest)', size.y > size.x && size.y > size.z);

  // The plushie is authored facing +Z: its right side is -X and up is +Y, so
  // in a right-handed Y-up space forward is +Z. player.js therefore applies no
  // yaw correction. Derive it from the hip axis rather than the toes, which
  // splay in the A-pose and are not a reliable facing reference.
  const hips = bone('mixamorigHips');
  const leftFoot = bone('mixamorigLeftFoot');
  const rightFoot = bone('mixamorigRightFoot');
  const head = bone('mixamorigHead');
  check('found Hips/Head/foot bones', !!hips && !!head && !!leftFoot && !!rightFoot);
  const lateral = leftFoot.getWorldPosition(new THREE.Vector3())
    .sub(rightFoot.getWorldPosition(new THREE.Vector3())).normalize();
  const up = head.getWorldPosition(new THREE.Vector3())
    .sub(hips.getWorldPosition(new THREE.Vector3())).normalize();
  // forward = lateral x up, matching right-handed Y-up.
  const forward = new THREE.Vector3().crossVectors(lateral, up).normalize();
  console.log(`[info] lateral (L->R) = ${lateral.toArray().map((v) => v.toFixed(3))}`);
  console.log(`[info] up    (Hips->Head) = ${up.toArray().map((v) => v.toFixed(3))}`);
  console.log(`[info] forward = ${forward.toArray().map((v) => v.toFixed(3))}`);
  check('model faces +Z (no yaw fix needed)', forward.z > 0.9,
    `forward.z=${forward.z.toFixed(3)}`);

  // ---- Walk: in-place, feet planted ----
  const watch = ['mixamorigHips', 'mixamorigLeftFoot', 'mixamorigRightFoot'];
  // Root motion must be projected out so the cycle plays in place under a
  // joystick. Hips is measured in world space, so only the vertical bob and
  // the small lateral sway should remain; neither X nor Z may travel.
  const walkSamples = sampleClip(gltf, walk, watch);
  const hipsX = span(walkSamples, 'mixamorigHips', 'x');
  const hipsZ = span(walkSamples, 'mixamorigHips', 'z');
  const hipsY = span(walkSamples, 'mixamorigHips', 'y');
  console.log(`[info] walk Hips span  x=${hipsX.toFixed(4)} y=${hipsY.toFixed(4)} z=${hipsZ.toFixed(4)}`);
  check('walk root does not travel forward (Z)', hipsZ < 0.02, hipsZ.toFixed(5));
  check('walk root does not travel sideways (X)', hipsX < 0.05, hipsX.toFixed(5));
  check('walk root keeps vertical bob', hipsY > 0.005, hipsY.toFixed(4));

  // Feet must alternate contact: over half a cycle the planted foot swaps.
  const half = Math.floor(walkSamples.length / 2);
  const lowAt = (i) =>
    walkSamples[i]['mixamorigLeftFoot'].y <= walkSamples[i]['mixamorigRightFoot'].y;
  check('feet swap contact within half a cycle', lowAt(0) !== lowAt(half),
    `left planted start=${lowAt(0)} half=${lowAt(half)}`);

  const lowestFoot = Math.min(
    ...walkSamples.map((s) => Math.min(s['mixamorigLeftFoot'].y, s['mixamorigRightFoot'].y))
  );
  console.log(`[info] lowest foot bone y during walk = ${lowestFoot.toFixed(3)}`);
  // The foot bone sits above the sole, so only assert it never dives far
  // below the ground plane.
  check('feet do not sink through the floor', lowestFoot > -0.35, lowestFoot.toFixed(3));

  // Loop closure: pose at t=0 and t=duration must match, or the cycle visibly
  // pops once per loop.
const loopClip = new THREE.AnimationClip('probe', walk.duration,
    walk.tracks.filter((tr) => /Hips/.test(tr.name)));
  const loopSamples = sampleClip(gltf, loopClip, ['mixamorigHips']);
  const closeErr = loopSamples[0]['mixamorigHips'].distanceTo(
    loopSamples[loopSamples.length - 1]['mixamorigHips']
  );
  check('walk loop closes (no visible pop)', closeErr < 0.02, closeErr.toFixed(5));

  // ---- Idle: standing sway ----
  const idleSamples = sampleClip(gltf, idle, watch);
  const idleHoriz = Math.max(
    span(idleSamples, 'mixamorigHips', 'x'),
    span(idleSamples, 'mixamorigHips', 'z')
  );
  check('idle root stays put', idleHoriz < 0.05, idleHoriz.toFixed(4));

  const idleGap = idleSamples.at(-1)['mixamorigHips']
    .distanceTo(walkSamples.at(-1)['mixamorigHips']);
  check('idle and walk are clearly different poses', idleGap > 0.02,
    idleGap.toFixed(4));

  console.log();
  if (failures.length) {
    console.log('FAILED: ' + failures.join(', '));
    process.exit(1);
  }
  console.log('All animation checks passed.');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

