import * as THREE from 'three';
import { rect, rectsOverlap, distanceToRect, resolveCircleRect, clamp, PLAYER_RADIUS } from './house.js';

// ---------- Grid ----------
//
// Everything places on this lattice. Footprints are declared in grid CELLS, so
// a piece's size is readable in the registry without doing unit maths, and
// keeping every cell count even means the rotated bounding box still lands on
// grid lines rather than half-grid offsets.
export const GRID = 0.5;

// How close a wall has to be for auto-align to apply on pickup.
const WALL_SNAP_RANGE = 2.0;

// Carry presentation.
const CARRY_DISTANCE = 1.2;
// How far the arm may stretch to clear the plushie for a large or broadside
// piece. Roughly the bed's long half plus the player's own radius.
const CARRY_MAX_DISTANCE = 3.0;
const CARRY_LIFT = 0.45;
const TURN_RATE = 9;      // rad/s, so a 90-degree turn reads as a deliberate turn
const SETTLE_RATE = 5.5;

// How far the spiral search will hunt for a legal cell when the snapped one is
// blocked. Generous on purpose: nearly every drop should succeed, because being
// refused is the least fun part of placing furniture.
const NUDGE_CELLS = 8;

const GRAB_MARGIN = 1.1;
const BUBBLE_DURATION = 3.2;
const BUBBLE_FADE = 0.5;

const OUTLINE_OK = 0x6fe08a;
const OUTLINE_NUDGE = 0xf0c060;

const registry = new Map();

export const snap = (v) => Math.round(v / GRID) * GRID;

/** Shortest distance between two rects; 0 when they overlap. */
export function rectGap(a, b) {
  const dx = Math.max(b.minX - a.maxX, a.minX - b.maxX, 0);
  const dz = Math.max(b.minZ - a.maxZ, a.minZ - b.maxZ, 0);
  return Math.hypot(dx, dz);
}

/** Footprint in cells, with the axes swapped on the odd quarter turns. */
export function footprintDims(footprint, rotation) {
  const quarter = Math.round(rotation / (Math.PI / 2)) & 1;
  return quarter ? [footprint[1], footprint[0]] : [footprint[0], footprint[1]];
}

export function footprintRect(x, z, rotation, footprint) {
  const [cellsX, cellsZ] = footprintDims(footprint, rotation);
  const hw = (cellsX * GRID) / 2;
  const hd = (cellsZ * GRID) / 2;
  return rect(x - hw, z - hd, x + hw, z + hd);
}

/**
 * Which way should a piece face to put its back against the nearest wall?
 *
 * Convention: at rotation 0 the back faces -Z and the long axis runs along X.
 * Four walls, four answers, and every one of them lands the piece between the
 * wall and the room rather than inside the wall.
 *
 *   wall along X, piece on its +Z side -> wall is at -Z -> back to -Z -> 0
 *   wall along X, piece on its -Z side -> wall is at +Z -> 180
 *   wall along Z, piece on its +X side -> wall is at -X -> 90
 *   wall along Z, piece on its -X side -> wall is at +X -> 270
 */
export function alignToWall(x, z, walls, footprint) {
  const probe = footprintRect(x, z, 0, footprint);
  let best = null;
  let bestGap = Infinity;
  for (const wall of walls) {
    const gap = rectGap(probe, wall.rect);
    if (gap < bestGap) {
      bestGap = gap;
      best = wall;
    }
  }
  if (!best || bestGap > WALL_SNAP_RANGE) return null;

  const along = best.axis === 'x' ? z : x;
  const centre = best.axis === 'x'
    ? (best.rect.minZ + best.rect.maxZ) / 2
    : (best.rect.minX + best.rect.maxX) / 2;

  if (best.axis === 'x') return along > centre ? 0 : Math.PI;
  return along > centre ? Math.PI / 2 : -Math.PI / 2;
}

/**
 * `keepOut` is an optional { x, z } the footprint may not touch -- the player's
 * own body, so that dropping a sofa on your feet simply fails and nudges
 * elsewhere instead of ejecting you sideways.
 */
function isPlacementValid(x, z, rotation, footprint, walls, instances, skip, bounds, keepOut) {
  const r = footprintRect(x, z, rotation, footprint);
  if (r.minX < bounds.minX || r.maxX > bounds.maxX) return false;
  if (r.minZ < bounds.minZ || r.maxZ > bounds.maxZ) return false;
  // Non-solid pieces still reserve their footprint: a sofa should not end up
  // standing inside the sign.
  for (const wall of walls) if (rectsOverlap(r, wall.rect)) return false;
  for (const inst of instances) {
    if (inst === skip || inst.carried) continue;
    // Wall art hangs in mid air and reserves nothing on the floor, otherwise a
    // picture would put a phantom obstacle exactly where the sofa goes.
    if (inst.mounted) continue;
    if (rectsOverlap(r, inst.rect)) return false;
  }
  if (keepOut && resolveCircleRect(keepOut.x, keepOut.z, PLAYER_RADIUS, r)) return false;
  return true;
}

