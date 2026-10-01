import * as THREE from 'three';

// ---------- Dimensions ----------
//
// The house is a square split in half at x=0, and the left half split again at
// z=0, giving three rooms. Everything downstream is derived from these numbers
// so a change here reshapes the house consistently instead of leaving orphaned
// hard-coded walls around.

export const HOUSE_SIZE = 24;
export const HALF = HOUSE_SIZE / 2;   // 12
export const WALL_T = 0.3;
export const WALL_H = 3.6;
export const DOOR_W = 2.5;

// Doorway centres. The x=0 gap joins the bedroom to the living room, and the
// z=0 gap joins the bedroom to the spare room, so the circulation loop is
// living -> bedroom -> spare and back.
const DOOR_XZ = { z: -6, x: -6 };

export const PLAYER_RADIUS = 0.55;

// ---------- Wall fading ----------
//
// A wall that sits on the line between the camera and the plushie fades out so
// it never hides the player. It stays rendered at a low opacity, so the room
// layout is still readable; nothing is ever hidden outright.
const FADE_MIN = 0.15;      // opacity while occluding
const FADE_OUT = 1 / 0.12;  // full -> faded, seconds
const FADE_IN = 1 / 0.20;   // faded -> full, seconds
const TEST_SHRINK = 0.05;   // shrink the test rect to stop edge chatter
const OCCLUDE_BEFORE = 0.95; // must cross before reaching the player
const HEADER_H = 0.5;       // doorway header depth
const HEADER_REVEAL = 0.06; // how far headers proud of the wall they sit in
const EPS = 1e-6;

export const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);

/** Room footprints, used for floors and for keeping furniture in bounds. */
export const ROOMS = {
  living:  { minX: 0,  maxX: HALF, minZ: -HALF, maxZ: 0 },
  kitchen: { minX: 0,  maxX: HALF, minZ: 0,    maxZ: HALF },
  spare:   { minX: -HALF, maxX: 0, minZ: 0,    maxZ: HALF },
  bedroom: { minX: -HALF, maxX: 0, minZ: -HALF, maxZ: 0 },
};

/** Walkable interior, inset from the outer wall faces. */
export const BOUNDS = {
  minX: -HALF + WALL_T / 2,
  maxX: HALF - WALL_T / 2,
  minZ: -HALF + WALL_T / 2,
  maxZ: HALF - WALL_T / 2,
};

/**
 * A 2D axis-aligned rectangle in the XZ plane. The single currency of this
 * module: wall meshes, collision, fade tests and furniture overlap all speak in
 * these, so they cannot drift apart.
 */
export function rect(x1, z1, x2, z2) {
  return {
    minX: Math.min(x1, x2), maxX: Math.max(x1, x2),
    minZ: Math.min(z1, z2), maxZ: Math.max(z1, z2),
  };
}

/** True when two rects overlap by more than `eps` on both axes. */
export function rectsOverlap(a, b, eps = 0) {
  return (
    a.minX < b.maxX - eps && a.maxX > b.minX + eps &&
    a.minZ < b.maxZ - eps && a.maxZ > b.minZ + eps
  );
}

/** Shortest distance from a point to a rect's edge; 0 when inside. */
export function distanceToRect(px, pz, r) {
  const dx = Math.max(r.minX - px, 0, px - r.maxX);
  const dz = Math.max(r.minZ - pz, 0, pz - r.maxZ);
  return Math.hypot(dx, dz);
}

/**
 * Cuts [from, to] by a list of gaps, returning the remaining spans. This is how
 * doorways exist: the wall generator never has to know a door is special, it
 * just gets told which stretch of wall to leave out.
 */
function cutGaps(from, to, gaps) {
  let spans = [[from, to]];
  for (const [gs, ge] of gaps) {
    const next = [];
    for (const [a, b] of spans) {
      if (ge <= a || gs >= b) { next.push([a, b]); continue; }
      if (gs > a) next.push([a, gs]);
      if (ge < b) next.push([ge, b]);
    }
    spans = next;
  }
  return spans.filter(([a, b]) => b - a > 0.01);
}

/** A checker tile, so the kitchen reads as a kitchen rather than bare colour. */
function tileTexture() {
  const S = 64;
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = S;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#d8d5cc';
  ctx.fillRect(0, 0, S, S);
  ctx.fillStyle = '#c3bfb3';
  ctx.fillRect(0, 0, S / 2, S / 2);
  ctx.fillRect(S / 2, S / 2, S / 2, S / 2);
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.wrapS = texture.wrapT = THREE.RepeatWrapping;
  return texture;
}

