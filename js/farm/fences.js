/**
 * The fence: where a run of fencing can stand along the field's gridlines.
 *
 * A 8x8 field has 9 gap-lines in each direction (the seven across the field
 * plus the two edges), each holding 8 segments between junctions. Every
 * segment is a possible fence post; the world turns each placed one into a
 * length of post-and-rail and gives its slot a tap target. Pure rules, so the
 * probe can lay out whole paddocks without a canvas.
 */
import { PLOT_COUNT, PLOT_CELL } from './plots.js';

export const LINES = PLOT_COUNT + 1;           // 9 gap-lines each way
export const SEGMENTS = PLOT_COUNT;            // 8 segments on each line
export const FENCE_SLOT_COUNT = LINES * SEGMENTS * 2; // 144

// Gap-lines sit at the plot edges: -4.8..4.8 in steps of 1.2 for an 8x8 field.
const start = -(PLOT_COUNT / 2) * PLOT_CELL;

/** Unique slot key from an axis and grid line/segment numbers. */
export function slotKey(a, line, seg) {
  return a + ':' + line + ':' + seg;
}

/** Whether a fence position is a real slot. */
export function slotValid(a, line, seg) {
  return (
    (a === 0 || a === 1) &&
    Number.isInteger(line) && line >= 0 && line < LINES &&
    Number.isInteger(seg) && seg >= 0 && seg < SEGMENTS
  );
}

/** Midpoint of a slot in world space, for placing its mesh and hit plane. */
export function slotMid(a, line, seg) {
  if (a === 0) {
    // Axis 0 runs along z at a fixed x: a fence crossing the field sideways.
    return { x: start + line * PLOT_CELL, z: start + (seg + 0.5) * PLOT_CELL };
  }
  // Axis 1 runs along x at a fixed z.
  return { x: start + (seg + 0.5) * PLOT_CELL, z: start + line * PLOT_CELL };
}

/** Turns a saved list of slots into a fast occupancy map, deduped. */
export function buildFences(saved) {
  const placed = new Map();
  if (!Array.isArray(saved)) return placed;
  for (const f of saved) {
    if (slotValid(f.a, f.l, f.s)) placed.set(slotKey(f.a, f.l, f.s), { a: f.a, l: f.l, s: f.s });
  }
  return placed;
}

/** Walks every slot, earliest first, so the world can build all hit planes. */
export function forEachSlot(fn) {
  for (let a = 0; a < 2; a++) {
    for (let line = 0; line < LINES; line++) {
      for (let seg = 0; seg < SEGMENTS; seg++) fn({ a, l: line, s: seg });
    }
  }
}