/** Outward spiral from the intended cell until a legal one turns up. */
function findPlacement(x, z, rotation, footprint, walls, instances, skip, bounds, keepOut) {
  const args = [footprint, walls, instances, skip, bounds, keepOut];
  if (isPlacementValid(x, z, rotation, ...args)) return { x, z, rotation };

  for (let ring = 1; ring <= NUDGE_CELLS; ring++) {
    for (let dx = -ring; dx <= ring; dx++) {
      for (let dz = -ring; dz <= ring; dz++) {
        if (Math.max(Math.abs(dx), Math.abs(dz)) !== ring) continue;
        const nx = x + dx * GRID;
        const nz = z + dz * GRID;
        if (isPlacementValid(nx, nz, rotation, ...args)) return { x: nx, z: nz, rotation };
      }
    }
  }
  return null;
}

// ---------- Wall mounting ----------

/**
 * Where a wall-hung piece wants to be, given where the plushie is standing.
 *
 * Picks the nearest wall span, works out which of its two faces the plushie is
 * on, then slides the piece along that wall to sit level with them, snapped to
 * the grid and clamped so it cannot slide off the end of the wall. The yaw
 * returned turns the piece's front (+Z) to face back out of the wall at them.
 *
 * @param halfAlong half the piece's width along the wall
 * @param depth    how far it stands proud of the plaster
 */
export function wallMountAt(walls, px, pz, halfAlong, depth) {
  let best = null;
  let bestDist = Infinity;
  for (const wall of walls) {
    const r = wall.rect;
    // Walls are thin in exactly one axis; that axis decides the facing.
    const thinX = (r.maxX - r.minX) <= (r.maxZ - r.minZ);
    const d = distanceToRect(px, pz, r);
    if (d < bestDist) { bestDist = d; best = { rect: r, thinX }; }
  }
  if (!best) return null;

  const r = best.rect;
  let x = 0;
  let z = 0;
  let yaw = 0;

  if (best.thinX) {
    const east = px >= (r.minX + r.maxX) / 2;
    x = east ? r.maxX + depth / 2 : r.minX - depth / 2;
    z = clamp(snap(pz), r.minZ + halfAlong, r.maxZ - halfAlong);
    yaw = east ? Math.PI / 2 : -Math.PI / 2;
  } else {
    const south = pz >= (r.minZ + r.maxZ) / 2;
    z = south ? r.maxZ + depth / 2 : r.minZ - depth / 2;
    x = clamp(snap(px), r.minX + halfAlong, r.maxX - halfAlong);
    yaw = south ? 0 : Math.PI;
  }

  return { x, z, yaw, wall: best, wallRect: r };
}

/** XZ footprint of a wall-hung piece, for overlap tests only. */
export function mountFootprint(mount, width, depth) {
  // Yaw is a multiple of PI/2, so the piece is axis aligned either way.
  const sin = Math.round(Math.sin(mount.yaw));
  const cos = Math.round(Math.cos(mount.yaw));
  const halfX = (Math.abs(cos) * width + Math.abs(sin) * depth) / 2;
  const halfZ = (Math.abs(sin) * width + Math.abs(cos) * depth) / 2;
  return rect(mount.x - halfX, mount.z - halfZ, mount.x + halfX, mount.z + halfZ);
}

/**
 * A hung piece is legal when it stays on its wall, clears every doorway, and
 * does not land on top of another hung piece. Floor furniture is ignored on
 * purpose: hanging a picture above the sofa is the whole point.
 */
export function isWallMountValid(mount, headers, others, width, depth) {
  const fr = mountFootprint(mount, width, depth);
  for (const header of headers) if (rectsOverlap(fr, header.rect)) return false;
  for (const other of others) {
    // Skip what is in hand: its own rect is wherever it currently hangs, which
    // would always overlap the spot it is being held against.
    if (other.mounted && !other.carried && rectsOverlap(fr, other.rect)) return false;
  }
  return true;
}

// ---------- Wall art ----------

export const ART_URL = 'art/LUB.png';
export const ART_WIDTH = 3.0;
export const ART_HEIGHT = 2.0;   // matches LUB.png's 3:2 shape
export const ART_DEPTH = 0.06;
export const ART_MOUNT_Y = 1.55;

let artTexture = null;
let artRequested = false;
// Materials waiting on the image, so a late load can dress them retroactively.
const artSurfaces = [];

function requestArtTexture() {
  // No DOM means no image pipeline (the node probe). Carry on with the plain
  // backing board rather than exploding.
  if (artRequested || typeof Image === 'undefined') return;
  artRequested = true;

  new THREE.TextureLoader().load(
    ART_URL,
    (tex) => {
      tex.colorSpace = THREE.SRGBColorSpace;
      tex.anisotropy = 4;
      artTexture = tex;
      for (const m of artSurfaces) { m.map = tex; m.needsUpdate = true; }
    },
    undefined,
    () => { artRequested = false; }
  );
}

/**
 * Framed picture. Built in local XY with its face along +Z so that wall-mount
 * yaw alone decides which way it looks.
 */
