/**
 * The field: where the plots are, what state each one is in, and what each
 * tool is allowed to do to it.
 *
 * The plot is a plain data record and every mutation goes through `useTool`,
 * so the world, the HUD and the probe all drive the same transitions. Nothing
 * in here knows about meshes - `plants.js` reads the records and draws them.
 */

import {
  WATER_TIME, catchUp, growthStep, isReady, CROPS, TOOLS,
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
      plots.push({ key: i + j * PLOT_COUNT, i, j, tilled: false, crop: null, growth: 0, water: 0 });
    }
  }
  return plots;
}

/** The nearest plot whose centre is within `reach` of a world position. */
export function plotInReach(plots, x, z, reach = REACH) {
  let best = null;
  let bestD = reach * reach;
  for (const plot of plots) {
    const c = plotCenter(plot);
    const d = (c.x - x) * (c.x - x) + (c.z - z) * (c.z - z);
    if (d <= bestD) {
      best = plot;
      bestD = d;
    }
  }
  return best;
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
    plot.crop = CROPS[src.c] ? src.c : null;
    plot.growth = Number.isFinite(src.g) ? Math.min(1, Math.max(0, src.g)) : 0;
    plot.water = Number.isFinite(src.w) ? Math.max(0, src.w) : 0;

    if (plot.crop) {
      const next = catchUp(plot.growth, plot.water, elapsed);
      plot.growth = next.growth;
      plot.water = next.water;
    } else {
      plot.growth = 0;
      plot.water = 0;
    }
  }
  return plots;
}

/** Compact form for the save file: one short key per field, fixed order. */
export function serialiseField(plots) {
  return plots.map((p) => ({ t: p.tilled ? 1 : 0, c: p.crop, g: p.growth, w: p.water }));
}

/**
 * What a tool can do to a plot right now, with a machine-readable reason for
 * when it cannot. The HUD turns the reason into a hint; auto-selection only
 * cares about `ok`.
 *
 * @returns {{ok: boolean, reason: string}}
 */
export function canUse(plot, tool, inventory) {
  if (!plot) return { ok: false, reason: 'no-plot' };

  if (tool === 'hoe') {
    if (plot.tilled) return { ok: false, reason: 'already-tilled' };
    if (plot.crop) return { ok: false, reason: 'has-crop' };
    return { ok: true, reason: 'till' };
  }

  if (tool === 'seeds') {
    if (!plot.tilled) return { ok: false, reason: 'not-tilled' };
    if (plot.crop) return { ok: false, reason: 'has-crop' };
    if (!inventory.has('seeds', CROPS.wheat.seedCost)) {
      return { ok: false, reason: 'no-seeds' };
    }
    return { ok: true, reason: 'sow' };
  }

  if (tool === 'can') {
    if (!plot.crop) return { ok: false, reason: 'empty' };
    if (isReady(plot.growth)) return { ok: false, reason: 'ripened' };
    if (plot.water >= WATER_TIME) return { ok: false, reason: 'full-water' };
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
 * The tool that would work on this plot, in loop order. Returns null when
 * nothing would - the plot is finished for now, and the action button should
 * say so rather than performing a wrong action.
 */
export function autoTool(plot, inventory) {
  for (const tool of TOOLS) {
    if (canUse(plot, tool, inventory).ok) return tool;
  }
  return null;
}

/**
 * Performs the action. Returns the same shape `canUse` does, so a caller can
 * check first and act second without the two drifting apart.
 *
 * Harvest keeps the plot tilled. Ground you have already broken is not
 * something you should have to break again, and clearing it back to grass
 * would make the field a chore to walk across between seasons.
 */
export function useTool(plot, tool, inventory) {
  const verdict = canUse(plot, tool, inventory);
  if (!verdict.ok) return verdict;

  if (tool === 'hoe') {
    plot.tilled = true;
    return verdict;
  }

  if (tool === 'seeds') {
    if (!inventory.spend('seeds', CROPS.wheat.seedCost)) {
      return { ok: false, reason: 'no-seeds' };
    }
    plot.crop = 'wheat';
    plot.growth = 0;
    plot.water = 0;
    return verdict;
  }

  if (tool === 'can') {
    plot.water = WATER_TIME;
    return verdict;
  }

  if (tool === 'hand') {
    const crop = CROPS[plot.crop];
    for (const [kind, n] of Object.entries(crop.yield)) inventory.give(kind, n);
    plot.crop = null;
    plot.growth = 0;
    plot.water = 0;
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
    if (!plot.crop || plot.growth >= 1) {
      // Water still drains on a ripe plot so the number is honest when the
      // next seed goes in.
      if (plot.water > 0) plot.water = Math.max(0, plot.water - dt);
      continue;
    }
    plot.growth = Math.min(1, plot.growth + growthStep(dt, plot.water));
    if (plot.water > 0) plot.water = Math.max(0, plot.water - dt);
  }
}
