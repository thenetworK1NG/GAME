import * as THREE from 'three';
import { FurnitureSystem, registerObject, GRID } from '../furniture.js';
import { resolveAgainstRects, PLAYER_RADIUS, BOUNDS } from '../house.js';
import { buildIsland, skyTexture, WALK_RADIUS } from './island.js';
import { createHud, DROP_ICON, GO_ICON } from './hud.js';
import { createInventory } from './inventory.js';
import {
  createField, restoreField, serialiseField, plotWithinReach, plotCenter,
  useTool, canUse, tickField, REACH, PAINT_REACH, PLOT_CELL,
} from './plots.js';
import { createPlants } from './plants.js';
import { TOOLS, TOOL_DEFS, PRICES, SELL_PRICE, DURABILITY } from './items.js';
import { slotKey, slotMid, buildFences, forEachSlot } from './fences.js';
import * as farmSave from './save.js';

const SPAWN = { x: 0, z: 7.5, heading: Math.PI };

// Where the market stall stands: beside the path from the spawn to the field,
// close enough to be a stop on the way home rather than a detour.
const STALL = { x: -7, z: 7 };

// Tool id to the sound that voices it. The clip is one shared recording, so
// the four actions are four speeds of the same thunk rather than four assets.
const SOUNDS = { hoe: 'till', seeds: 'sow', carrotSeed: 'sow', can: 'water', hand: 'harvest', fence: 'till' };

// Why a tool is refused, in a phrase short enough to hold on one line.
const REASONS = {
  'already-tilled': 'Ground already broken',
  'has-crop': 'Something grows here',
  'not-tilled': 'Break the ground first',
  'no-seeds': 'Out of seeds — buy some at the shop',
  empty: 'Sow something first',
  'not-ready': 'Not ripe yet',
  ripened: 'Ripe already',
  hydrated: 'Already watered',
  'no-fence': 'No fence pieces — buy some at the shop',
  'no-tool': 'Buy this tool at the shop',
  worn: 'Worn out — buy a new one at the shop',
  'no-plot': 'Tap to walk · drag a plot to work · drag open ground to pan',
};

// Seconds between background autosaves, so a crash costs at most this much.
const AUTOSAVE = 12;

// The action button's glyph while the plushie is standing on the shop's corner.
const SHOP_ICON =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" ' +
  'stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">' +
  '<path d="M6 7.5h12l1.2 12H4.8Z" />' +
  '<path d="M8.5 10V6.8a3.5 3.5 0 0 1 7 0V10" /></svg>';

// The wheat emblem, reused for the "sell" row in the shop.
const WHEAT_ICON =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" ' +
  'stroke-linecap="round" stroke-linejoin="round">' +
  '<path d="M12 21v-7" />' +
  '<path d="M12 14c0-3.3 2.7-6 6-6 0 3.3-2.7 6-6 6Z" />' +
  '<path d="M12 16c-3.3 0-6-2.4-6-5.6 3.3 0 6 2.4 6 5.6Z" /></svg>';

// ---------- The way home ----------

const STONE = 0x8a8378;
const STONE_DARK = 0x6f6a5c;
const WOOD = 0x8a6a45;
const WOOD_DARK = 0x6e4f2f;
const CLOTH = 0xc98a4b;
const CLOTH_STRIPE = 0xf2ecd8;

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

/** @param {FurnitureSystem} furniture @param {{open: (id: string) => void}} portal */
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

// ---------- The market ----------

const STALL_W = 2.2;
const STALL_D = 1.0;

/**
 * A four-pole market stall with a striped awning, a counter and crates of the
 * goods. The blue awning stripe is the "shopping" flag the HUD echoes.
 */