function buildArt() {
  requestArtTexture();

  const g = new THREE.Group();
  const W = ART_WIDTH;
  const H = ART_HEIGHT;
  const D = ART_DEPTH;
  const rail = 0.07;

  const frameMat = new THREE.MeshStandardMaterial({
    color: 0x3a3128, roughness: 0.6, metalness: 0.1,
  });

  const add = (w, h, x, y, z) => {
    const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, D), frameMat);
    m.position.set(x, y, z);
    m.castShadow = true;
    m.receiveShadow = true;
    g.add(m);
    return m;
  };

  // Four rails around the edge, mitred by overlap at the corners.
  add(W, rail, 0, H / 2 - rail / 2, 0);
  add(W, rail, 0, -H / 2 + rail / 2, 0);
  add(rail, H - rail * 2, -W / 2 + rail / 2, 0, 0);
  add(rail, H - rail * 2, W / 2 - rail / 2, 0, 0);

  // Backing board, then the print itself a hair proud of it. The board is
  // white on purpose: LUB.png is a cut-out, so this is what reads as the
  // picture's background.
  const board = new THREE.Mesh(
    new THREE.PlaneGeometry(W - rail * 2, H - rail * 2),
    new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.95 })
  );
  board.position.z = D / 2;
  board.receiveShadow = true;
  g.add(board);

  const printMat = new THREE.MeshStandardMaterial({
    color: artTexture ? 0xffffff : 0xd9d6d2,
    roughness: 0.9,
    metalness: 0,
    // 96% of LUB.png's pixels are fully transparent and only ~11% is real
    // artwork. Drawn opaque, that empty alpha channel painted solid black
    // and the print read as a black rectangle, so the transparent/alphaTest
    // pair is what lets the white board show through the empty areas.
    transparent: true,
    alphaTest: 0.02,
  });
  if (artTexture) printMat.map = artTexture;
  artSurfaces.push(printMat);

  const print = new THREE.Mesh(
    new THREE.PlaneGeometry(W - rail * 2, H - rail * 2),
    printMat
  );
  print.position.z = D / 2 + 0.004;
  print.receiveShadow = true;
  g.add(print);

  return g;
}

// ---------- Builders ----------

let palette = null;
function mats() {
  if (palette) return palette;
  const wood = new THREE.MeshStandardMaterial({ color: 0x8a5f38, roughness: 0.85 });
  const woodDark = new THREE.MeshStandardMaterial({ color: 0x6b4828, roughness: 0.9 });
  const fabric = new THREE.MeshStandardMaterial({ color: 0x4f6f8a, roughness: 0.95 });
  const fabricLight = new THREE.MeshStandardMaterial({ color: 0x7d9bb0, roughness: 0.95 });
  const linen = new THREE.MeshStandardMaterial({ color: 0xece6da, roughness: 0.9 });
  const blanket = new THREE.MeshStandardMaterial({ color: 0x8a5f7a, roughness: 0.95 });
  const metal = new THREE.MeshStandardMaterial({ color: 0xb9bcc2, roughness: 0.4, metalness: 0.6 });
  const board = new THREE.MeshStandardMaterial({ color: 0xc9a678, roughness: 0.9 });
  const edge = new THREE.MeshStandardMaterial({ color: 0xb08a5f, roughness: 1 });
  palette = { wood, woodDark, fabric, fabricLight, linen, blanket, metal, board, edge };
  return palette;
}

function box(w, h, d, material, x, y, z, parent) {
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), material);
  mesh.position.set(x, y, z);
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  parent.add(mesh);
  return mesh;
}

function buildSofa() {
  const g = new THREE.Group();
  const m = mats();
  // 3.0 x 2.0, back at -Z.
  box(3.0, 0.42, 2.0, m.woodDark, 0, 0.30, 0, g);
  for (let i = 0; i < 3; i++) {
    box(0.92, 0.18, 1.5, m.fabric, -0.96 + i * 0.96, 0.60, 0.15, g);
  }
  box(3.0, 0.62, 0.34, m.fabric, 0, 0.85, -0.83, g);
  for (const side of [-1, 1]) {
    box(0.34, 0.34, 2.0, m.fabric, side * 1.33, 0.73, 0, g);
  }
  return g;
}

function buildTable() {
  const g = new THREE.Group();
  const m = mats();
  // 2.0 x 1.0, back at -Z.
  box(2.0, 0.12, 1.0, m.wood, 0, 0.72, 0, g);
  for (const sx of [-0.86, 0.86]) {
    for (const sz of [-0.36, 0.36]) {
      box(0.12, 0.72, 0.12, m.woodDark, sx, 0.36, sz, g);
    }
  }
  return g;
}

function buildBed() {
  const g = new THREE.Group();
  const m = mats();
  // 4.0 x 3.0, headboard at -Z.
  box(4.0, 0.30, 3.0, m.woodDark, 0, 0.20, 0, g);
  box(3.84, 0.34, 2.84, m.linen, 0, 0.52, 0, g);
  box(4.0, 1.10, 0.28, m.wood, 0, 0.70, -1.36, g);
  box(1.10, 0.22, 0.70, m.fabricLight, 0, 0.79, -1.00, g);
  box(3.84, 0.10, 1.60, m.blanket, 0, 0.74, 0.60, g);
  return g;
}