/** Board seams for the living room floor. */
function plankTexture() {
  const W = 64, H = 64;
  const canvas = document.createElement('canvas');
  canvas.width = W; canvas.height = H;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#a8763f';
  ctx.fillRect(0, 0, W, H);
  ctx.strokeStyle = 'rgba(70, 44, 20, 0.5)';
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(0, H / 2); ctx.lineTo(W, H / 2);
  ctx.stroke();
  ctx.strokeStyle = 'rgba(70, 44, 20, 0.22)';
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(W * 0.5, 0); ctx.lineTo(W * 0.5, H / 2);
  ctx.moveTo(0, H / 2); ctx.lineTo(0, H);
  ctx.stroke();
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.wrapS = texture.wrapT = THREE.RepeatWrapping;
  return texture;
}

/**
 * Builds the shell: floors, plinth, and every wall span.
 *
 * Each wall is a Group holding the wall slab, its baseboards, and (over a
 * doorway) the header above it. They share one material so one opacity value
 * fades the whole assembly. A wall whose slab fades but whose baseboard stays
 * solid reads as a rectangle floating over the floor, which is worse than the
 * occlusion we were trying to fix.
 */
export function buildHouse(scene) {
  const group = new THREE.Group();
  scene.add(group);

  // ---------- Floors ----------

  const tile = tileTexture();
  const plank = plankTexture();

  const floorDefs = {
    living:  { color: 0xffffff, map: plank, repX: 3, repY: 6 },
    kitchen: { color: 0xffffff, map: tile,  repX: 6, repY: 6 },
    spare:   { color: 0x6f5f52, map: null,   repX: 1, repY: 1 },
    bedroom: { color: 0x5f5a72, map: null,   repX: 1, repY: 1 },
  };

  for (const [name, r] of Object.entries(ROOMS)) {
    const def = floorDefs[name];
    const w = r.maxX - r.minX;
    const d = r.maxZ - r.minZ;
    if (def.map) def.map.repeat.set(def.repX, def.repY);
    const mat = new THREE.MeshStandardMaterial({
      color: def.color,
      map: def.map,
      roughness: name === 'kitchen' ? 0.55 : 0.95,
      metalness: 0,
    });
    const floor = new THREE.Mesh(new THREE.PlaneGeometry(w, d), mat);
    floor.rotation.x = -Math.PI / 2;
    floor.position.set((r.minX + r.maxX) / 2, 0, (r.minZ + r.maxZ) / 2);
    floor.receiveShadow = true;
    group.add(floor);
  }

  // A thin slab under everything, so the house sits on something rather than
  // hovering over the background.
  //
  // The top face must stay strictly below y=0. At y=0 it is exactly coplanar
  // with the four room floors, and two coplanar opaque surfaces z-fight into a
  // shivering mess of floor texture and bare slab. The gap below is what makes
  // the border read as a deliberate lip on the base rather than a glitch.
  const PLINTH_TOP = -0.05;
  const plinth = new THREE.Mesh(
    new THREE.BoxGeometry(HOUSE_SIZE + 0.8, 0.34, HOUSE_SIZE + 0.8),
    new THREE.MeshStandardMaterial({ color: 0x8a8378, roughness: 1 })
  );
  plinth.position.y = PLINTH_TOP - 0.17;
  plinth.receiveShadow = true;
  group.add(plinth);

  // ---------- Walls ----------

  const wallMat = new THREE.MeshStandardMaterial({
    color: 0xf0ebe2,
    roughness: 0.9,
    metalness: 0,
    transparent: true,
    opacity: 1,
  });
  const trimMat = new THREE.MeshStandardMaterial({
    color: 0xffffff,
    roughness: 0.6,
    metalness: 0,
    transparent: true,
    opacity: 1,
  });

  const walls = [];
  const headers = [];
  const colliders = [];
  // Everything that fades: structural spans plus the headers above them.
  // Kept as its own live list rather than a spread of the other two, which
  // would snapshot them while still empty.
  const fading = [];

  /**
   * @param axis  'x' if the wall runs along X (thin in Z), 'z' if along Z
   * @param cross coordinate of the wall's thin axis
   * @param gaps  [start, end] stretches to leave out; these become doorways
   *
   * Span panels are built inside a group that is rotated for 'z' walls, which
   * makes local X the run axis. Doorway headers are therefore built separately
   * in world space: pushing a non-zero local-X offset through that rotation
   * mirrors it about the span centre and flings the header off the end of the
   * wall, which is exactly where it used to end up.
   */
  function addWall(axis, cross, from, to, gaps = []) {
    const built = [];

    for (const [a, b] of cutGaps(from, to, gaps)) {
      const r = axis === 'x'
        ? rect(a, cross - WALL_T / 2, b, cross + WALL_T / 2)
        : rect(cross - WALL_T / 2, a, cross + WALL_T / 2, b);

      const wg = new THREE.Group();
      wg.position.set((r.minX + r.maxX) / 2, 0, (r.minZ + r.maxZ) / 2);
      if (axis === 'z') wg.rotation.y = Math.PI / 2;

      const length = b - a;

      const slab = new THREE.Mesh(
        new THREE.BoxGeometry(length, WALL_H, WALL_T),
        wallMat.clone()
      );
      slab.position.y = WALL_H / 2;
      slab.castShadow = true;
      slab.receiveShadow = true;
      wg.add(slab);

      // Baseboards on both faces. A hair of extra depth so they read as
      // separate from the wall rather than z-fighting with it.
      for (const side of [-1, 1]) {
        const board = new THREE.Mesh(
          new THREE.BoxGeometry(length, 0.18, 0.06),
          trimMat.clone()
        );
        board.position.set(0, 0.09, side * (WALL_T / 2 + 0.03));
        board.receiveShadow = true;
        wg.add(board);
      }

      group.add(wg);
      const wall = {
        group: wg,
        rect: r,
        axis,
        cross,
        isHeader: false,
        materials: wg.children.map((c) => c.material),
        opacity: 1,
        occluding: false,
      };
      walls.push(wall);
      fading.push(wall);
      colliders.push(r);
      built.push({ wall, a, b });
    }

    // One header per doorway. Clamped to the wall's own run, so a stray gap can
    // never produce a header hanging off the end of the building.
    for (const [rawStart, rawEnd] of gaps) {
      const gs = Math.max(rawStart, from);
      const ge = Math.min(rawEnd, to);
      if (ge - gs <= 0) continue;
      const gc = (gs + ge) / 2;

      const hg = new THREE.Group();
      hg.position.set(axis === 'x' ? gc : cross, 0, axis === 'z' ? gc : cross);

      // Deeper than the wall by a touch, so the header gets a small reveal on
      // both faces instead of reading as a painted stripe.
      const headerMesh = new THREE.Mesh(
        new THREE.BoxGeometry(
          axis === 'x' ? ge - gs : WALL_T + HEADER_REVEAL,
          HEADER_H,
          axis === 'z' ? ge - gs : WALL_T + HEADER_REVEAL
        ),
        wallMat.clone()
      );
      headerMesh.position.y = WALL_H - HEADER_H / 2;
      headerMesh.castShadow = true;
      headerMesh.receiveShadow = true;
      hg.add(headerMesh);

      group.add(hg);

      // Headers live in their own list, never in `walls`. That array drives
      // collision and wall-snapping, and a header is above head height: letting
      // it register there would silently seal every doorway shut to furniture.
      const header = {
        group: hg,
        rect: axis === 'x'
          ? rect(gs, cross - WALL_T / 2, ge, cross + WALL_T / 2)
          : rect(cross - WALL_T / 2, gs, cross + WALL_T / 2, ge),
        axis,
        cross,
        isHeader: true,
        materials: hg.children.map((c) => c.material),
        opacity: 1,
        occluding: false,
        // Dims with the wall it belongs to, so a header never hangs in mid air
        // while the plushie is standing in the doorway beneath it.
        flanks: built
          .filter((s) => s.b <= gs + EPS || s.a >= ge - EPS)
          .map((s) => s.wall),
      };
      headers.push(header);
      fading.push(header);
    }
  }

  // Exterior shell.
  addWall('x', -HALF, -HALF, HALF, []);
  addWall('x', HALF, -HALF, HALF, []);
  addWall('z', -HALF, -HALF, HALF, []);
  addWall('z', HALF, -HALF, HALF, []);

  // Interior dividers, each with one doorway.
  const dz = DOOR_XZ.z;
  addWall('z', 0, -HALF, HALF, [[dz - DOOR_W / 2, dz + DOOR_W / 2]]);
  const dx = DOOR_XZ.x;
  addWall('x', 0, -HALF, 0, [[dx - DOOR_W / 2, dx + DOOR_W / 2]]);

  return {
    group,
    rooms: ROOMS,
    bounds: BOUNDS,
    walls,
    headers,
    colliders,
    plinth,
    doors: { xz: dx, zz: dz },

    /**
     * Fades any wall standing between the camera and the plushie.
     * Runs every frame; the wall count is small so the test is cheap.
     */
    updateWalls(dt, camera, player) {
      const cx = camera.position.x;
      const cz = camera.position.z;
      const px = player.x;
      const pz = player.z;

      // Pass 1: decide what occludes the plushie. Headers borrow the verdict of
      // the wall they sit in, which needs every span resolved first.
      for (const wall of fading) {
        // Headers never occlude on their own account. Their rect is the
        // doorway gap, so testing it would flag them every single time you
        // looked through an open door. They sit above head height anyway.
        if (wall.isHeader) { wall.occluding = false; continue; }

        const r = wall.rect;
        const sr = rect(
          r.minX + TEST_SHRINK, r.minZ + TEST_SHRINK,
          r.maxX - TEST_SHRINK, r.maxZ - TEST_SHRINK
        );

        wall.occluding =
          sr.maxX > sr.minX && sr.maxZ > sr.minZ &&
          segmentHitsRect(cx, cz, px, pz, sr) < OCCLUDE_BEFORE;
      }
      for (const wall of fading) {
        if (!wall.flanks) continue;
        for (const flank of wall.flanks) {
          if (flank.occluding) { wall.occluding = true; break; }
        }
      }

      // Pass 2: ease opacity toward the target.
      for (const wall of fading) {
        const target = wall.occluding ? FADE_MIN : 1;
        const rate = wall.occluding ? FADE_OUT : FADE_IN;
        // Exponential ease toward the target, framerate independent.
        const step = rate * dt;
        wall.opacity += clamp(target - wall.opacity, -step, step);

        const op = wall.opacity;
        for (const m of wall.materials) {
          m.opacity = op;
          // A faded wall that still writes depth occludes the plushie
          // invisibly, which is the exact bug this whole mechanism exists to
          // avoid.
          m.depthWrite = op > 0.99;
        }
      }
    },
  };
}

