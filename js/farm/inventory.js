/**
 * What the plushie is carrying: seeds to spend and wheat to show for it.
 *
 * Plain counts behind accessors rather than a plain object, because the counts
 * are only ever meant to change through `spend` and `give`. That keeps "did you
 * actually have the seed?" in one place instead of re-checking it at every call
 * site and forgetting it at one.
 */

export const KINDS = ['seeds', 'wheat'];

export const STARTING = { seeds: 10, wheat: 0 };

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
