import * as THREE from 'three';

import { STAGE_COUNT, stageOf, isReady, CROPS } from './items.js';
import { PLOT_COUNT, PLOT_CELL, PLOT_INSET, plotCenter } from './plots.js';

/**
 * What the field looks like: a plot of dirt, farmland furrows when it is
 * hoed, the crop, the highlight on the plot you have tapped, and the little
 * bar that says how far along it is.
 *
 * Geometry and materials are meant to be shared between plots - sixty-four
 * copies of the same stalk is sixty-four times the memory for no visual gain.
 * The two crops share the same stalk geometry and only swap materials, so a
 * carrot costs no new meshes. Only the per-plot material colours differ,
 * because a half-ripe row next to a ripe one is the clearest possible progress
 * indicator.
 */

const DIRT = 0x7c5336;     // plain soil, the field's default brown
const FARMLAND = 0x5a3a22; // hoed furrows, dry
const WET = 0x46301f;      // hoed furrows, hydrated
const SPROUT = 0x9ac46a;
const RIPE = 0xd9ac45;
const CARROT_LEAF = 0x8fbf5a;
const CARROT = 0xe8843a;

const PLANT_H = 0.95;
const BAR_Y = 1.3;
const BAR_W = 0.86;
const BAR_H = 0.075;

// Height as a fraction of full growth, per stage. Planted is barely a nub so
// the seed reads as "in the ground" rather than "already growing".
const STAGE_H = [0.1, 0.32, 0.68, 1.0];

const stalkGeo = new THREE.BoxGeometry(0.045, PLANT_H, 0.045);
// Shifted so the base sits on the soil: scaling the group then grows the stalk
// upward instead of stretching it through the ground.
stalkGeo.translate(0, PLANT_H / 2, 0);

const headGeo = new THREE.BoxGeometry(0.085, 0.17, 0.085);
headGeo.translate(0, PLANT_H + 0.06, 0);

const soilGeo = new THREE.BoxGeometry(PLOT_CELL - PLOT_INSET, 0.07, PLOT_CELL - PLOT_INSET);
// Furrow ridges, three per plot: thin strips along the soil, same colour, so
// the shape is what reads as "hoed" rather than a wall of different brown.
const ridgeGeo = new THREE.BoxGeometry(PLOT_CELL - PLOT_INSET, 0.02, 0.12);
const glowGeo = new THREE.PlaneGeometry(PLOT_CELL + 0.1, PLOT_CELL + 0.1);
const barBgGeo = new THREE.PlaneGeometry(BAR_W, BAR_H);
const barFillGeo = new THREE.PlaneGeometry(BAR_W, BAR_H);

// A padded rectangle lying just over the soil. Transparent and depth-write off,
// it is invisible in the render but a perfect target for the tap raycast.
// `visible` stays true so Raycaster includes it - opacity has no say.
const hitGeo = new THREE.PlaneGeometry(PLOT_CELL - PLOT_INSET + 0.06, PLOT_CELL - PLOT_INSET + 0.06);
const hitMat = new THREE.MeshBasicMaterial({
  transparent: true, opacity: 0, depthWrite: false, side: THREE.DoubleSide,
});

// Three stalks at slightly different leans, so a clump reads as wheat rather
// than as a single post. Shared offsets, so every plot has the same character.
const CLUMP = [
  { x: -0.14, z: -0.1, rot: 0.1 },
  { x: 0.11, z: 0.13, rot: -0.13 },
  { x: 0.02, z: -0.16, rot: 0.05 },
];

const green = new THREE.Color(SPROUT);
const gold = new THREE.Color(RIPE);

/**
 * @param {object[]} plots  the live field records, mutated in place elsewhere
 * @param {THREE.Camera} camera  only used to face the progress bar at you
 */