/**
 * Slab test: does the segment a->b cross the XZ rect? Returns the entry
 * parameter in [0,1], or Infinity when it does not. Infinity rather than -1
 * makes the caller's comparison read naturally.
 */
export function segmentHitsRect(ax, az, bx, bz, r) {
  const dx = bx - ax;
  const dz = bz - az;

  // Degenerate segment (camera sitting on the player at minimum zoom). Without
  // this, a point sitting inside the rect would sail through both slab tests
  // and report a hit at t=0, fading a wall that is nowhere near the view.
  if (dx * dx + dz * dz < 1e-12) return Infinity;

  let tmin = 0;
  let tmax = 1;

  if (Math.abs(dx) < 1e-9) {
    if (ax < r.minX || ax > r.maxX) return Infinity;
  } else {
    let t1 = (r.minX - ax) / dx;
    let t2 = (r.maxX - ax) / dx;
    if (t1 > t2) { const t = t1; t1 = t2; t2 = t; }
    tmin = Math.max(tmin, t1);
    tmax = Math.min(tmax, t2);
    if (tmin > tmax) return Infinity;
  }

  if (Math.abs(dz) < 1e-9) {
    if (az < r.minZ || az > r.maxZ) return Infinity;
  } else {
    let t1 = (r.minZ - az) / dz;
    let t2 = (r.maxZ - az) / dz;
    if (t1 > t2) { const t = t1; t1 = t2; t2 = t; }
    tmin = Math.max(tmin, t1);
    tmax = Math.min(tmax, t2);
    if (tmin > tmax) return Infinity;
  }

  return tmin;
}

