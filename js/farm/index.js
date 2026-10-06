import * as THREE from 'three';
import { FurnitureSystem, registerObject, GRID } from '../furniture.js';
import { resolveAgainstRects, PLAYER_RADIUS, BOUNDS } from '../house.js';
import { buildIsland, skyTexture, WALK_RADIUS } from './island.js';
import { createHud, DROP_ICON, GO_ICON } from './hud.js';
import { createInventory } from './inventory.js';
import {
  createField, restoreField, serialiseField, plotInReach,
  useTool, canUse, autoTool, tickField,
} from './plots.js';
import { createPlants } from './plants.js';
import { TOOLS, TOOL_DEFS } from './items.js';
import * as farmSave from './save.js';

const SPAWN = { x: 0, z: 7.5, heading: Math.PI };

// Tool id to the sound that voices it. The clip is one shared recording, so
// the four actions are four speeds of the same thunk rather than four assets.
const SOUNDS = { hoe: 'till', seeds: 'sow', can: 'water', hand: 'harvest' };

// Why a tool is refused, in a phrase short enough to hold on one line.
const REASONS = {
  'already-tilled': 'Ground already broken',
  'has-crop': 'Something grows here',
  'not-tilled': 'Break the ground first',
  'no-seeds': 'Out of seeds',
  empty: 'Sow something first',
  'not-ready': 'Not ripe yet',
  ripened: 'Ripe already',
  'full-water': 'Already wet',
};

// Seconds between background autosaves, so a crash costs at most this much.
const AUTOSAVE = 12;

// ---------- The way home ----------

const STONE = 0x8a8378;
const STONE_DARK = 0x6f6a5c;

/**
 * A freestanding stone arch with a lit doorway standing in it. This is the
 * farm's front door: same interactable contract as the one in the house, so
 * leaving is exactly the same press as arriving was.
 */
function buildArch() {
  const group = new THREE.Group();

  const stone = new THREE.MeshStandardMaterial({
    color: STONE, roughness: 0.95, metalness: 0, flatShading: true,
  });
  const dark = new THREE.MeshStandardMaterial({
    color: STONE_DARK, roughness: 1, metalness: 0, flatShading: true,
  });

  for (const side of [-1, 1]) {
    const base = new THREE.Mesh(new THREE.BoxGeometry(0.72, 0.3, 0.9), dark);
    base.position.set(side * 1.3, 0.15, 0);
    base.castShadow = true;
    base.receiveShadow = true;
    group.add(base);

    const pillar = new THREE.Mesh(new THREE.BoxGeometry(0.45, 3.0, 0.6), stone);
    pillar.position.set(side * 1.3, 0.3 + 1.5, 0);
    pillar.castShadow = true;
    pillar.receiveShadow = true;
    group.add(pillar);
  }

  const lintel = new THREE.Mesh(new THREE.BoxGeometry(3.4, 0.5, 0.72), stone);
  lintel.position.y = 3.3 + 0.25;
  lintel.castShadow = true;
  lintel.receiveShadow = true;
  group.add(lintel);

  const cap = new THREE.Mesh(new THREE.BoxGeometry(2.4, 0.28, 0.62), dark);
  cap.position.y = 3.8 + 0.14;
  cap.castShadow = true;
  group.add(cap);

  // The doorway itself. Additive-ish and depth-write off, so it glows through
  // without punching a hole in the arch or sorting badly against the plushie.
  const glow = new THREE.Mesh(
    new THREE.PlaneGeometry(2.1, 2.9),
    new THREE.MeshBasicMaterial({
      color: 0xbfe6ff, transparent: true, opacity: 0.5,
      side: THREE.DoubleSide, depthWrite: false,
    })
  );
  glow.position.y = 1.75;
  group.add(glow);

  // Reached back through the group so the world can animate it after the
  // furniture system has taken ownership of the object.
  group.userData.glow = glow;
  return group;
}

/**
 * @param {FurnitureSystem} furniture
 * @param {{open: (id: string) => void}} portal
 */