function buildChair() {
  const g = new THREE.Group();
  const m = mats();
  // 1.0 x 1.0, back at -Z.
  box(1.0, 0.10, 1.0, m.wood, 0, 0.46, 0, g);
  box(1.0, 0.56, 0.10, m.wood, 0, 0.76, -0.45, g);
  for (const sx of [-0.40, 0.40]) {
    for (const sz of [-0.40, 0.40]) {
      box(0.09, 0.46, 0.09, m.woodDark, sx, 0.23, sz, g);
    }
  }
  return g;
}

function buildSign() {
  const g = new THREE.Group();
  const m = mats();
  for (const side of [-0.62, 0.62]) {
    box(0.16, 1.9, 0.16, m.woodDark, side, 0.95, 0, g);
  }
  // Blank board. Dialogue lives in the floating bubble so it reads from every
  // camera angle instead of depending on which way the board faces.
  const face = new THREE.Mesh(
    new THREE.BoxGeometry(1.9, 0.95, 0.12),
    [m.edge, m.edge, m.edge, m.edge, m.board, m.edge]
  );
  face.position.y = 1.75;
  face.castShadow = true;
  face.receiveShadow = true;
  g.add(face);
  return g;
}

/**
 * Registers a piece. Footprint is in grid cells; keeping the counts even means
 * the rotated bounds still sit on grid lines.
 */
export function registerObject(def) {
  registry.set(def.id, {
    footprint: [2, 2],
    solid: true,
    carryable: true,
    quip: 'nice',
    markerY: 2.4,
    build: () => new THREE.Group(),
    ...def,
  });
  return def.id;
}

export function getDefinition(id) {
  return registry.get(id);
}

// ---------- Feedback bits ----------

/**
 * Rounded speech bubble on a Sprite, so it faces the camera from any angle.
 * `setText` redraws the same canvas rather than allocating a new texture, so
 * repeated interactions do not leak GPU memory.
 */
function makeSpeechBubble() {
  const W = 512, H = 256;
  const canvas = document.createElement('canvas');
  canvas.width = W;
  canvas.height = H;
  const ctx = canvas.getContext('2d');

  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;

  const material = new THREE.SpriteMaterial({
    map: texture,
    transparent: true,
    depthTest: false,
    depthWrite: false,
  });
  const sprite = new THREE.Sprite(material);
  sprite.scale.set(1.6, 0.8, 1);
  sprite.visible = false;
  sprite.renderOrder = 10;

  function fitText(text, maxSize, minSize) {
    if (!text || !text.trim()) return null;
    const pad = 34;
    const maxWidth = W - pad * 2;
    const maxHeight = H - 46;

    for (let size = maxSize; size >= minSize; size -= 2) {
      ctx.font = `bold ${size}px system-ui, -apple-system, "Segoe UI", sans-serif`;
      const lineHeight = size * 1.2;

      const words = text.split(' ');
      const lines = [];
      let current = '';
      for (const word of words) {
        const candidate = current ? `${current} ${word}` : word;
        if (ctx.measureText(candidate).width > maxWidth && current) {
          lines.push(current);
          current = word;
        } else {
          current = candidate;
        }
      }
      if (current) lines.push(current);

      const width = Math.max(...lines.map((l) => ctx.measureText(l).width));
      const height = lines.length * lineHeight;
      if (width + pad * 2 <= W - 8 && height + pad * 1.2 <= maxHeight) {
        return { lines, size, lineHeight, pad };
      }
    }
    return null;
  }

  function draw(text) {
    ctx.clearRect(0, 0, W, H);
    const fitted = fitText(text, 58, 22);
    if (!fitted) return;

    const { lines, lineHeight, pad } = fitted;
    const textHeight = lines.length * lineHeight;
    const boxW = Math.min(
      W - 8,
      Math.max(...lines.map((l) => ctx.measureText(l).width)) + pad * 2
    );
    const boxH = textHeight + pad * 1.2;
    const boxX = (W - boxW) / 2;
    const boxY = 8;
    // The corner radius must stay under half the height or arcTo inverts.
    const r = Math.min(34, boxH / 2 - 4);

    ctx.beginPath();
    const tailX = boxX + boxW * 0.34;
    const tailY = boxY + boxH;
    const tailDepth = Math.min(30, H - tailY - 6);
    ctx.moveTo(tailX - 22, tailY - 6);
    ctx.lineTo(tailX - 4, tailY + tailDepth);
    ctx.lineTo(tailX + 26, tailY - 6);
    ctx.closePath();
    ctx.fillStyle = 'rgba(255, 252, 240, 0.97)';
    ctx.fill();
    ctx.strokeStyle = 'rgba(58, 42, 24, 0.9)';
    ctx.lineWidth = 6;
    ctx.stroke();

    ctx.beginPath();
    ctx.moveTo(boxX + r, boxY);
    ctx.arcTo(boxX + boxW, boxY, boxX + boxW, boxY + boxH, r);
    ctx.arcTo(boxX + boxW, boxY + boxH, boxX, boxY + boxH, r);
    ctx.arcTo(boxX, boxY + boxH, boxX, boxY, r);
    ctx.arcTo(boxX, boxY, boxX + boxW, boxY, r);
    ctx.closePath();
    ctx.fillStyle = 'rgba(255, 252, 240, 0.97)';
    ctx.fill();
    ctx.stroke();

    ctx.fillStyle = '#3a2a18';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    const startY = boxY + boxH / 2 - ((lines.length - 1) * lineHeight) / 2;
    lines.forEach((line, i) => ctx.fillText(line, W / 2, startY + i * lineHeight));

    texture.needsUpdate = true;
  }

  return {
    sprite,
    texture,
    setText: draw,
    dispose() {
      texture.dispose();
      material.dispose();
    },
  };
}