export function createPlants(plots, camera) {
  const group = new THREE.Group();

  const glowMat = new THREE.MeshBasicMaterial({
    color: 0xfff0a8, transparent: true, opacity: 0, depthWrite: false,
  });
  const barBgMat = new THREE.MeshBasicMaterial({ color: 0x111820, transparent: true, opacity: 0.72 });
  const barFillMat = new THREE.MeshBasicMaterial({ color: 0x8fd0ff, transparent: true, opacity: 0.95 });

  const glow = new THREE.Mesh(glowGeo, glowMat);
  glow.rotation.x = -Math.PI / 2;
  glow.position.y = 0.02;
  glow.visible = false;
  group.add(glow);

  const bar = new THREE.Group();
  const barBg = new THREE.Mesh(barBgGeo, barBgMat);
  const barFill = new THREE.Mesh(barFillGeo, barFillMat);
  // Anchored left, so growth grows rightward rather than inflating from the
  // middle and making the number harder to read.
  barFill.position.z = 0.002;
  bar.add(barBg, barFill);
  bar.position.y = BAR_Y;
  bar.visible = false;
  group.add(bar);

  // Tap targets, one per plot, all in one place so the world can ray-cast the
  // whole field in a single pass and first-hit maps straight to a plot.
  const hits = new THREE.Group();
  group.add(hits);

  const nodes = plots.map((plot) => {
    const c = plotCenter(plot);

    const hit = new THREE.Mesh(hitGeo, hitMat);
    hit.rotation.x = -Math.PI / 2;
    hit.position.set(c.x, 0.03, c.z);
    hit.userData.plot = plot;
    hits.add(hit);

    // Per plot, not shared: hydration is a property of one square of ground,
    // and a single shared material would leave every plot the colour of
    // whichever one was painted last.
    const dirtMat = new THREE.MeshStandardMaterial({ color: DIRT, roughness: 1, metalness: 0 });
    const dirt = new THREE.Mesh(soilGeo, dirtMat);
    dirt.position.set(c.x, 0.035, c.z);
    dirt.receiveShadow = true;
    group.add(dirt);

    const ridgeMat = new THREE.MeshStandardMaterial({ color: DIRT, roughness: 1, metalness: 0 });
    const ridges = new THREE.Group();
    for (const rz of [-0.28, 0, 0.28]) {
      const ridge = new THREE.Mesh(ridgeGeo, ridgeMat);
      ridge.position.set(0, 0.085, rz);
      ridges.add(ridge);
    }
    ridges.position.set(c.x, 0, c.z);
    ridges.visible = false;
    group.add(ridges);

    // Two crops share one set of stalks; which material they wear is decided
    // per plot at paint time when the crop is known.
    const stalkMat = new THREE.MeshStandardMaterial({ color: SPROUT, roughness: 0.9, metalness: 0 });
    const headMat = new THREE.MeshStandardMaterial({ color: RIPE, roughness: 0.85, metalness: 0 });
    const leafMat = new THREE.MeshStandardMaterial({ color: CARROT_LEAF, roughness: 0.9, metalness: 0 });
    const nubMat = new THREE.MeshStandardMaterial({ color: CARROT, roughness: 0.85, metalness: 0 });

    const plant = new THREE.Group();
    plant.position.set(c.x, 0.07, c.z);
    plant.visible = false;
    group.add(plant);

    const stalks = [];
    const heads = [];
    for (const s of CLUMP) {
      const stalk = new THREE.Mesh(stalkGeo, stalkMat);
      stalk.position.set(s.x, 0, s.z);
      stalk.rotation.z = s.rot;
      plant.add(stalk);
      stalks.push(stalk);

      const head = new THREE.Mesh(headGeo, headMat);
      head.position.set(s.x, 0, s.z);
      head.rotation.z = s.rot;
      head.visible = false;
      plant.add(head);
      heads.push(head);
    }

    return { plot, c, dirtMat, ridges, ridgeMat, stalks, heads, plant, stalkMat, headMat, leafMat, nubMat };
  });

  let target = null;
  let pulse = 0;

  const colourFor = (plot) => (plot.tilled ? (plot.hydrated ? WET : FARMLAND) : DIRT);

  function paintPlot(node) {
    const { plot } = node;

    node.dirtMat.color.setHex(colourFor(plot));
    node.ridges.visible = plot.tilled;
    node.ridgeMat.color.setHex(colourFor(plot));

    const crop = plot.crop;
    const plant = node.plant;
    plant.visible = !!crop;
    if (!crop) return;

    const stage = stageOf(plot.growth);
    plant.scale.set(1, STAGE_H[Math.min(STAGE_COUNT - 1, stage)], 1);

    const isCarrot = crop === CROPS.carrot.id;
    const leafMat = isCarrot ? node.leafMat : node.stalkMat;
    const fruitMat = isCarrot ? node.nubMat : node.headMat;
    for (const m of node.stalks) m.material = leafMat;
    for (const m of node.heads) m.material = fruitMat;

    if (isCarrot) {
      // Carrots tell you they are carrots by their orange nubs at the ready
      // stage; the leaves stay green throughout.
      node.leafMat.color.setHex(CARROT_LEAF);
      node.nubMat.color.setHex(CARROT);
    } else {
      // Colour is a function of growth rather than of stage, so the field
      // turns gold across the last stretch instead of snapping all at once.
      node.stalkMat.color.copy(green).lerp(gold, plot.growth);
    }

    const showHeads = isReady(plot.growth);
    for (const m of node.heads) m.visible = showHeads;
  }

  return {
    group,
    // The tap-target planes, indexed by plot. Ray-cast these to translate a
    // screen tap into `userData.plot`.
    hits,

    /** Re-reads every plot. Call after any action or after loading a save. */
    refresh() {
      for (const node of nodes) paintPlot(node);
    },

    /** The plot the plushie is standing over, or null. */
    setTarget(plot) {
      target = plot || null;
      const node = target ? nodes[target.key] : null;
      glow.visible = !!node;
      bar.visible = !!node;
      if (node) {
        glow.position.set(node.c.x, 0.02, node.c.z);
        bar.position.set(node.c.x, BAR_Y, node.c.z);
      }
    },

    get target() { return target; },

    update(dt) {
      if (!target) return;
      const node = nodes[target.key];

      pulse += dt;
      glowMat.opacity = 0.35 + Math.sin(pulse * 4) * 0.12;

      // The bar always faces you: a flat plane edge-on would vanish exactly
      // when you walk around to the far side of the plot.
      bar.quaternion.copy(camera.quaternion);

      const g = Math.max(0, Math.min(1, target.growth));
      const gScale = g <= 0 ? 0.0001 : g;
      if (barFill.scale.x !== gScale) {
        barFill.scale.x = gScale;
        barFill.position.x = -(BAR_W * (1 - g)) / 2;
      }
      // Blue while hydrated, cream once it starts to dry: the colour is the
      // water state.
      const fillCol = target.hydrated ? 0x8fd0ff : 0xf2e2b0;
      if (barFillMat.color.getHex() !== fillCol) barFillMat.color.setHex(fillCol);
      const bv = g > 0;
      if (barFill.visible !== bv) barFill.visible = bv;

      const c = colourFor(target);
      if (node.dirtMat.color.getHex() !== c) node.dirtMat.color.setHex(c);
      if (node.ridgeMat.color.getHex() !== c) node.ridgeMat.color.setHex(c);
    },
  };
}