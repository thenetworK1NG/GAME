/**
 * Everything the farm grows and every tool that touches it.
 *
 * Deliberately pure: no DOM, no three.js, no clock. The rules for what counts
 * as a valid action live here so the probe can drive a whole season without a
 * canvas, and so the HUD and the world agree on what "you can do this now"
 * means instead of each deciding for itself.
 */

// Seconds of *base* growth from an empty seed to a ripe head. Hydrated
// farmland doubles it, so an un-watered crop still finishes - it just takes
// twice as long.
export const GROW_TIME = 40;

// How long empty, un-hydrated farmland may sit before it dries back to plain
// dirt and needs the hoe again. Farmland with a crop never dries out and
// hydrated farmland never dries at all, the way tilled soil behaves in
// Minecraft when the water is kept to it.
export const DIRT_SECONDS = 45;

export const WATER_MULT = 2;

export const STAGES = ['planted', 'sprout', 'growing', 'ready'];
export const STAGE_COUNT = STAGES.length;

const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);

/**
 * The catalogue. Wheat is the bread-and-butter crop, carrots the posh one:
 * a pricier seed, twice the coin, slower to ripen. Every harvest returns its
 * own seed, so a tended field feeds itself and the shop is where extra ground
 * comes from - and where the tools that break get replaced.
 */
export const CROPS = {
  wheat: {
    id: 'wheat',
    name: 'Wheat',
    grow: GROW_TIME,
    seedCost: 1,
    // Which consumable in the purse sows this crop.
    seedKind: 'seeds',
    yield: { wheat: 1, seeds: 1 },
  },
  carrot: {
    id: 'carrot',
    name: 'Carrot',
    grow: 55,
    seedCost: 1,
    seedKind: 'carrotSeed',
    yield: { carrot: 1, carrotSeed: 1 },
  },
};

// What the shop charges, in coins. Seeds are the consumables, the hoe and the
// can are the durable gear, and the fence is what the extra coins build.
export const PRICES = { seed: 2, carrotSeed: 4, hoe: 25, can: 25, fence: 3 };

// What the shop pays for one unit of what you bring back.
export const SELL_PRICE = { wheat: 1, carrot: 2 };

// How many actions a tool survives before it is worn out and has to be
// replaced. Short on purpose: a hoe breaks about every season and a half, so
// the trip to the shop is part of the loop, not a one-off. The hand is free.
export const DURABILITY = { hoe: 24, can: 30 };

/**
 * Tools, in the order the rail lists them. The order is the order of the
 * farming loop itself: break ground, sow, water, reap. The fence is not a
 * plot tool, so it lives outside this list; the HUD hangs it on the rail
 * separately.
 */
export const TOOLS = ['hoe', 'seeds', 'carrotSeed', 'can', 'hand'];

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
    label: 'Wheat seeds',
    hint: 'Sow the tilled soil',
    icon:
      '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" ' +
      'stroke-width="2" stroke-linecap="round" stroke-linejoin="round">' +
      '<path d="M6 9.5 12 6l6 3.5v9L12 22l-6-3.5Z" />' +
      '<path d="M6 9.5 12 13l6-3.5" />' +
      '<path d="M12 13v9" /></svg>',
  },
  carrotSeed: {
    id: 'carrotSeed',
    label: 'Carrot seeds',
    hint: 'Sow carrots on the tilled soil',
    icon:
      '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" ' +
      'stroke-width="2" stroke-linecap="round" stroke-linejoin="round">' +
      '<path d="M12 8.5c-3 1.8-5.5 4.6-5.5 7.4a5.5 5.5 0 0 0 11 0c0-2.8-2.5-5.6-5.5-7.4Z" />' +
      '<path d="M12 8.5v-4" />' +
      '<path d="M9.2 4.5h5.6" /></svg>',
  },
  can: {
    id: 'can',
    label: 'Water',
    hint: 'Hydrate the farmland for good',
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
  fence: {
    id: 'fence',
    // Not in TOOLS: it builds, it does not work a plot.
    label: 'Fence',
    hint: 'Tap a gap between plots to build',
    icon:
      '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" ' +
      'stroke-width="2" stroke-linecap="round" stroke-linejoin="round">' +
      '<path d="M5 3.5v17" />' +
      '<path d="M19 3.5v17" />' +
      '<path d="M5 7h14" />' +
      '<path d="M5 14h14" />' +
      '<path d="M12 3.5v17" /></svg>',
  },
};

/** Which growth stage a 0..1 growth value is showing. */
export function stageOf(growth) {
  return Math.min(STAGE_COUNT - 1, Math.floor(clamp01(growth) * STAGE_COUNT));
}

export const isReady = (growth) => growth >= 1;

/**
 * Growth added by `dt` seconds, given whether the farmland is hydrated.
 * Hydration is a state, not a timer, so the rate holds for the whole tick.
 */
export function growthStep(dt, hydrated, grow = GROW_TIME) {
  return (Math.max(0, dt) * (hydrated ? WATER_MULT : 1)) / grow;
}

/**
 * Growth to apply after coming back to the tab, or a whole save. Hydration is
 * a plain state, so the rate is constant across the gap - the water cannot
 * run out halfway through it.
 */
export function catchUp(growth, hydrated, elapsed, grow = GROW_TIME) {
  return clamp01(clamp01(growth) + growthStep(elapsed, hydrated, grow));
}