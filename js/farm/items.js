/**
 * Everything the farm grows and every tool that touches it.
 *
 * Deliberately pure: no DOM, no three.js, no clock. The rules for what counts
 * as a valid action live here so the probe can drive a whole season without a
 * canvas, and so the HUD and the world agree on what "you can do this now"
 * means instead of each deciding for itself.
 */

// Seconds of *base* growth from an empty seed to a ripe head. Water doubles it,
// so an unwatered crop still finishes - it just takes twice as long.
export const GROW_TIME = 40;

// How long a plot stays wet after watering. This is the reason watering is a
// chore rather than a one-off: a long trip away can outlast the water.
export const WATER_TIME = 30;
export const WATER_MULT = 2;

export const STAGES = ['planted', 'sprout', 'growing', 'ready'];
export const STAGE_COUNT = STAGES.length;

const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);

/**
 * The catalogue. One crop for now, and that is the point: wheat is the whole
 * economy. The seed is bought, not grown back, so the field needs the shop the
 * way a farm needs a market: profit only lands when you sell what grew.
 */
export const CROPS = {
  wheat: {
    id: 'wheat',
    name: 'Wheat',
    seedCost: 1,
    yield: { wheat: 3 },
  },
};

export const CROP_IDS = Object.keys(CROPS);

// What the shop charges, in coins. Seeds are the consumable, the hoe and the
// can are the durable gear.
export const PRICES = { seed: 2, hoe: 25, can: 25 };

// What the shop pays for one unit of what you bring back.
export const SELL_PRICE = { wheat: 1 };

// How many actions a tool survives before it is worn out and has to be
// replaced. The hand is free and never wears.
export const DURABILITY = { hoe: 40, can: 40 };

/**
 * Tools, in the order the rail lists them. The order is the order of the
 * farming loop itself: break ground, sow, water, reap.
 */
export const TOOLS = ['hoe', 'seeds', 'can', 'hand'];

export const TOOL_DEFS = {
  hoe: {
    id: 'hoe',
    label: 'Hoe',
    hint: 'Break the ground',
    durable: true,
    durability: DURABILITY.hoe,
    // Stroke icons rather than fills: the rest of the HUD is outline art.
    icon:
      '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" ' +
      'stroke-width="2" stroke-linecap="round" stroke-linejoin="round">' +
      '<path d="M4 20 13.5 10.5" />' +
      '<path d="M12.5 5.5 18.5 11.5 15.5 14.5 9.5 8.5Z" /></svg>',
  },
  seeds: {
    id: 'seeds',
    label: 'Seeds',
    hint: 'Sow the tilled soil',
    icon:
      '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" ' +
      'stroke-width="2" stroke-linecap="round" stroke-linejoin="round">' +
      '<path d="M6 9.5 12 6l6 3.5v9L12 22l-6-3.5Z" />' +
      '<path d="M6 9.5 12 13l6-3.5" />' +
      '<path d="M12 13v9" /></svg>',
  },
  can: {
    id: 'can',
    label: 'Water',
    hint: 'Double the growth while it lasts',
    durable: true,
    durability: DURABILITY.can,
    icon:
      '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" ' +
      'stroke-width="2" stroke-linecap="round" stroke-linejoin="round">' +
      '<path d="M4.5 11h9v6.5a2 2 0 0 1-2 2h-5a2 2 0 0 1-2-2Z" />' +
      '<path d="M13.5 13.5 19.5 9" />' +
      '<path d="M7 11V9.5a2.5 2.5 0 0 1 5 0V11" />' +
      '<path d="M19.5 6.5v1" /></svg>',
  },
  hand: {
    id: 'hand',
    label: 'Harvest',
    hint: 'Take what is ripe',
    icon:
      '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" ' +
      'stroke-width="2" stroke-linecap="round" stroke-linejoin="round">' +
      '<path d="M9 12.5V6a1.5 1.5 0 0 1 3 0v5" />' +
      '<path d="M12 11V4.5a1.5 1.5 0 0 1 3 0V11" />' +
      '<path d="M15 11.5V7a1.5 1.5 0 0 1 3 0v7a6 6 0 0 1-6 6h-1a6 6 0 0 1-6-6v-2.5a1.5 1.5 0 0 1 3 0v1.5" /></svg>',
  },
};

/** Which growth stage a 0..1 growth value is showing. */
export function stageOf(growth) {
  return Math.min(STAGE_COUNT - 1, Math.floor(clamp01(growth) * STAGE_COUNT));
}

export const isReady = (growth) => growth >= 1;

/**
 * Growth added by `dt` seconds, given the plot's remaining wet time.
 * Water is checked rather than a flag so a plot that has just dried mid-tick
 * drops to the slow rate on that same tick instead of the next one.
 */
export function growthStep(dt, water) {
  return (Math.max(0, dt) * (water > 0 ? WATER_MULT : 1)) / GROW_TIME;
}

/**
 * Growth to apply after coming back to the tab, or a whole save. O(1) per plot
 * rather than ticking in a loop: the wet window is either spent entirely
 * inside the gap or ends partway through it, and those are the only two cases.
 */
export function catchUp(growth, water, elapsed) {
  let g = clamp01(growth);
  let w = Math.max(0, water);
  let t = Math.max(0, elapsed);

  if (w > 0 && t > 0) {
    const wet = Math.min(w, t);
    g = clamp01(g + growthStep(wet, w));
    w -= wet;
    t -= wet;
  }
  if (t > 0) g = clamp01(g + growthStep(t, 0));

  return { growth: g, water: w };
}