function buildStall() {
  const group = new THREE.Group();

  const wood = new THREE.MeshStandardMaterial({
    color: WOOD, roughness: 0.9, metalness: 0, flatShading: true,
  });
  const dark = new THREE.MeshStandardMaterial({
    color: WOOD_DARK, roughness: 1, metalness: 0, flatShading: true,
  });

  // Legs and counter at the open (south) face, where the plushie stands.
  for (const sx of [-1, 1]) {
    const leg = new THREE.Mesh(new THREE.BoxGeometry(0.09, 0.8, 0.09), dark);
    leg.position.set(sx * (STALL_W / 2 - 0.1), 0.4, 0.34);
    leg.castShadow = true;
    group.add(leg);
  }

  const counter = new THREE.Mesh(new THREE.BoxGeometry(STALL_W, 0.08, 0.42), wood);
  counter.position.y = 0.86;
  counter.position.z = 0.18;
  counter.castShadow = true;
  counter.receiveShadow = true;
  group.add(counter);

  // A crate beside the counter, borrowing the wheat clump's gold so the goods
  // are legible from the spawn end of the island.
  const crate = new THREE.Mesh(new THREE.BoxGeometry(0.34, 0.3, 0.34), dark);
  crate.position.set(-STALL_W / 2 + 0.3, 0.15, -0.24);
  crate.castShadow = true;
  crate.receiveShadow = true;
  group.add(crate);

  // Two roof poles and the awning. The top edge leans toward the camera so the
  // awning reads as a roof rather than a wall.
  for (const sx of [-1, 1]) {
    const pole = new THREE.Mesh(new THREE.BoxGeometry(0.08, 1.4, 0.08), dark);
    pole.position.set(sx * (STALL_W / 2 - 0.08), 1.75, 0);
    pole.castShadow = true;
    group.add(pole);
  }

  const awning = new THREE.Mesh(
    new THREE.BoxGeometry(STALL_W, 0.05, 0.62),
    new THREE.MeshStandardMaterial({
      color: CLOTH, roughness: 0.85, metalness: 0,
    })
  );
  awning.position.y = 2.5;
  awning.position.z = 0.14;
  awning.rotation.x = -0.1;
  awning.castShadow = true;
  group.add(awning);

  for (const sx of [-1, 1]) {
    const stripe = new THREE.Mesh(
      new THREE.BoxGeometry(0.3, 0.055, 0.64),
      new THREE.MeshStandardMaterial({
        color: CLOTH_STRIPE, roughness: 0.85, metalness: 0,
      })
    );
    stripe.position.set(sx * (STALL_W / 2 - 0.35), 2.51, 0.14);
    stripe.rotation.x = -0.1;
    group.add(stripe);
  }

  return group;
}

/**
 * @param {FurnitureSystem} furniture
 * @param {{open: () => void}} shop  the world's own openShop, not the portal
 */
function placeStall(furniture, shop) {
  registerObject({
    id: 'shop-stall',
    // Cells: one stall of 2.2 x 1.0 metres at GRID 0.5.
    footprint: [STALL_W / GRID, STALL_D / GRID],
    solid: true,
    carryable: false,
    prompt: 'shop',
    markerY: 2.6,
    build: buildStall,
    onUse: (inst, system) => {
      system.onEvent?.('coin');
      shop.open();
    },
  });

  return furniture.place('shop-stall', STALL.x, STALL.z, 0);
}

// ---------- The fences ----------

/**
 * Post-and-rail fences along every gridline of the field. One hit plane per
 * slot exists from the start, so an empty slot is as tappable as a built one;
 * the rebuild pass only decides which slots show a post. Fences are not solid -
 * Market stalls block, a dropped fence post does not, because the point of the
 * fence is that you paid for your paddock, not that it trips you up.
 */
function buildFenceWorld(fences) {
  const group = new THREE.Group();
  const fenceHits = new THREE.Group();

  const postMat = new THREE.MeshStandardMaterial({
    color: WOOD, roughness: 0.9, metalness: 0, flatShading: true,
  });
  const railMat = new THREE.MeshStandardMaterial({
    color: WOOD_DARK, roughness: 1, metalness: 0, flatShading: true,
  });
  const postGeo = new THREE.BoxGeometry(0.1, 0.55, 0.1);
  // Rails span junction to junction; which axis they run along is the slot's.
  const railZ = new THREE.BoxGeometry(0.05, 0.07, PLOT_CELL + 0.02);
  const railX = new THREE.BoxGeometry(PLOT_CELL + 0.02, 0.07, 0.05);

  const slotMat = new THREE.MeshBasicMaterial({
    transparent: true, opacity: 0, depthWrite: false, side: THREE.DoubleSide,
  });
  // ~85% of a cell, so a tap anywhere along a gap-line lands on the nearest
  // slot. The plot planes are excluded from the fence tool's picks, so the
  // overlap on either side never shadows a plot tap.
  const slotGeo = new THREE.PlaneGeometry(PLOT_CELL * 0.85, PLOT_CELL * 0.85);

  forEachSlot((slot) => {
    const mid = slotMid(slot.a, slot.l, slot.s);
    const hit = new THREE.Mesh(slotGeo, slotMat);
    hit.rotation.x = -Math.PI / 2;
    hit.position.set(mid.x, 0.05, mid.z);
    hit.userData.fence = true;
    hit.userData.slot = slot;
    fenceHits.add(hit);
  });

  function rebuild() {
    while (group.children.length) group.remove(group.children[0]);
    for (const slot of fences.values()) {
      const mid = slotMid(slot.a, slot.l, slot.s);
      const post = new THREE.Mesh(postGeo, postMat);
      post.position.set(mid.x, 0.275, mid.z);
      post.castShadow = true;
      group.add(post);
      for (const y of [0.36, 0.5]) {
        const rail = new THREE.Mesh(slot.a === 0 ? railZ : railX, railMat);
        rail.position.set(mid.x, y, mid.z);
        rail.castShadow = true;
        group.add(rail);
      }
    }
  }
  rebuild();

  return { group, hits: fenceHits, rebuild };
}

