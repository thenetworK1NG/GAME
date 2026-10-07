/**
 * The farm's save file: one localStorage key holding everything that survives
 * closing the tab.
 *
 * Storage is resolved once and can legitimately be nothing at all - private
 * browsing modes throw on `setItem`, and the probe runs without a window. When
 * there is no backing store the game still plays, it simply forgets when you
 * leave, which is strictly better than throwing during boot and showing the
 * error panel over an empty sky.
 */

export const SAVE_KEY = 'plushie.farm.v3';

// Bumped only when the shape below changes in a way the loader cannot read.
const VERSION = 3;

let backing;
let resolved = false;

function storage() {
  if (resolved) return backing;
  resolved = true;
  backing = null;
  try {
    const store = globalThis.localStorage;
    if (!store) return backing;
    // Safari in private mode has localStorage but rejects writes.
    store.setItem('__plushie_probe__', '1');
    store.removeItem('__plushie_probe__');
    backing = store;
  } catch {
    backing = null;
  }
  return backing;
}

/** In-memory stand-in, so `available()` reports honestly in the probe. */
const NULL_STORE = (() => {
  const map = new Map();
  return {
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => map.set(k, String(v)),
    removeItem: (k) => map.delete(k),
  };
})();

function store() {
  return storage() || NULL_STORE;
}

export const available = () => storage() !== null;

/**
 * @param {{inventory: object, plots: object[], fences?: object[],
 *          tool?: string, tools?: object, now?: number}} state
 * @returns {boolean} whether the write landed in real storage.
 */
export function writeFarm(state) {
  const payload = {
    version: VERSION,
    savedAt: state.now ?? Date.now(),
    tool: state.tool || null,
    tools: state.tools || null,
    inventory: state.inventory,
    plots: state.plots,
    fences: state.fences || [],
  };
  try {
    store().setItem(SAVE_KEY, JSON.stringify(payload));
    return storage() !== null;
  } catch {
    return false;
  }
}

/**
 * Reads the save and reports how long the farm was left alone, so the caller
 * can run growth forward once rather than per-frame.
 *
 * A `savedAt` in the future - a clock that went backwards, or a save written
 * under a different timezone - is clamped to now. Negative elapsed time would
 * otherwise silently rewind growth, which reads as a crop going backwards.
 *
 * @returns {null | {elapsed: number, savedAt: number, tool: ?string,
 *                   tools: ?object, inventory: object, plots: object[],
 *                   fences: object[]}}
 */
export function readFarm(now = Date.now()) {
  let raw;
  try {
    raw = store().getItem(SAVE_KEY);
  } catch {
    return null;
  }
  if (!raw) return null;

  let data;
  try {
    data = JSON.parse(raw);
  } catch {
    // Corrupt or truncated: better to start a fresh farm than to crash on load.
    clearFarm();
    return null;
  }

  if (!data || data.version !== VERSION) {
    clearFarm();
    return null;
  }

  const savedAt = Number(data.savedAt);
  const saved = Number.isFinite(savedAt) ? Math.min(savedAt, now) : now;

  return {
    savedAt,
    elapsed: Math.max(0, (now - saved) / 1000),
    tool: typeof data.tool === 'string' ? data.tool : null,
    tools: data.tools && typeof data.tools === 'object' ? data.tools : null,
    inventory: data.inventory && typeof data.inventory === 'object' ? data.inventory : null,
    plots: Array.isArray(data.plots) ? data.plots : null,
    fences: Array.isArray(data.fences) ? data.fences : null,
  };
}

export function clearFarm() {
  try {
    store().removeItem(SAVE_KEY);
  } catch {
    // Nothing useful to do: the key is already unreadable or unwritable.
  }
}
