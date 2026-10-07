import * as THREE from 'three';
import { FurnitureSystem, registerObject, GRID } from '../furniture.js';
import { resolveAgainstRects, PLAYER_RADIUS, BOUNDS } from '../house.js';
import { buildIsland, skyTexture, WALK_RADIUS } from './island.js';
import { createHud, DROP_ICON, GO_ICON } from './hud.js';
import { createInventory } from './inventory.js';
import {
  createField, restoreField, serialiseField, plotWithinReach,
  useTool, canUse, tickField,
} from './plots.js';
import { createPlants } from './plants.js';
import { TOOLS, TOOL_DEFS, PRICES, SELL_PRICE, DURABILITY } from './items.js';
import * as farmSave from './save.js';

const SPAWN = { x: 0, z: 7.5, heading: Math.PI };

// Where the market stall stands: beside the path from the spawn to the field,
// close enough to be a stop on the way home rather than a detour.
const STALL = { x: -5, z: 5 };

// Tool id to the sound that voices it. The clip is one shared recording, so
// the four actions are four speeds of the same thunk rather than four assets.
const SOUNDS = { hoe: 'till', seeds: 'sow', can: 'water', hand: 'harvest' };

// Why a tool is refused, in a phrase short enough to hold on one line.
const REASONS = {
  'already-tilled': 'Ground already broken',
  'has-crop': 'Something grows here',
  'not-tilled': 'Break the ground first',
  'no-seeds': 'Out of seeds — buy some at the shop',
  empty: 'Sow something first',
  'not-ready': 'Not ripe yet',
  ripened: 'Ripe already',
  'full-water': 'Already wet',
  'no-tool': 'Buy this tool at the shop',
  worn: 'Worn out — buy a new one at the shop',
  'no-plot': 'Tap a plot to work it',
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
 * Interaction is tap-first: you point at a plot with your thumb and the tool
 * you have picked on the rail is used on that plot when you are close enough.
 * No auto-selection, no standing-on-it magic - the market has prices, the
 * tools wear out, and the plushie works the ground it is asked to work.
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

  // The plot the player has tapped, or null. It may be out of reach: tapping
  // from afar selects it, tapping again (or walking up and tapping) works it.
  let sel = null;
  let entered = false;

  const plants = createPlants(plots, camera);
  scene.add(plants.group);
  plants.refresh();

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

  // ---------- Turning taps into strokes ----------

  renderer.domElement.style.touchAction = 'none';
  const raycaster = new THREE.Raycaster();
  const ndc = new THREE.Vector2();
  renderer.domElement.addEventListener('pointerdown', onTap);

  function ndcFrom(event) {
    const el = renderer.domElement;
    const rect = el.getBoundingClientRect();
    ndc.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
    ndc.y = -(((event.clientY - rect.top) / rect.height) * 2 - 1);
  }

  function onTap(event) {
    if (!entered) return;
    if (event.pointerType === 'mouse' && event.button !== 0) return;
    if (!event.isPrimary) return;

    ndcFrom(event);
    raycaster.setFromCamera(ndc, camera);
    const hit = raycaster.intersectObjects(plants.hits.children, false)[0];
    const plot = hit && hit.object.userData.plot;

    if (plot) selectPlot(plot);
    else if (sel) {
      // Tapping open ground is the way to let go of a distant selection.
      sel = null;
      paint(true);
    }
  }

  /**
   * Mark the tapped plot. Within reach, act immediately - the tap *is* the
   * stroke. Further away, the glow stays put as the goal to walk to.
   */
  function selectPlot(plot) {
    sel = plot;
    plants.setTarget(sel);
    // A carried piece pins the hands: tapping plots while holding something
    // marks the plot but never works it (the button would drop the haul).
    if (furniture.carried) {
      paint(true);
      return;
    }
    if (plotWithinReach(sel, player.position.x, player.position.z)) {
      actOn(sel);
    } else {
      paint(true);
    }
  }

  function actOn(plot) {
    const verdict = canUse(plot, tool, inventory, tools);
    if (!verdict.ok) {
      hud.warn();
      paint(true);
      return;
    }
    sounds.play(SOUNDS[tool]);
    useTool(plot, tool, inventory, tools);
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
    else if (id === 'hoe' || id === 'can') buyTool(id);
    else if (id === 'sell') sellAllWheat();
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

  function renderShop() {
    const rows = [];

    rows.push(shopRow({
      id: 'seed',
      name: 'Wheat seeds',
      icon: TOOL_DEFS.seeds.icon,
      meta: 'Sows one plot of wheat',
      action: PRICES.seed + ' coins',
      disabled: inventory.coins < PRICES.seed,
    }));

    for (const id of ['hoe', 'can']) {
      const owned = typeof tools[id] === 'number';
      const working = owned && tools[id] > 0;
      rows.push(shopRow({
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

    const wheat = inventory.wheat;
    rows.push(shopRow({
      id: 'sell',
      name: 'Sell all wheat',
      icon: WHEAT_ICON,
      meta: SELL_PRICE.wheat + ' coin per bag',
      action: wheat > 0 ? 'Sell ' + wheat + ' = ' + wheat * SELL_PRICE.wheat : 'Nothing to sell',
      disabled: wheat <= 0,
    }));

    shopList.innerHTML = rows.join('');
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
      if (plotWithinReach(sel, player.position.x, player.position.z)) {
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
        hint = 'Walk to the selected plot';
      }
    } else {
      hint = 'Tap a plot to work it';
    }

    hud.paint({
      tool,
      carried,
      glyph,
      ready,
      enabled,
      hint,
      wear: wearMap(),
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
      entered = true;
      player.group.position.copy(player.position);
      scene.add(player.group);
      hud.show();
      sel = null;
      paint(true);
    },
    exit() {
      entered = false;
      hud.hide();
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
          hud.warn();
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