function placeArch(furniture, portal) {
  registerObject({
    id: 'arch',
    // Cells: 3.0 x 1.0 metres at GRID 0.5.
    footprint: [3 / GRID, 1 / GRID],
    solid: true,
    carryable: false,
    prompt: 'go',
    markerY: 3.7,
    build: () => buildArch(),
    onUse: (inst, system) => {
      system.onEvent?.('door');
      portal.open('farm');
    },
  });

  return furniture.place('arch', 0, 10, 0);
}

/**
 * The floating-island world. Same contract as the house world, so the shell
 * cannot tell them apart: it just swaps `active` and keeps rendering.
 *
 * No wall fade here -- nothing stands between the camera and the plushie that
 * you would want to see through, the island is open on every side.
 */
export function createFarmWorld({
  camera, player, sounds, actionButton, rotateButton, portal,
}) {
  const scene = new THREE.Scene();
  scene.background = skyTexture();

  // ---------- Lighting ----------

  // Cooler fill than the house: outdoors the sky bounces blue into the shade,
  // and the ground bounce is grass rather than floorboards.
  const hemi = new THREE.HemisphereLight(0xeaf6ff, 0x6f8f5f, 1.0);
  scene.add(hemi);

  const sun = new THREE.DirectionalLight(0xfff2d8, 2.1);
  sun.position.set(14, 24, 10);
  sun.castShadow = true;
  sun.shadow.mapSize.set(2048, 2048);
  sun.shadow.camera.near = 1;
  sun.shadow.camera.far = 80;
  const shadowSpan = 16;
  sun.shadow.camera.left = -shadowSpan;
  sun.shadow.camera.right = shadowSpan;
  sun.shadow.camera.top = shadowSpan;
  sun.shadow.camera.bottom = -shadowSpan;
  sun.shadow.bias = -0.0006;
  sun.shadow.normalBias = 0.035;
  scene.add(sun);
  scene.add(sun.target);

  // ---------- World ----------

  const island = buildIsland();
  scene.add(island.group);

  const furniture = new FurnitureSystem({
    scene,
    walls: [],
    bounds: BOUNDS,
    headers: [],
  });
  furniture.onEvent = (cue) => sounds.play(cue);
  const arch = placeArch(furniture, portal);

  // ---------- Farm state ----------

  // One save for the whole farm. It loads as far as it can: a corrupt save
  // restarts the field but keeps the loop honest -- both halves of the economy
  // reset together, never seeds without a field or vice versa.
  const inventory = createInventory();
  let plots = null;
  let tool = 'hoe';
  const saved = farmSave.readFarm();
  if (saved) {
    inventory.restore(saved.inventory || {});
    const restored = restoreField(saved.plots, saved.elapsed);
    if (restored) plots = restored;
    if (saved.tool && TOOLS.includes(saved.tool)) tool = saved.tool;
  }
  if (!plots) plots = createField();

  // The player's own selection, remembered while standing on a far plot.
  let manualPick = false;

  const plants = createPlants(plots, camera);
  scene.add(plants.group);
  plants.refresh();

  const hud = createHud({
    onPick: (id) => {
      tool = id;
      manualPick = true;
      paint(true);
    },
  });

  function saveNow() {
    farmSave.writeFarm({
      inventory: inventory.snapshot(),
      plots: serialiseField(plots),
      tool,
    });
  }
  window.addEventListener('pagehide', saveNow);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') saveNow();
  });

  // ---------- Per-frame scratch ----------

  const scratch = { x: 0, z: 0 };
  const solidRects = [];
  let clock = 0;
  let lastKey = -1;
  let autosaveAt = 0;

  // The reach/hint state, recalculated every frame because the plushie and the
  // field both move. When the plot underfoot changes, auto-tool re-selects --
  // but only until the player picks a tool of their own, which wins until the
  // target changes again or an action succeeds.
  function paint(force, dt = 0) {
    const carried = !!furniture.carried;
    const reach = plotInReach(plots, player.position.x, player.position.z);
    plants.setTarget(reach);
    plants.update(dt);

    const key = reach ? reach.key : -1;
    if (force || key !== lastKey) {
      lastKey = key;
      if (!manualPick || force) {
        manualPick = false;
        const next = autoTool(reach, inventory);
        if (next) tool = next;
      }
    }

    // Way home wins over tools whenever the plushie is standing in it.
    let enabled = false;
    let hint = '';
    let glyph = null;
    let ready = null;

    if (carried) {
      enabled = true;
      hint = 'Drop it';
      glyph = DROP_ICON;
    } else if (furniture.target) {
      enabled = true;
      hint = 'Step through';
      glyph = GO_ICON;
    } else {
      const verdict = canUse(reach, tool, inventory);
      const next = autoTool(reach, inventory);
      if (reach) ready = next;
      if (verdict.ok) {
        enabled = true;
        hint = TOOL_DEFS[tool].hint;
      } else {
        hint = (reach && REASONS[verdict.reason]) || 'Nothing to do here';
      }
    }

    hud.paint({
      tool,
      carried,
      glyph,
      ready,
      enabled,
      hint,
      counts: inventory.snapshot(),
    });
  }

  function update(dt) {
    clock += dt;
    island.update(dt);

    // The arch's doorway breathes, so the way home stays the brightest thing on
    // the island and you can find it from any edge.
    const glow = arch.group.userData.glow;
    if (glow) glow.material.opacity = 0.42 + Math.sin(clock * 2.1) * 0.08;

    // ---------- Collision ----------
    //
    // An island edge is a circle, not a wall, so it does not go through
    // resolveAgainstRects: clamp to the circle first, then push off whatever
    // solid furniture the clamp might have shoved you into.
    scratch.x = player.position.x;
    scratch.z = player.position.z;

    const edge = WALK_RADIUS - PLAYER_RADIUS;
    const dist = Math.hypot(scratch.x, scratch.z);
    if (dist > edge && dist > 1e-6) {
      scratch.x = (scratch.x / dist) * edge;
      scratch.z = (scratch.z / dist) * edge;
    }

    let solidCount = 0;
    for (const inst of furniture.instances) {
      if (inst.solid && !inst.carried) solidRects[solidCount++] = inst.rect;
    }
    solidRects.length = solidCount;
    resolveAgainstRects(scratch, PLAYER_RADIUS, solidRects, 2);

    player.position.x = scratch.x;
    player.position.z = scratch.z;
    player.group.position.copy(player.position);

    // ---------- Growth ----------

    tickField(plots, dt);

    // ---------- Interaction ----------

    furniture.update(dt, player);
    paint(false, dt);

    // ---------- Quiet autosave ----------

    autosaveAt += dt;
    if (autosaveAt >= AUTOSAVE) {
      autosaveAt = 0;
      saveNow();
    }

    // ---------- Light ----------

    sun.position.set(player.position.x + 14, 24, player.position.z + 10);
    sun.target.position.set(player.position.x, 0, player.position.z);
    sun.target.updateMatrixWorld();
  }

  return {
    id: 'farm',
    scene,
    spawn: SPAWN,
    update,
    plants,
    furniture,
    enter() {
      player.group.position.copy(player.position);
      scene.add(player.group);
      hud.show();
      paint(true);
    },
    exit() {
      hud.hide();
      // The moment you step away is the moment "away" starts counting, so the
      // save's timestamp has to be written then, not a frame or a travel later.
      saveNow();
    },
    useAction() {
      if (furniture.carried) {
        furniture.drop();
        paint(true);
        return;
      }
      if (furniture.target) {
        furniture.target.use();
        return;
      }
      const reach = plotInReach(plots, player.position.x, player.position.z);
      if (!reach) return;

      const result = useTool(reach, tool, inventory);
      if (result.ok) {
        sounds.play(SOUNDS[tool]);
        manualPick = false;
        plants.refresh();
        paint(true);
        saveNow();
      } else {
        hud.warn();
        paint(true);
      }
    },
    rotate() {
      furniture.rotate();
    },
  };
}