/** Floating marker: up to lift, down to interact. */
function makePromptIcon(direction) {
  const S = 128;
  const canvas = document.createElement('canvas');
  canvas.width = S;
  canvas.height = S;
  const ctx = canvas.getContext('2d');

  const cx = S / 2, cy = S / 2, r = S * 0.36;
  ctx.beginPath();
  ctx.arc(cx, cy, r, 0, Math.PI * 2);
  ctx.fillStyle = 'rgba(255, 252, 240, 0.95)';
  ctx.fill();
  ctx.lineWidth = 7;
  ctx.strokeStyle = 'rgba(58, 42, 24, 0.85)';
  ctx.stroke();

  ctx.beginPath();
  if (direction === 'up') {
    ctx.moveTo(cx - 22, cy + 12);
    ctx.lineTo(cx, cy - 12);
    ctx.lineTo(cx + 22, cy + 12);
  } else {
    ctx.moveTo(cx - 22, cy - 12);
    ctx.lineTo(cx, cy + 12);
    ctx.lineTo(cx + 22, cy - 12);
  }
  ctx.strokeStyle = '#3a2a18';
  ctx.lineWidth = 11;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  ctx.stroke();

  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  const sprite = new THREE.Sprite(
    new THREE.SpriteMaterial({
      map: texture,
      transparent: true,
      depthTest: false,
      depthWrite: false,
    })
  );
  sprite.scale.setScalar(0.55);
  sprite.visible = false;
  sprite.renderOrder = 11;

  return {
    sprite,
    dispose() {
      texture.dispose();
      sprite.material.dispose();
    },
  };
}

/**
 * Floor outline showing exactly where the carried piece will land. A 3D object
 * in the world rather than a screen overlay, so it costs no UI space and reads
 * in the same visual language as the room.
 */
function makeLandingOutline() {
  const group = new THREE.Group();

  const fillMat = new THREE.MeshBasicMaterial({
    color: OUTLINE_OK, transparent: true, opacity: 0.14,
    depthWrite: false, side: THREE.DoubleSide,
  });
  const edgeMat = new THREE.MeshBasicMaterial({
    color: OUTLINE_OK, transparent: true, opacity: 0.95, depthWrite: false,
    side: THREE.DoubleSide,
  });

  // Every child is a plane in the group's local XY with its face along +Z. The
  // group alone decides orientation: flat on the floor for furniture, upright
  // against a wall for wall art. Rotating the children instead would mean two
  // separate layouts to keep in step.
  const fill = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), fillMat);
  fill.renderOrder = 5;
  group.add(fill);

  // Four bars rather than a line loop: 1px lines vanish on a phone panel.
  const bars = [];
  for (let i = 0; i < 4; i++) {
    const bar = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), edgeMat);
    bar.renderOrder = 5;
    group.add(bar);
    bars.push(bar);
  }

  group.visible = false;

  const T = 0.09;

  return {
    group,
    // Last verdict passed in. Exposed so the current state of the landing
    // preview can be read off window.game instead of guessed at.
    valid: true,
    mode: 'floor',

    /** Sizes the fill and rim to a w x h panel centred on the group. */
    layout(w, h, ok) {
      fill.scale.set(w, h, 1);
      bars[0].scale.set(w, T, 1);
      bars[1].scale.set(w, T, 1);
      bars[2].scale.set(T, h, 1);
      bars[3].scale.set(T, h, 1);
      bars[0].position.set(0, h / 2 - T / 2, 0);
      bars[1].position.set(0, -h / 2 + T / 2, 0);
      bars[2].position.set(w / 2 - T / 2, 0, 0);
      bars[3].position.set(-w / 2 + T / 2, 0, 0);

      const colour = ok ? OUTLINE_OK : OUTLINE_NUDGE;
      edgeMat.color.setHex(colour);
      fillMat.color.setHex(colour);
    },

    /** Floor footprint preview. */
    setRect(r, ok) {
      this.valid = !!ok;
      this.mode = 'floor';
      group.rotation.set(-Math.PI / 2, 0, 0);
      group.position.set((r.minX + r.maxX) / 2, 0.03, (r.minZ + r.maxZ) / 2);
      this.layout(r.maxX - r.minX, r.maxZ - r.minZ, ok);
    },

    /**
     * Upright preview for something hung on a wall. `lift` pushes it a hair off
     * the wall face so it does not z-fight with the plaster.
     */
    setWallPanel(x, y, z, yaw, w, h, ok, lift = 0.02) {
      this.valid = !!ok;
      this.mode = 'wall';
      group.rotation.set(0, yaw, 0);
      // Straight along the panel's own normal, which is +Z before the yaw.
      group.position.set(
        x + Math.sin(yaw) * lift,
        y,
        z + Math.cos(yaw) * lift
      );
      this.layout(w, h, ok);
    },

    dispose() {
      fill.geometry.dispose();
      for (const b of bars) b.geometry.dispose();
      fillMat.dispose();
      edgeMat.dispose();
    },
  };
}

