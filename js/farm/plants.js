import * as THREE from 'three';

import { STAGE_COUNT, stageOf, isReady, WATER_TIME } from './items.js';
import { PLOT_COUNT, PLOT_CELL, PLOT_INSET, plotCenter } from './plots.js';

/**
 * What the field looks like: soil, wheat, the highlight on the plot you are
 * standing over, and the little bar that says how far along it is.
 *
 * Geometry and materials are built once and shared between plots - thirty-six
 * copies of the same stalk is thirty-six times the memory for no visual gain.
 * Only the per-plot material colours differ, because a half-ripe row next to a
 * ripe one is the clearest possible progress indicator.
 */

const SOIL = 0x6b4a33;
const SOIL_WET = 0x46301f;
const SPROUT = 0x9ac46a;
const RIPE = 0xd9ac45;

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
const glowGeo = new THREE.PlaneGeometry(PLOT_CELL + 0.1, PLOT_CELL + 0.1);
const barBgGeo = new THREE.PlaneGeometry(BAR_W, BAR_H);
const barFillGeo = new THREE.PlaneGeometry(BAR_W, BAR_H);

// Three stalks at slightly different leans, so a clump reads as wheat rather
// than as a single post. Shared offsets, so every plot has the same character.
const CLUMP = [
  { x: -0.14, z: -0.1, rot: 0.1 },
  { x: 0.11, z: 0.13, rot: -0.13 },
  { x: 0.02, z: -0.16, rot: 0.05 },
];

const green = new THREE.Color(SPROUT);
const gold = new THREE.Color(RIPE);
const soilDry = new THREE.Color(SOIL);
const soilWet = new THREE.Color(SOIL_WET);

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

  const nodes = plots.map((plot) => {
    const c = plotCenter(plot);

    // Per plot, not shared: wetness is a property of one square of ground, and
    // a single shared material would leave every plot the colour of whichever
    // one was painted last.
    const soilMat = new THREE.MeshStandardMaterial({ roughness: 1, metalness: 0 });
    const soil = new THREE.Mesh(soilGeo, soilMat);
    soil.position.set(c.x, 0.035, c.z);
    soil.receiveShadow = true;
    soil.visible = false;
    group.add(soil);

    const plant = new THREE.Group();
    plant.position.set(c.x, 0.07, c.z);
    plant.visible = false;
    group.add(plant);

    const stalkMat = new THREE.MeshStandardMaterial({ color: SPROUT, roughness: 0.9, metalness: 0 });
    const headMat = new THREE.MeshStandardMaterial({ color: RIPE, roughness: 0.85, metalness: 0 });

    for (const s of CLUMP) {
      const stalk = new THREE.Mesh(stalkGeo, stalkMat);
      stalk.position.set(s.x, 0, s.z);
      stalk.rotation.z = s.rot;
      plant.add(stalk);

      const head = new THREE.Mesh(headGeo, headMat);
      head.position.set(s.x, 0, s.z);
      head.rotation.z = s.rot;
      head.visible = false;
      plant.add(head);
      head.userData.head = true;
    }

    return { plot, c, soil, soilMat, plant, stalkMat, headMat };
  });

  let target = null;
  let pulse = 0;

  function paintPlot(node) {
    const { plot, soil, soilMat, plant, stalkMat } = node;

    soil.visible = plot.tilled;
    if (plot.tilled) soilMat.color.copy(soilDry).lerp(soilWet, Math.min(1, plot.water / WATER_TIME));

    const grown = !!plot.crop;
    plant.visible = grown;
    if (!grown) return;

    const stage = stageOf(plot.growth);
    plant.scale.set(1, STAGE_H[Math.min(STAGE_COUNT - 1, stage)], 1);

    // Colour is a function of growth rather than of stage, so the field turns
    // gold across the last stretch instead of snapping all at once.
    stalkMat.color.copy(green).lerp(gold, plot.growth);

    const showHeads = isReady(plot.growth);
    for (const child of plant.children) {
      if (child.userData.head) child.visible = showHeads;
    }
  }

  return {
    group,

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
      barFill.scale.x = Math.max(0.0001, g);
      barFill.position.x = -(BAR_W * (1 - g)) / 2;
      // Blue while wet, cream once it starts to dry: the colour is the timer.
      barFillMat.color.setHex(target.water > 0 ? 0x8fd0ff : 0xf2e2b0);
      barFill.visible = g > 0;

      node.soil.material.color.copy(soilDry).lerp(soilWet, Math.min(1, target.water / WATER_TIME));
    },
  };
}