/**
 * Pushes a circle out of an axis-aligned rect along the shallowest axis.
 * Returns null when there is no overlap.
 *
 * All walls and all furniture footprints are axis-aligned, so a circle-vs-AABB
 * test is the whole of it -- no SAT, no orientation maths.
 */
export function resolveCircleRect(px, pz, radius, r) {
  const cx = clamp(px, r.minX, r.maxX);
  const cz = clamp(pz, r.minZ, r.maxZ);
  const dx = px - cx;
  const dz = pz - cz;
  const d2 = dx * dx + dz * dz;

  if (d2 > radius * radius) return null;

  const d = Math.sqrt(d2);
  if (d > 1e-6) {
    // Outside but overlapping: push straight out along the contact normal.
    const push = radius - d;
    return { x: px + (dx / d) * push, z: pz + (dz / d) * push };
  }

  // Centre is inside the rect. Eject on whichever face is nearest, which is
  // what stops the player getting stuck when they walk into a wall head-on.
  const left = px - r.minX;
  const right = r.maxX - px;
  const near = pz - r.minZ;
  const far = r.maxZ - pz;
  const m = Math.min(left, right, near, far);
  if (m === left) return { x: r.minX - radius, z: pz };
  if (m === right) return { x: r.maxX + radius, z: pz };
  if (m === near) return { x: px, z: r.minZ - radius };
  return { x: px, z: r.maxZ + radius };
}

/**
 * Resolves a position against a list of rects, iterating because pushing out
 * of one wall can push into its neighbour, which happens in every doorway.
 */
export function resolveAgainstRects(pos, radius, rects, passes = 3) {
  for (let i = 0; i < passes; i++) {
    let moved = false;
    for (const r of rects) {
      const hit = resolveCircleRect(pos.x, pos.z, radius, r);
      if (hit) {
        pos.x = hit.x;
        pos.z = hit.z;
        moved = true;
      }
    }
    if (!moved) break;
  }
  return pos;
}
