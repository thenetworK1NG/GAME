/**
 * The field: where the plots are, what state each one is in, and what each
 * tool is allowed to do to it.
 *
 * The plot is a plain data record and every mutation goes through `useTool`,
 * so the world, the HUD and the probe all drive the same transitions. Nothing
 * in here knows about meshes - `plants.js` reads the records and draws them.
 *
 * The states follow Minecraft's tilling loop: dirt, walked over by a hoe,
 * becomes farmland; farmland that is watering-can'd becomes hydrated farmland
 * and grows crops twice as fast. Harvest returns the crop's own seed, the
 * farmland keeps its hydration, and only empty, un-hydrated farmland can dry
 * back to dirt again.
 */

import {
  DIRT_SECONDS, catchUp, growthStep, isReady, CROPS,
} from './items.js';

export const PLOT_COUNT = 6;
export const PLOT_CELL = 1.0;
// Grass showing between plots, so a tilled square reads as a patch of ground
// rather than as one continuous dark floor.
export const PLOT_INSET = 0.06;

// The field sits in the middle of the island, just in front of where the
// plushie arrives, so the first thing you see is the thing you came for.
export const FIELD_CENTER = { x: 0, z: 0 };

// How close the plushie has to be to work a plot. A little over one cell, so
// standing on the field's edge reaches the near row but not the far one.
export const REACH = 1.55;

// The reach a drag sweep gets on top of the walk-and-work reach: from anywhere
// in the field's interior a long stroke covers every plot, so you walk into
// the middle once and then paint rows without shuffling.
export const PAINT_REACH = 4.0;

/** Centre of a plot in world space. */
export function plotCenter(plot) {
  const half = (PLOT_COUNT - 1) / 2;
  return {
    x: FIELD_CENTER.x + (plot.i - half) * PLOT_CELL,
    z: FIELD_CENTER.z + (plot.j - half) * PLOT_CELL,
  };
}

export function createField() {
  const plots = [];
  for (let j = 0; j < PLOT_COUNT; j++) {
    for (let i = 0; i < PLOT_COUNT; i++) {
      plots.push({
        key: i + j * PLOT_COUNT, i, j,
        tilled: false, hydrated: false, dry: 0,
        crop: null, growth: 0,
      });
    }
  }
  return plots;
}

/** Whether one particular plot is close enough to work. */
export function plotWithinReach(plot, x, z, reach = REACH) {
  const c = plotCenter(plot);
  const d = (c.x - x) * (c.x - x) + (c.z - z) * (c.z - z);
  return d <= reach * reach;
}

/**
 * Rebuilds the field from a save, running growth forward over the gap in one
 * pass per plot. A save with the wrong number of plots is discarded outright:
 * half a field of mismatched records is worse than starting over.
 */
export function restoreField(saved, elapsed = 0) {
  if (!Array.isArray(saved) || saved.length !== PLOT_COUNT * PLOT_COUNT) return null;

  const plots = createField();
  for (let n = 0; n < plots.length; n++) {
    const src = saved[n] || {};
    const plot = plots[n];
    plot.tilled = src.t === 1 || src.t === true;
    plot.hydrated = src.h === 1 || src.h === true;
    plot.dry = Number.isFinite(src.d) ? Math.max(0, src.d) : 0;
    plot.crop = CROPS[src.c] ? src.c : null;
    plot.growth = Number.isFinite(src.g) ? Math.min(1, Math.max(0, src.g)) : 0;

    if (plot.crop) {
      plot.growth = catchUp(plot.growth, plot.hydrated, elapsed, CROPS[plot.crop].grow);
    } else {
      plot.growth = 0;
      plot.dry = 0;
    }
  }
  return plots;
}

/** Compact form for the save file: one short key per field, fixed order. */
export function serialiseField(plots) {
  return plots.map((p) => ({
    t: p.tilled ? 1 : 0,
    h: p.hydrated ? 1 : 0,
    d: p.dry,
    c: p.crop,
    g: p.growth,
  }));
}

/** The crop a seed tool would sow, if the tool is one of the two seed bags. */
function seedCrop(tool) {
  return tool === 'seeds' ? CROPS.wheat : tool === 'carrotSeed' ? CROPS.carrot : null;
}