// ---------- Pieces ----------

function createInstance(def, x, z, rotation, system) {
  const group = def.build();
  const mounted = !!def.mounted;
  group.position.set(x, mounted ? def.mountY : 0, z);
  group.rotation.y = rotation;

  const bubble = makeSpeechBubble();
  const prompt = makePromptIcon(def.carryable ? 'up' : 'down');
  group.add(bubble.sprite, prompt.sprite);

  const inst = {
    id: def.id,
    def,
    group,
    x,
    z,
    rotation,
    radius: GRAB_MARGIN,
    rect: footprintRect(x, z, rotation, def.footprint),
    solid: def.solid,
    carryable: def.carryable,
    carried: false,
    mounted,
    settle: 1,

    _bubble: bubble,
    _prompt: prompt,
    _timer: 0,
    _pop: 0,
    _wasInRange: false,

    /** Distance from a world point, measured to the footprint edge so a long
     *  sofa can be grabbed from anywhere along its length. */
    distanceFrom(px, pz) {
      return distanceToRect(px, pz, this.rect);
    },

    speak(text) {
      bubble.setText(text);
      this._timer = BUBBLE_DURATION;
    },

    use() {
      if (this.carryable) system.pickUp(this);
      else this.speak(def.quip);
    },

    update(dt, inRange) {
      prompt.sprite.visible = inRange;
      if (inRange) {
        if (!this._wasInRange) this._pop = 0;
        this._pop = Math.min(1, this._pop + dt * 5);
        const eased = 1 - Math.pow(1 - this._pop, 3);
        const bob = Math.sin(performance.now() * 0.0035) * 0.06;
        prompt.sprite.position.y = def.markerY + bob;
        prompt.sprite.scale.setScalar(0.55 * (0.6 + 0.4 * eased));
      }
      this._wasInRange = inRange;

      if (this._timer > 0) {
        this._timer -= dt;
        const fade = Math.min(1, this._timer / BUBBLE_FADE);
        const rise = Math.min(1, (BUBBLE_DURATION - this._timer) / 0.22);
        bubble.sprite.visible = fade > 0.01;
        bubble.sprite.material.opacity = fade;
        bubble.sprite.position.y = def.markerY + 0.85 + (1 - rise) * -0.25;
      } else {
        bubble.sprite.visible = false;
      }

      // Ease the visual turn toward the logical angle so a rotate reads as a
      // deliberate movement rather than a jump cut.
      const diff = this.rotation - group.rotation.y;
      group.rotation.y += diff * (1 - Math.exp(-TURN_RATE * dt));

      if (this.settle < 1) {
        this.settle = Math.min(1, this.settle + dt * SETTLE_RATE);
        const squash = 1 - this.settle;
        group.scale.set(1 + 0.08 * squash, 1 - 0.18 * squash, 1 + 0.08 * squash);
      } else if (group.scale.y !== 1) {
        group.scale.set(1, 1, 1);
      }
    },

    setPlacement(nx, nz, nrot) {
      this.x = nx;
      this.z = nz;
      this.rotation = nrot;
      this.rect = footprintRect(nx, nz, nrot, def.footprint);
      this.group.position.set(nx, this.mounted ? def.mountY : 0, nz);
    },

    dispose() {
      bubble.dispose();
      prompt.dispose();
      group.traverse((child) => {
        if (child.geometry) child.geometry.dispose();
        if (child.material) {
          const list = Array.isArray(child.material) ? child.material : [child.material];
          for (const m of list) {
            if (m.map) m.map.dispose();
            m.dispose();
          }
        }
      });
    },
  };

  prompt.sprite.position.set(0, def.markerY, 0);
  bubble.sprite.position.set(0, def.markerY + 0.85, 0);

  return inst;
}

// ---------- System ----------

export class FurnitureSystem {
  constructor({ scene, walls, bounds, headers = [] }) {
    this.scene = scene;
    this.walls = walls;
    this.bounds = bounds;
    // Doorway extents, so hung pieces never end up floating over an opening.
    this.headers = headers;
    this.instances = [];
    this.interactables = [];
    this.carried = null;
    this.target = null;
    this.refusing = 0;
    // Player centre, refreshed every frame; see update().
    this.keepOut = { x: 0, z: 0 };

    this.outline = makeLandingOutline();
    scene.add(this.outline.group);
  }

  place(id, x, z, rotation = 0) {
    const def = getDefinition(id);
    if (!def) throw new Error(`FurnitureSystem: unknown object "${id}"`);
    const inst = createInstance(def, x, z, rotation, this);
    this.scene.add(inst.group);
    this.instances.push(inst);
    this.interactables.push(inst);
    return inst;
  }

