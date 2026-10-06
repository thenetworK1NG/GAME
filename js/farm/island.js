import * as THREE from 'three';

/**
 * The floating island: sky, ground, and the props that give it a scale.
 *
 * Everything here is procedural geometry in the house's own palette -- the rock
 * is the plinth's grey, the sun is the window light's warm white -- so landing
 * on it feels like a continuation of the house rather than a different game.
 */

export const ISLAND_RADIUS = 13;
// Playable area, pulled in from the geometry so you stop a stride short of the
// lip instead of hanging over it.
export const WALK_RADIUS = 11.4;

const GRASS = 0x8fbf6a;
const ROCK = 0x8a8378;
const TRUNK = 0x6b4a2f;
const LEAF = 0x6fa85a;
const LEAF_LIGHT = 0x84bd6d;

/**
 * A vertical sky gradient, stretched across the screen as the scene background.
 * Canvas rather than a shader because it costs one 8x256 texture and needs no
 * lighting model, and because the horizon haze is what sells the height.
 */
export function skyTexture() {
  const canvas = document.createElement('canvas');
  canvas.width = 8;
  canvas.height = 256;
  const ctx = canvas.getContext('2d');
  const g = ctx.createLinearGradient(0, 0, 0, 256);
  g.addColorStop(0, '#5aa8e0');
  g.addColorStop(0.5, '#a9d7f2');
  g.addColorStop(1, '#eef3ea');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, 8, 256);

  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  return texture;
}

/** Deterministic scatter, so the island is the same on every visit. */
function rng(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

function makeTree() {
  const tree = new THREE.Group();

  const trunk = new THREE.Mesh(
    new THREE.CylinderGeometry(0.28, 0.42, 2.6, 7),
    new THREE.MeshStandardMaterial({ color: TRUNK, roughness: 0.95, flatShading: true })
  );
  trunk.position.y = 1.3;
  trunk.castShadow = true;
  trunk.receiveShadow = true;
  tree.add(trunk);

  // Three overlapping blobs rather than one sphere: a single ball at this size
  // reads as a lollipop, three at slightly different tones read as foliage.
  const blobs = [
    { x: 0, y: 3.4, z: 0, r: 1.5, c: LEAF },
    { x: -0.9, y: 2.9, z: 0.5, r: 1.0, c: LEAF_LIGHT },
    { x: 0.8, y: 3.0, z: -0.6, r: 1.1, c: LEAF },
  ];
  for (const b of blobs) {
    const leaf = new THREE.Mesh(
      new THREE.IcosahedronGeometry(b.r, 0),
      new THREE.MeshStandardMaterial({ color: b.c, roughness: 1, flatShading: true })
    );
    leaf.position.set(b.x, b.y, b.z);
    leaf.castShadow = true;
    tree.add(leaf);
  }
  return tree;
}

function makeCloud() {
  const cloud = new THREE.Group();
  const mat = new THREE.MeshStandardMaterial({
    color: 0xffffff, roughness: 1, metalness: 0,
  });
  const puffs = [
    { x: 0, y: 0, z: 0, r: 1.5 },
    { x: 1.5, y: -0.2, z: 0.3, r: 1.1 },
    { x: -1.4, y: -0.1, z: -0.2, r: 1.0 },
    { x: 0.5, y: 0.7, z: -0.4, r: 0.9 },
  ];
  for (const p of puffs) {
    const puff = new THREE.Mesh(new THREE.SphereGeometry(p.r, 12, 9), mat);
    puff.position.set(p.x, p.y, p.z);
    cloud.add(puff);
  }
  // Flattened, so the cluster reads as a bank rather than a bunch of balls.
  cloud.scale.set(1.6, 0.75, 1.2);
  return cloud;
}

/**
 * Builds the island and returns it with a `update(dt)` that drifts the clouds.
 * The ground plane of the grass cap is exactly y=0, matching the house floors,
 * so the plushie and every prop can be placed in the same coordinates as indoors.
 */
export function buildIsland() {
  const group = new THREE.Group();

  // ---------- Ground ----------

  const grassMat = new THREE.MeshStandardMaterial({
    color: GRASS, roughness: 1, metalness: 0, flatShading: true,
  });
  const grass = new THREE.Mesh(
    new THREE.CylinderGeometry(ISLAND_RADIUS, ISLAND_RADIUS * 0.97, 1, 26),
    grassMat
  );
  grass.position.y = -0.5;
  grass.receiveShadow = true;
  grass.castShadow = true;
  group.add(grass);

  // ---------- Rock ----------

  const rockMat = new THREE.MeshStandardMaterial({
    color: ROCK, roughness: 1, metalness: 0, flatShading: true,
  });
  const rock = new THREE.Mesh(
    new THREE.CylinderGeometry(ISLAND_RADIUS * 0.97, 1.4, 7, 26),
    rockMat
  );
  rock.position.y = -1 - 3.5;
  rock.receiveShadow = true;
  group.add(rock);

  const tip = new THREE.Mesh(new THREE.ConeGeometry(1.4, 2.4, 8), rockMat);
  tip.rotation.x = Math.PI;
  tip.position.y = -8 - 1.2;
  group.add(tip);

  // ---------- Satellite islets ----------

  for (const spec of [
    { x: -19, y: -3.5, z: 7, r: 2.4, h: 3.0, sides: 7 },
    { x: 16, y: -6.5, z: -11, r: 1.5, h: 2.2, sides: 6 },
  ]) {
    const islet = new THREE.Mesh(
      new THREE.CylinderGeometry(spec.r, spec.r * 0.2, spec.h, spec.sides),
      rockMat
    );
    islet.position.set(spec.x, spec.y, spec.z);
    islet.rotation.y = spec.sides;
    group.add(islet);

    const cap = new THREE.Mesh(
      new THREE.CylinderGeometry(spec.r * 1.02, spec.r * 0.98, 0.4, spec.sides),
      grassMat
    );
    cap.position.set(spec.x, spec.y + spec.h / 2 + 0.2, spec.z);
    group.add(cap);
  }

  // ---------- Props ----------

  const tree = makeTree();
  tree.position.set(-6.5, 0, -6.5);
  group.add(tree);

  // ---------- Clouds ----------

  const clouds = [];
  const rand = rng(20261006);
  for (let i = 0; i < 5; i++) {
    const cloud = makeCloud();
    const spec = {
      radius: 24 + rand() * 14,
      angle: rand() * Math.PI * 2,
      // Below as well as above: the island is in the sky, so seeing cloud pass
      // underneath is what tells you it is floating at all.
      y: -9 + rand() * 18,
      speed: (rand() > 0.5 ? 1 : -1) * (0.012 + rand() * 0.02),
      scale: 1.4 + rand() * 1.8,
    };
    cloud.scale.multiplyScalar(spec.scale);
    cloud.position.set(
      Math.cos(spec.angle) * spec.radius, spec.y, Math.sin(spec.angle) * spec.radius
    );
    group.add(cloud);
    clouds.push({ cloud, spec });
  }

  return {
    group,
    update(dt) {
      for (const { cloud, spec } of clouds) {
        spec.angle += spec.speed * dt;
        cloud.position.x = Math.cos(spec.angle) * spec.radius;
        cloud.position.z = Math.sin(spec.angle) * spec.radius;
      }
    },
  };
}