/**
 * What a tool can do to a plot right now, with a machine-readable reason for
 * when it cannot. The HUD turns the reason into a hint; how a tool *wears*
 * comes in through `tools` — a map of remaining uses, with `null` meaning the
 * tool is not owned at all.
 *
 * @param {object} tools  `{ hoe: number|null, can: number|null }`
 * @returns {{ok: boolean, reason: string}}
 */
export function canUse(plot, tool, inventory, tools = {}) {
  if (!plot) return { ok: false, reason: 'no-plot' };

  if (tool === 'hoe') {
    if (tools.hoe == null) return { ok: false, reason: 'no-tool' };
    if (tools.hoe <= 0) return { ok: false, reason: 'worn' };
    if (plot.tilled) return { ok: false, reason: 'already-tilled' };
    if (plot.crop) return { ok: false, reason: 'has-crop' };
    return { ok: true, reason: 'till' };
  }

  const crop = seedCrop(tool);
  if (crop) {
    if (!plot.tilled) return { ok: false, reason: 'not-tilled' };
    if (plot.crop) return { ok: false, reason: 'has-crop' };
    if (!inventory.has(crop.seedKind, crop.seedCost)) {
      return { ok: false, reason: 'no-seeds' };
    }
    return { ok: true, reason: 'sow' };
  }

  if (tool === 'can') {
    if (!plot.tilled) return { ok: false, reason: 'not-tilled' };
    if (plot.hydrated) return { ok: false, reason: 'hydrated' };
    if (tools.can == null) return { ok: false, reason: 'no-tool' };
    if (tools.can <= 0) return { ok: false, reason: 'worn' };
    return { ok: true, reason: 'water' };
  }

  if (tool === 'hand') {
    if (!plot.crop) return { ok: false, reason: 'empty' };
    if (!isReady(plot.growth)) return { ok: false, reason: 'not-ready' };
    return { ok: true, reason: 'harvest' };
  }

  return { ok: false, reason: 'unknown-tool' };
}

/**
 * Performs the action. Returns the same shape `canUse` does, so a caller can
 * check first and act second without the two drifting apart.
 *
 * Success wears the hoe and the can by one action; the seeds and the hand do
 * not wear. The refusal path never decrements.
 *
 * Harvest returns the crop and its own seed, and leaves the farmland broken
 * and hydrated exactly as it was - a tended plot cycles without new work.
 */
export function useTool(plot, tool, inventory, tools = {}) {
  const verdict = canUse(plot, tool, inventory, tools);
  if (!verdict.ok) return verdict;

  if (tool === 'hoe') {
    plot.tilled = true;
    plot.dry = 0;
    tools.hoe -= 1;
    return verdict;
  }

  const crop = seedCrop(tool);
  if (crop) {
    if (!inventory.spend(crop.seedKind, crop.seedCost)) {
      return { ok: false, reason: 'no-seeds' };
    }
    plot.crop = crop.id;
    plot.growth = 0;
    plot.dry = 0;
    return verdict;
  }

  if (tool === 'can') {
    plot.hydrated = true;
    plot.dry = 0;
    tools.can -= 1;
    return verdict;
  }

  if (tool === 'hand') {
    const cropDef = CROPS[plot.crop];
    for (const [kind, n] of Object.entries(cropDef.yield)) inventory.give(kind, n);
    plot.crop = null;
    plot.growth = 0;
    plot.dry = 0;
    return verdict;
  }

  return { ok: false, reason: 'unknown-tool' };
}

/**
 * Runs growth forward for an already-loaded field. Used for the tab going back
 * to the foreground, where reloading the whole save would throw away whatever
 * the player had arranged since.
 */
export function tickField(plots, dt) {
  for (const plot of plots) {
    if (plot.crop) {
      plot.dry = 0;
      if (!isReady(plot.growth)) {
        plot.growth = Math.min(1, plot.growth + growthStep(dt, plot.hydrated, CROPS[plot.crop].grow));
      }
      continue;
    }
    // Empty farmland drifts back to dirt unless it stays hydrated. A crop in
    // hand (or under it) keeps the ground kept.
    if (plot.tilled && !plot.hydrated) {
      plot.dry += dt;
      if (plot.dry >= DIRT_SECONDS) {
        plot.tilled = false;
        plot.hydrated = false;
        plot.dry = 0;
      }
    } else {
      plot.dry = 0;
    }
  }
}