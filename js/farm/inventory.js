/**
 * The plushie's purse: seeds to sow, wheat to sell, and the coins the selling
 * brings in. Three numbers, and every transaction between them goes through
 * `spend` and `give`, so "did you actually have it?" lives in one place.
 */

export const KINDS = ['seeds', 'wheat', 'coins'];

export const STARTING = { seeds: 5, wheat: 0, coins: 30 };

function normalise(data) {
  const out = {};
  for (const kind of KINDS) {
    const n = Number(data && data[kind]);
    // Missing or nonsense entries fall back to the start value rather than
    // producing NaN, which would poison every later arithmetic comparison.
    out[kind] = Number.isFinite(n) && n >= 0 ? Math.floor(n) : STARTING[kind];
  }
  return out;
}

export function createInventory(start = STARTING) {
  const counts = normalise(start);

  return {
    get seeds() { return counts.seeds; },
    get wheat() { return counts.wheat; },
    get coins() { return counts.coins; },

    has(kind, n = 1) {
      return KINDS.includes(kind) && counts[kind] >= n;
    },

    /** Returns false and changes nothing when there is not enough. */
    spend(kind, n = 1) {
      if (!this.has(kind, n)) return false;
      counts[kind] -= n;
      return true;
    },

    give(kind, n = 1) {
      if (!KINDS.includes(kind)) return false;
      counts[kind] += Math.max(0, Math.floor(n));
      return true;
    },

    snapshot() {
      return { ...counts };
    },

    restore(data) {
      Object.assign(counts, normalise(data));
      return this;
    },
  };
}