  /**
   * Hangs a piece straight onto the nearest wall to a probe point. Used for the
   * starting placement of wall art, so it goes through exactly the same maths
   * the carry path does.
   */
  placeMounted(id, px, pz) {
    const def = getDefinition(id);
    if (!def || !def.mounted) {
      throw new Error(`placeMounted: "${id}" is not a wall-mounted object`);
    }
    const mount = wallMountAt(this.walls, px, pz, def.artWidth / 2, def.artDepth);
    if (!mount) throw new Error('placeMounted: no wall found');

    const inst = createInstance(def, mount.x, mount.z, mount.yaw, this);
    inst.group.position.set(mount.x, def.mountY, mount.z);
    inst.rect = mountFootprint(mount, def.artWidth, def.artDepth);
    this.scene.add(inst.group);
    this.instances.push(inst);
    this.interactables.push(inst);
    return inst;
  }

  pickUp(inst) {
    if (this.carried) return;
    this.carried = inst;
    inst.carried = true;
    inst.settle = 1;
    inst.speak(inst.def.quip);

    // Auto-align once, here. After this the rotate button owns the angle, so a
    // deliberate turn is never second-guessed by the wall again. Wall art skips
    // it: it is already flat against plaster, and its facing follows whichever
    // wall the plushie walks up to.
    if (!inst.mounted) {
      const aligned = alignToWall(inst.x, inst.z, this.walls, inst.def.footprint);
      if (aligned !== null) inst.rotation = aligned;
      inst.rect = footprintRect(inst.x, inst.z, inst.rotation, inst.def.footprint);
    }

    this.interactables.splice(this.interactables.indexOf(inst), 1);
    this.outline.group.visible = true;
    if (this.onEvent) this.onEvent('pickup', inst);
  }

  rotate() {
    if (!this.carried) return;
    this.carried.rotation += Math.PI / 2;
    this.carried.rect = footprintRect(
      this.carried.x, this.carried.z, this.carried.rotation, this.carried.def.footprint
    );
  }

  /** Places the carried piece, nudging it to the nearest legal cell if needed. */
  drop() {
    const inst = this.carried;
    if (!inst) return false;

    if (inst.mounted) return this.dropMounted(inst);

    const found = findPlacement(
      snap(inst.group.position.x),
      snap(inst.group.position.z),
      inst.rotation,
      inst.def.footprint,
      this.walls,
      this.instances,
      inst,
      this.bounds,
      this.keepOut
    );

    if (!found) {
      // Nowhere legal nearby. Stay carried and flash rather than dropping a
      // piece inside a wall.
      this.refusing = 0.45;
      return false;
    }

    inst.setPlacement(found.x, found.z, found.rotation);
    inst.group.position.set(found.x, 0, found.z);
    inst.carried = false;
    inst.settle = 0;
    inst._prompt.sprite.visible = false;

    this.carried = null;
    this.outline.group.visible = false;
    this.interactables.push(inst);
    if (this.onEvent) this.onEvent('place', inst);
    return true;
  }

  /**
   * @param player the Player instance: needs `position` for XZ and `heading`
   * for where the carried piece floats. Passing player.position instead would
   * silently make every carry position NaN.
   */
  /**
   * Hangs a carried picture. It has already been tracking the wall through
   * update(), so this just commits the current spot, or slides it along the
   * wall to the nearest free spot if something is in the way.
   */
  dropMounted(inst) {
    const d = inst.def;
    const mount = wallMountAt(
      this.walls, inst.group.position.x, inst.group.position.z,
      d.artWidth / 2, d.artDepth
    );

    if (!mount || !isWallMountValid(mount, this.headers, this.instances, d.artWidth, d.artDepth)) {
      this.refusing = 0.45;
      return false;
    }

    inst.x = mount.x;
    inst.z = mount.z;
    inst.rotation = mount.yaw;
    inst.rect = mountFootprint(mount, d.artWidth, d.artDepth);
    inst.group.position.set(mount.x, d.mountY, mount.z);
    inst.carried = false;
    inst.settle = 0;
    inst._prompt.sprite.visible = false;

    this.carried = null;
    this.outline.group.visible = false;
    this.interactables.push(inst);
    if (this.onEvent) this.onEvent('place', inst);
    return true;
  }