// ---------- Durability helpers ----------

function loadTools(saved) {
  const t = { hoe: DURABILITY.hoe, can: null };
  if (saved && typeof saved === 'object') {
    for (const id of ['hoe', 'can']) {
      const v = saved[id];
      if (v == null) t[id] = null;
      else {
        const n = Number(v);
        t[id] = Number.isFinite(n) && n >= 0
          ? Math.min(DURABILITY[id], Math.floor(n))
          : null;
      }
    }
  }
  return t;
}

/**
 * The floating-island world. Same contract as the house world, so the shell
 * cannot tell them apart: it just swaps `active` and keeps rendering.
 *
 * Interaction is gesture-first: tap one plot, or drag a stroke across a row
 * and the tool on the rail works every plot it crosses, as long as the plushie
 * is close enough to reach each one. No auto-selection, no standing-on-it
 * magic - the market has prices, the tools wear out, and the plushie works the
 * ground it is asked to work.
 */
export function createFarmWorld({
  camera, player, sounds, actionButton, rotateButton, portal, renderer,
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
  placeStall(furniture, {
    open: openShop,
  });

  // ---------- Farm state ----------

  // One save for the whole farm. It loads as far as it can: a corrupt save
  // restarts the field but keeps the loop honest -- both halves of the economy
  // reset together, never seeds without a field or vice versa.
  const inventory = createInventory();
  let plots = null;
  let tool = 'hoe';
  let tools = loadTools(null);
  const saved = farmSave.readFarm();
  if (saved) {
    inventory.restore(saved.inventory || {});
    const restored = restoreField(saved.plots, saved.elapsed);
    if (restored) plots = restored;
    if (saved.tool && TOOLS.includes(saved.tool)) tool = saved.tool;
    if (saved.tools) tools = loadTools(saved.tools);
  }
  if (!plots) plots = createField();

  // Buckets of decay the player placed along the gridlines. The map is pure
  // data; its world is the post-and-rail group below.
  const fences = buildFences(saved && saved.fences);
  const fenceWorld = buildFenceWorld(fences);
  scene.add(fenceWorld.group);
  scene.add(fenceWorld.hits);

  // The plot the player has tapped, or null. It may be out of reach: tapping
  // from afar selects it, tapping again (or walking up and tapping) works it.
  let sel = null;
  let entered = false;

  // The farm moves on taps alone, so the thumb stick hides for the whole stay:
  // it is only ever shown again when the arch is walked back through.
  const joystickEl = need('joystick');

  const plants = createPlants(plots, camera);
  scene.add(plants.group);
  plants.refresh();

  // An invisible floor-level plate covering the walkable island, so a tap that
  // misses every plot and fence slot still resolves to a spot to walk to. It
  // writes neither colour nor depth, so it renders nothing under the ground.
  const groundHit = new THREE.Mesh(
    new THREE.PlaneGeometry(26, 26),
    new THREE.MeshBasicMaterial({ colorWrite: false, depthWrite: false })
  );
  groundHit.rotation.x = -Math.PI / 2;
  groundHit.renderOrder = -10;
  groundHit.userData.ground = true;
  scene.add(groundHit);

  const hud = createHud({
    onPick: (id) => {
      tool = id;
      paint(true);
    },
  });

  /** The wear fraction the HUD shows, or null when the tool is not owned. */
  function wearOf(tool) {
    const left = tools[tool];
    return typeof left === 'number' ? left / DURABILITY[tool] : null;
  }

  function wearMap() {
    return { hoe: wearOf('hoe'), can: wearOf('can') };
  }

  // ---------- Turning taps and drags into strokes ----------

  renderer.domElement.style.touchAction = 'none';
  const raycaster = new THREE.Raycaster();
  const ndc = new THREE.Vector2();

  // Which surfaces a press meets depends on the tool: farm tools only ever hit
  // the plot planes, and the fence tool only ever hits the fence planes. That
  // exclusivity matters - the fence plates (a hair higher in y) sit on the
  // gridlines between plots, overlapping half a metre of every neighbouring
  // edge, so mixing both in one cast made a huge share of plot taps resolve to
  // a fence and do nothing. `withGround` also adds the invisible island floor,
  // so a tap that misses everything still points at somewhere to walk.
  function pickSurfaces(withGround = false) {
    const list = tool === 'fence' ? fenceWorld.hits.children : plants.hits.children;
    if (!withGround) return list;
    return list.length ? list.concat([groundHit]) : [groundHit];
  }

  // A stroke begins on the first pointer down and ends on the last up. A tap
  // is the stroke that never moved far enough to be a drag: it walks the
  // plushie to the tapped spot and works it. A drag paints the same tool
  // across every plot or fence slot the pointer crosses, within reach, once
  // per cast.
  let stroke = null;

  // A press that landed on nothing actionable - open ground, a gridline, past
  // the field. It stays a tap (walk to the spot) until it drags, then it hands
  // itself to the camera as a one-finger pan, so a single thumb on grass pans
  // the view instead of painting air.
  let panPress = null;

  // True for the whole of a canvas press, so the shared camera leaves the
  // gesture alone (painting needs a steady aim; a tap is a deliberate walk).
  // Only touch presses are pinned: a desktop mouse keeps its one-button orbit.
  let holding = false;
  let holdingTouch = false;

  renderer.domElement.addEventListener('pointerdown', onPress);
  renderer.domElement.addEventListener('pointermove', onMove);
  renderer.domElement.addEventListener('pointerup', onRelease);
  renderer.domElement.addEventListener('pointercancel', onRelease);

  function ndcFrom(event) {
    const el = renderer.domElement;
    const rect = el.getBoundingClientRect();
    ndc.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
    ndc.y = -(((event.clientY - rect.top) / rect.height) * 2 - 1);
  }

  // A down-up with no meaningful motion is a tap; anything else is a paint
  // sweep. The boundary is big enough that a wobbly finger still counts as a
  // tap, but small enough that an intended drag cannot stub into one.
  const DRAG_START = 0.02; // in NDC units, ~1.5% of the screen width

  function onPress(event) {
    if (!entered) return;
    if (event.pointerType === 'mouse' && event.button !== 0) return;
    // A carried piece pins the hands: canvas presses neither walk nor paint -
    // the action button drops the haul.
    if (furniture.carried) return;

    ndcFrom(event);
    event.preventDefault();
    renderer.domElement.setPointerCapture(event.pointerId);

    // A second finger joining a live press hands the gesture to the camera
    // (two-finger pan, zoom and twist); an active sweep is abandoned so a
    // pinch cannot keep painting plots while the view slides under it.
    if (!event.isPrimary) {
      cancelStroke();
      return;
    }

    const point = { x: ndc.x, y: ndc.y };
    const hit = pickAt({ x: ndc.x, y: ndc.y });

    if (!hit) {
      panPress = { pointerId: event.pointerId, start: point, moved: false };
      return;
    }

    // The stroke uses its own wear budget, cloned from what the plushie has
    // right now, so a can that dies mid-sweep stalls the sweep instead of
    // letting one lucky drag water fifty plots on a single charge. What was
    // spent is written back to the real tools only when the gesture ends.
    holding = true;
    holdingTouch = event.pointerType === 'touch' || event.pointerType === 'pen';
    stroke = {
      pointerId: event.pointerId,
      tool,
      tools: { hoe: tools.hoe, can: tools.can },
      start: point,
      touched: new Set(),
      moved: false,
      didWork: false,
      refused: false,
    };
  }

  function onMove(event) {
    if (panPress && panPress.pointerId === event.pointerId) {
      ndcFrom(event);
      const dx = ndc.x - panPress.start.x;
      const dy = ndc.y - panPress.start.y;
      // Silently cross the drag threshold: the press stops being a tap and the
      // camera (which reads `panGesture` on the very same event) takes it as a
      // pan. The walk is only ever released on a press that never moved.
      if (!panPress.moved && dx * dx + dy * dy >= DRAG_START * DRAG_START) {
        panPress.moved = true;
      }
      return;
    }
    if (!stroke || event.pointerId !== stroke.pointerId) return;
    ndcFrom(event);
    const dx = ndc.x - stroke.start.x;
    const dy = ndc.y - stroke.start.y;
    if (dx * dx + dy * dy < DRAG_START * DRAG_START) return;
    stroke.moved = true;
    sweepTo(ndc);
  }

  // Settles a stroke's wear clone and drops it without acting. Used when a
  // second finger takes the gesture over for the camera; the plots it already
  // touched stay touched, and the durability it spent is written back like a
  // normal release would.
  function cancelStroke() {
    const gesture = stroke;
    if (!gesture) return;
    stroke = null;
    holding = false;
    holdingTouch = false;
    if (renderer.domElement.hasPointerCapture(gesture.pointerId)) {
      renderer.domElement.releasePointerCapture(gesture.pointerId);
    }
    tools.hoe = gesture.tools.hoe;
    tools.can = gesture.tools.can;
  }

  function onRelease(event) {
    if (panPress && panPress.pointerId === event.pointerId) {
      const press = panPress;
      panPress = null;
      if (renderer.domElement.hasPointerCapture(event.pointerId)) {
        renderer.domElement.releasePointerCapture(event.pointerId);
      }
      // A press on open ground that never dragged is a walk: head to the spot.
      if (!press.moved) {
        tapTo({ start: press.start, tool, tools });
      }
      return;
    }
    if (!stroke || event.pointerId !== stroke.pointerId) return;
    if (renderer.domElement.hasPointerCapture(event.pointerId)) {
      renderer.domElement.releasePointerCapture(event.pointerId);
    }
    holding = false;
    holdingTouch = false;
    const gesture = stroke;
    stroke = null;
    // Both branches spend from the clone; settle the real tools once, no
    // matter which one the gesture turned out to be.
    tools.hoe = gesture.tools.hoe;
    tools.can = gesture.tools.can;
    if (gesture.moved) finishStroke(gesture);
    else tapTo(gesture);
  }

  function finishStroke(gesture) {
    if (!entered) return;
    if (gesture.didWork) {
      plants.refresh();
      saveNow();
    }
    paint(true);
  }

  /**
   * A tap never has to reach: it walks. The plushie heads for the tapped spot
   * - a plot, a fence slot, or open ground - and works what it lands on. A
   * plot already within reach is worked on the spot.
   */
  function tapTo(gesture) {
    if (!entered) return;
    const hit = pickAt(gesture.start, true);
    if (!hit) {
      clearGoal();
      sel = null;
      paint(true);
      return;
    }
    if (hit.kind === 'fence') {
      if (gesture.tool !== 'fence') {
        sel = null;
        paint(true);
        return;
      }
      const mid = slotMid(hit.slot.a, hit.slot.l, hit.slot.s);
      walkTo({ x: mid.x, z: mid.z }, () => actFence(hit.slot), REACH);
      sel = null;
      paint(true);
      return;
    }
    if (hit.kind === 'plot') {
      if (gesture.tool === 'fence') {
        // Fence mode never works a plot: walk across to wherever it points.
        walkTo(plotCenter(hit.plot));
        sel = null;
        paint(true);
        return;
      }
      const center = plotCenter(hit.plot);
      sel = hit.plot;
      plants.setTarget(sel);
      if (plotWithinReach(sel, player.position.x, player.position.z)) {
        actOn(hit.plot, gesture.tools);
      } else {
        walkTo(center, () => actOn(hit.plot, gesture.tools), REACH);
      }
      paint(true);
      return;
    }
    // Open ground: walk to the spot and let go of any selection.
    clearGoal();
    sel = null;
    plants.setTarget(null);
    walkTo({ x: hit.point.x, z: hit.point.z });
    paint(true);
  }

  function sweepTo(value) {
    const hit = pickAt(value);
    if (!hit) return;
    if (hit.kind === 'fence') touchFence(hit.slot);
    else if (stroke.tool !== 'fence') touchPlot(hit.plot);
  }

  function pickAt(p, withGround = false) {
    ndc.x = p.x;
    ndc.y = p.y;
    raycaster.setFromCamera(ndc, camera);
    const all = raycaster.intersectObjects(pickSurfaces(withGround), false);
    const closest = all[0];
    if (!closest) return null;
    if (closest.object.userData.ground) {
      return { kind: 'ground', point: closest.point };
    }
    if (closest.object.userData.fence) {
      return { kind: 'fence', slot: closest.object.userData.slot };
    }
    if (closest.object.userData.plot) {
      return { kind: 'plot', plot: closest.object.userData.plot };
    }
    return null;
  }

  function touchPlot(plot) {
    const key = 'p' + plot.key;
    if (stroke.touched.has(key)) return;
    stroke.touched.add(key);
    if (!plotWithinReach(plot, player.position.x, player.position.z, PAINT_REACH)) return;
    if (!applyTool(plot, stroke.tool, inventory, stroke.tools)) {
      if (!stroke.refused) {
        stroke.refused = true;
        hud.warn();
      }
      return;
    }
    if (!stroke.didWork) {
      stroke.didWork = true;
      sounds.play(SOUNDS[stroke.tool]);
    }
    plants.refresh();
    paint(true);
  }

  function touchFence(slot) {
    const key = 'f' + slotKey(slot.a, slot.l, slot.s);
    if (stroke.touched.has(key)) return;
    stroke.touched.add(key);
    actFenceStrength(slot, true);
  }

  /** Shared fence work; `quiet` is the stroke path, passing refusals silently. */
  function actFenceStrength(slot, quiet) {
    const mid = slotMid(slot.a, slot.l, slot.s);
    const dx = player.position.x - mid.x;
    const dz = player.position.z - mid.z;
    if (dx * dx + dz * dz > (quiet ? PAINT_REACH : REACH) ** 2) {
      if (!quiet) hud.warn();
      return;
    }
    const key = slotKey(slot.a, slot.l, slot.s);
    let changed = false;
    if (fences.has(key)) {
      // Tearing a fence down earns nothing back: the pieces are spent on the
      // land and stay with the land.
      fences.delete(key);
      changed = true;
    } else if (inventory.spend('fence', 1)) {
      fences.set(key, { a: slot.a, l: slot.l, s: slot.s });
      changed = true;
    } else if (!quiet && (!stroke || !stroke.refused)) {
      // A real tap complains loudly; a sweep complains once per gesture so a
      // long empty row does not machine-gun the same refusal.
      if (stroke) stroke.refused = true;
      hud.warn();
      return;
    }
    if (!changed) return;
    fenceWorld.rebuild();
    if (!quiet) {
      sounds.play(SOUNDS.fence);
      return;
    }
    if (!stroke.didWork) {
      stroke.didWork = true;
      sounds.play(SOUNDS.fence);
    }
  }

  /** A direct tap on a fence slot (quiet=false): preserves tap behaviour. */
  function actFence(slot) {
    actFenceStrength(slot, false);
  }

  // ---------- Walking to a tap ----------

  // Where the plushie is walking, what to do exactly once on arrival, and how
  // close counts as arrived. A tap only ever sets this; acting happens in
  // followGoal when the walk gets there.
  let goal = null;
  let goalOnArrive = null;
  let goalReach = 0.14;

  const steer = new THREE.Vector2();

  function walkTo(point, onArrive = null, reach = 0.14) {
    clearGoal();
    goal = { x: point.x, z: point.z };
    goalOnArrive = onArrive;
    goalReach = reach;
  }

  function clearGoal() {
    goal = null;
    goalOnArrive = null;
  }

  /** Per-frame once the plushie has moved: act on arrival, or stop in place. */
  function followGoal() {
    if (!goal) return;
    const g = goal;
    const dx = player.position.x - g.x;
    const dz = player.position.z - g.z;
    if (dx * dx + dz * dz > goalReach * goalReach) return;
    if (goalOnArrive) {
      const act = goalOnArrive;
      clearGoal();
      act();
    } else {
      clearGoal();
    }
  }

  /**
   * The farm moves only by tapping, so the joystick is dead weight out here.
   * This ignores it and steers purely toward the walk goal, camera-relative
   * exactly as Player.update expects; stand still whenever there's no goal.
   */
  function stick(joy, cameraYaw) {
    if (!goal || !entered) return steer.set(0, 0);
    const dx = goal.x - player.position.x;
    const dz = goal.z - player.position.z;
    const dist = Math.hypot(dx, dz);
    if (dist < 1e-3) return steer.set(0, 0);
    const cos = Math.cos(cameraYaw);
    const sin = Math.sin(cameraYaw);
    const wx = dx / dist;
    const wz = dz / dist;
    // Inverse of the Player.update decomposition: (world) = R * (stick).
    steer.set(wx * -cos + wz * sin, wx * sin + wz * cos);
    return steer;
  }

  function applyTool(plot, t, inv, bag) {
    return useTool(plot, t, inv, bag).ok;
  }

  function actOn(plot, bag = tools) {
    if (!applyTool(plot, tool, inventory, bag)) {
      hud.warn();
      paint(true);
      return;
    }
    sounds.play(SOUNDS[tool]);
    plants.refresh();
    paint(true);
    saveNow();
  }

  // ---------- Savings ----------

  function saveNow() {
    farmSave.writeFarm({
      inventory: inventory.snapshot(),
      plots: serialiseField(plots),
      tool,
      tools,
      fences: Array.from(fences.values()),
    });
  }
  window.addEventListener('pagehide', saveNow);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') saveNow();
  });

  // ---------- The shop ----------

  const shopRoot = need('shop');
  const shopClose = need('shop-close');
  const shopList = need('shop-list');
  let shopOpen = false;

  // Dismiss on pointerdown, not click: the press that opens the sheet sits
  // under the backdrop as it appears, and its release would otherwise read as
  // a dismissal of the very sheet it just opened. pointerdown fires once per
  // gesture, so the opening press can never come back as a tap-away.
  shopRoot.addEventListener('pointerdown', (event) => {
    if (event.target === shopRoot) closeShop();
  });
  shopClose.addEventListener('click', closeShop);
  shopList.addEventListener('click', (event) => {
    const btn = event.target.closest('.shop-action');
    if (!btn) return;
    const id = btn.dataset.buy;
    if (id === 'seed') buySeed();
    else if (id === 'carrotSeed') buyCarrotSeed();
    else if (id === 'hoe' || id === 'can') buyTool(id);
    else if (id === 'fence') buyFence();
    else if (id === 'sellWheat') sellAllWheat();
    else if (id === 'sellCarrot') sellAllCarrot();
  });
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && shopOpen) closeShop();
  });

  function openShop() {
    shopOpen = true;
    renderShop();
    shopRoot.classList.add('open');
  }

  function closeShop() {
    shopOpen = false;
    shopRoot.classList.remove('open');
  }

  function afterTrade() {
    sounds.play('coin');
    renderShop();
    paint(true);
    saveNow();
  }

  function buySeed() {
    if (!inventory.spend('coins', PRICES.seed)) {
      hud.warn();
      return;
    }
    inventory.give('seeds', 1);
    afterTrade();
  }

  function buyCarrotSeed() {
    if (!inventory.spend('coins', PRICES.carrotSeed)) {
      hud.warn();
      return;
    }
    inventory.give('carrotSeed', 1);
    afterTrade();
  }

  function buyFence() {
    if (!inventory.spend('coins', PRICES.fence)) {
      hud.warn();
      return;
    }
    inventory.give('fence', 1);
    afterTrade();
  }

  function buyTool(id) {
    // Already own a working one: nothing to spend on.
    if (typeof tools[id] === 'number' && tools[id] > 0) return;
    if (!inventory.spend('coins', PRICES[id])) {
      hud.warn();
      return;
    }
    tools[id] = DURABILITY[id];
    afterTrade();
  }

  function sellAllWheat() {
    const n = inventory.wheat;
    if (n <= 0) return;
    inventory.spend('wheat', n);
    inventory.give('coins', n * SELL_PRICE.wheat);
    afterTrade();
  }

  function sellAllCarrot() {
    const n = inventory.carrot;
    if (n <= 0) return;
    inventory.spend('carrot', n);
    inventory.give('coins', n * SELL_PRICE.carrot);
    afterTrade();
  }

  function shopRow({ id, name, icon, meta, action, disabled }) {
    return (
      '<div class="shop-row">' +
      '<div class="shop-icon">' + icon + '</div>' +
      '<div><div class="shop-name">' + name + '</div>' +
      '<div class="shop-meta">' + meta + '</div></div>' +
      '<button type="button" class="shop-action" data-buy="' + id + '"' +
      (disabled ? ' disabled' : '') + '>' + action + '</button>' +
      '</div>'
    );
  }

  function shopBlock(title, rows) {
    return '<div class="shop-group">' + title + '</div>' + rows.join('');
  }

  function renderShop() {
    const blocks = [];

    blocks.push(shopBlock('Seeds', [
      shopRow({
        id: 'seed',
        name: 'Wheat seeds',
        icon: TOOL_DEFS.seeds.icon,
        meta: 'Sows one plot of wheat',
        action: PRICES.seed + ' coins',
        disabled: inventory.coins < PRICES.seed,
      }),
      shopRow({
        id: 'carrotSeed',
        name: 'Carrot seeds',
        icon: TOOL_DEFS.carrotSeed.icon,
        meta: 'Sows one plot of carrots',
        action: PRICES.carrotSeed + ' coins',
        disabled: inventory.coins < PRICES.carrotSeed,
      }),
    ]));

    const gear = [];
    for (const id of ['hoe', 'can']) {
      const owned = typeof tools[id] === 'number';
      const working = owned && tools[id] > 0;
      gear.push(shopRow({
        id,
        name: TOOL_DEFS[id].label,
        icon: TOOL_DEFS[id].icon,
        meta: owned
          ? 'Wear ' + tools[id] + ' / ' + DURABILITY[id] + (tools[id] <= 0 ? ' - worn out' : '')
          : DURABILITY[id] + ' actions before it wears out',
        action: working ? 'Owned' : PRICES[id] + ' coins',
        disabled: working,
      }));
    }
    blocks.push(shopBlock('Gear', gear));

    blocks.push(shopBlock('Build', [
      shopRow({
        id: 'fence',
        name: 'Fence post',
        icon: TOOL_DEFS.fence.icon,
        meta: 'One piece; tap a gap between plots to build',
        action: PRICES.fence + ' coins',
        disabled: inventory.coins < PRICES.fence,
      }),
    ]));

    const wheat = inventory.wheat;
    const carrot = inventory.carrot;
    blocks.push(shopBlock('Sell', [
      shopRow({
        id: 'sellWheat',
        name: 'Sell all wheat',
        icon: WHEAT_ICON,
        meta: SELL_PRICE.wheat + ' coin per bag',
        action: wheat > 0 ? 'Sell ' + wheat + ' = ' + wheat * SELL_PRICE.wheat : 'Nothing to sell',
        disabled: wheat <= 0,
      }),
      shopRow({
        id: 'sellCarrot',
        name: 'Sell all carrots',
        icon: TOOL_DEFS.carrotSeed.icon,
        meta: SELL_PRICE.carrot + ' coins per bunch',
        action: carrot > 0 ? 'Sell ' + carrot + ' = ' + carrot * SELL_PRICE.carrot : 'Nothing to sell',
        disabled: carrot <= 0,
      }),
    ]));

    shopList.innerHTML = blocks.join('');
  }

  // ---------- Per-frame scratch ----------

  const scratch = { x: 0, z: 0 };
  const solidRects = [];
  let clock = 0;
  let autosaveAt = 0;

  /**
   * Recomputes the HUD. What the next press does is a strict priority: a
   * carried piece drops, a doorway opens, and only then does the selected plot
   * take a tool. The rail's breathing star says which tool *would* work on the
   * selected plot, so the loop is taught, not autocompleted.
   */
  function paint(force, dt = 0) {
    const carried = !!furniture.carried;
    plants.setTarget(sel);
    plants.update(dt);

    let enabled = false;
    let hint = '';
    let glyph = null;
    let ready = null;
    const counts = inventory.snapshot();

    if (carried) {
      enabled = true;
      hint = 'Drop it';
      glyph = DROP_ICON;
    } else if (furniture.target) {
      enabled = true;
      const isStall = furniture.target.id === 'shop-stall';
      hint = isStall ? 'Open the shop' : 'Step through';
      glyph = isStall ? SHOP_ICON : GO_ICON;
    } else if (sel) {
      if (tool === 'fence') {
        // Fence mode never keeps a selection; this only holds for the frame
        // between picking the fence and the first tap.
        hint = 'Tap a gap between plots to build';
      } else if (goal && goalOnArrive) {
        hint = 'Walking to the plot…';
      } else if (plotWithinReach(sel, player.position.x, player.position.z)) {
        const verdict = canUse(sel, tool, inventory, tools);
        if (verdict.ok) {
          enabled = true;
          hint = TOOL_DEFS[tool].hint;
        } else {
          hint = REASONS[verdict.reason] || 'Nothing to do here';
        }
        for (const t of TOOLS) {
          if (canUse(sel, t, inventory, tools).ok) { ready = t; break; }
        }
      } else {
        hint = 'Tap the plot to walk over and work it';
      }
    } else if (tool === 'fence' && (counts.fence || 0) <= 0) {
      hint = REASONS['no-fence'];
    } else {
      hint = 'Tap to walk · drag a plot to work · drag open ground to pan';
    }

    hud.paint({
      tool,
      carried,
      glyph,
      ready,
      enabled,
      hint,
      wear: wearMap(),
      counts,
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

    // ---------- Walking to a tap ----------

    followGoal();

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
    // A fixed frame over the field instead of a follow camera: the whole farm
    // stays in view while the plushie wanders, and a tap is a walk, not a
    // reach test. Drag (or pinch-twist) still orbits, pinch zooms.
    rig: {
      overhead: {
        yaw: 0,        // the arch ends up at the screen's edge
        pitch: THREE.MathUtils.degToRad(63),
        // Framed in on the field so plots read large and stay easy to tap on a
        // phone; a two-finger pan, or dragging open ground, moves the frame
        // around for anything that falls off screen.
        distance: 12.5,
        center: [0, 0],
      },
    },
    update,
    plants,
    furniture,
    stick,
    get holding() { return holdingTouch; },
    get panGesture() { return panPress !== null; },
    enter() {
      entered = true;
      player.group.position.copy(player.position);
      scene.add(player.group);
      hud.show();
      joystickEl.classList.add('hidden');
      sel = null;
      clearGoal();
      paint(true);
    },
    exit() {
      entered = false;
      hud.hide();
      joystickEl.classList.remove('hidden');
      // The moment you step away is the moment "away" starts counting, so the
      // save's timestamp has to be written then, not a frame or a travel later.
      saveNow();
    },
    useAction() {
      if (shopOpen) {
        closeShop();
        return;
      }
      if (furniture.carried) {
        furniture.drop();
        paint(true);
        return;
      }
      if (furniture.target) {
        furniture.target.use();
        return;
      }
      if (sel) {
        if (plotWithinReach(sel, player.position.x, player.position.z)) {
          actOn(sel);
        } else {
          // The button now behaves like a tap: walk over and work it.
          const target = sel;
          const center = plotCenter(target);
          walkTo(center, () => actOn(target), REACH);
          paint(true);
        }
      }
    },
    rotate() {
      furniture.rotate();
    },
  };
}

/** A required element. Throwing at boot is better than a silent null. */
function need(id) {
  return document.getElementById(id);
}