  update(dt, player) {
    const px = player.position.x;
    const pz = player.position.z;

    // Remembered so drop(), which runs from a button handler outside this
    // loop, can still keep furniture off the player's body.
    this.keepOut.x = px;
    this.keepOut.z = pz;

    const carried = this.carried;
    if (carried && carried.mounted) {
      const d = carried.def;
      // Track the wall the plushie is nearest, sliding along it to stay level
      // with them. That is what makes the picture feel like it is being held
      // up against the plaster rather than dragged through the room.
      const mount = wallMountAt(this.walls, px, pz, d.artWidth / 2, d.artDepth);
      if (mount) {
        carried.x = mount.x;
        carried.z = mount.z;
        carried.rotation = mount.yaw;
        carried.group.position.set(mount.x, d.mountY, mount.z);
        carried.group.rotation.y = mount.yaw;
        carried.rect = mountFootprint(mount, d.artWidth, d.artDepth);

        const okSpot = isWallMountValid(
          mount, this.headers, this.instances, d.artWidth, d.artDepth
        );
        this.outline.group.visible = true;
        this.outline.setWallPanel(
          mount.x, d.mountY, mount.z, mount.yaw, d.artWidth, d.artHeight,
          okSpot, d.artDepth / 2 + 0.02
        );
      }
      carried.update(dt, false);
    } else if (carried) {
      // Push the piece further out until its footprint stops swallowing the
      // plushie. At a fixed offset a big piece like the bed is centred right on
      // top of the player: they clip through it and, because the drop test
      // refuses to bury the player, the outline stays amber the entire time.
      // Searching outward handles every size and rotation uniformly, including
      // a wide piece held broadside-on.
      let tx = px;
      let tz = pz;
      let clear = false;
      for (let d = CARRY_DISTANCE; d <= CARRY_MAX_DISTANCE; d += GRID) {
        const cx = snap(px + Math.sin(player.heading) * d);
        const cz = snap(pz + Math.cos(player.heading) * d);
        if (!resolveCircleRect(
              px, pz, PLAYER_RADIUS,
              footprintRect(cx, cz, carried.rotation, carried.def.footprint)
            )) {
          tx = cx;
          tz = cz;
          clear = true;
          break;
        }
      }
      if (!clear) {
        // Bigger than the carry arm can clear at this angle. Fall back to the
        // far end so it at least stops overlapping the player outright.
        tx = snap(px + Math.sin(player.heading) * CARRY_MAX_DISTANCE);
        tz = snap(pz + Math.cos(player.heading) * CARRY_MAX_DISTANCE);
      }

      carried.group.position.set(
        tx,
        CARRY_LIFT + Math.sin(performance.now() * 0.006) * 0.05,
        tz
      );

      // Walls, bounds and other furniture only. The player is deliberately not
      // part of this test while carrying: the piece is already held clear of
      // them above, and judging the spot by the plushie's body would paint the
      // outline amber no matter where you stand. The player is still respected
      // at the moment of the drop.
      const exact = isPlacementValid(
        tx, tz, carried.rotation, carried.def.footprint,
        this.walls, this.instances, carried, this.bounds
      );
      // Just clear of the floor plane. Coplanar with it, this flickers badly at
      // grazing camera angles; much higher and it visibly floats.
      this.outline.group.position.set(tx, 0.03, tz);
      this.outline.setRect(footprintRect(tx, tz, carried.rotation, carried.def.footprint), exact);

      // Still animate the carried piece: its quip has to be able to time out,
      // and the rotation ease has to keep running. `false` keeps its prompt
      // hidden, since it is already in hand.
      carried.update(dt, false);
    }

    // A refused drop flashes the outline amber rather than snapping the piece
    // back, so the refusal reads as "not here" instead of "something broke".
    if (this.refusing > 0) {
      this.refusing -= dt;
      if (this.refusing <= 0) {
this.refusing = 0;
    // Optional callback, set by the game shell: onEvent('pickup'|'place', inst).
    // Lets sound react to successful interactions without this module needing to
    // know anything about audio. Left null here so the tests can run without it.
    this.onEvent = null;
        this.outline.group.visible = true;
} else if (carried) {
        // Leave the panel where it is; just repaint it amber and blink. Redoing
        // the geometry here would put a hung picture's outline on the floor.
        if (this.outline.mode === 'wall') {
          this.outline.layout(
            carried.def.artWidth, carried.def.artHeight, false
          );
        } else {
          this.outline.setRect(
            footprintRect(
              carried.group.position.x, carried.group.position.z,
              carried.rotation, carried.def.footprint
            ),
            false
          );
        }
        this.outline.group.visible = Math.sin(this.refusing * 40) > 0;
      }
    }

    let nearest = null;
    let best = Infinity;
    for (const item of this.interactables) {
      const d = item.distanceFrom(px, pz);
      const inRange = d <= item.radius;
      item.update(dt, inRange);
      if (inRange && d < best) {
        best = d;
        nearest = item;
      }
    }

    this.target = nearest;
    return nearest;
  }
}

// ---------- Contents ----------

export function registerDefaults() {
  // Framed print. Hung rather than stood, so it has no floor footprint worth
  // speaking of and never blocks furniture underneath it.
  registerObject({
    id: 'art',
    footprint: [6, 4],
    quip: 'a picture of lub',
    build: buildArt,
    mounted: true,
    solid: false,
    mountY: ART_MOUNT_Y,
    artWidth: ART_WIDTH,
    artHeight: ART_HEIGHT,
    artDepth: ART_DEPTH,
    markerY: ART_MOUNT_Y + ART_HEIGHT / 2 + 0.35,
  });

  registerObject({
    id: 'sofa',
    footprint: [6, 4],
    quip: 'cosy sofa',
    build: buildSofa,
  });
  registerObject({
    id: 'table',
    footprint: [4, 2],
    quip: 'dining table',
    build: buildTable,
  });
  registerObject({
    id: 'bed',
    footprint: [8, 6],
    quip: 'tired... zzZ',
    build: buildBed,
  });
  registerObject({
    id: 'chair',
    footprint: [2, 2],
    quip: 'sit down',
    build: buildChair,
  });
  registerObject({
    id: 'sign',
    footprint: [4, 2],
    solid: false,
    carryable: false,
    markerY: 2.9,
    quip: 'hallo player',
    build: buildSign,
  });
}