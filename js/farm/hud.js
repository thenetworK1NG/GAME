import { TOOLS, TOOL_DEFS } from './items.js';

/**
 * The farm's screen furniture: the tool rail, the wallet, the hint line, and
 * the action button's glyph.
 *
 * Everything here is DOM only, and it is painted from one `paint()` call each
 * frame so index.js never has to reason about *which* label changed. Painting
 * diffs against the last frame internally: toggling identical textContent every
 * frame would fight the compositor for nothing.
 *
 * What the current tool *does* is decided in index.js, so the rail can be
 * re-skinned or re-laid-out without touching a single rule about what is legal
 * to do to a plot.
 */

const MISSING = 'farm hud: missing from index.html: ';

function need(id) {
  const el = document.getElementById(id);
  if (!el) throw new Error(MISSING + id);
  return el;
}

// Shown in the glyph while the plushie is carrying something: the action would
// drop it, not use the tool, so the button should say so.
export const DROP_ICON =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" ' +
  'stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">' +
  '<path d="M12 3v12" />' +
  '<path d="M7 10.5 12 15.5 17 10.5" />' +
  '<path d="M5 19.5h14" /></svg>';

// Shown while the action would step through a doorway (the arch) rather than
// use a tool.
export const GO_ICON =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" ' +
  'stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">' +
  '<path d="M4 12h11" />' +
  '<path d="M12 6.5 17.5 12 12 17.5" /></svg>';

export function createHud({ onPick = () => {} } = {}) {
  const rail = need('tool-rail');
  const wallet = need('wallet');
  const seedsEl = need('wallet-seeds');
  const wheatEl = need('wallet-wheat');
  const hint = need('tool-hint');
  const glyphEl = need('action-glyph');
  const action = need('action');

  const buttons = new Map();
  for (const id of TOOLS) {
    const def = TOOL_DEFS[id];
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'tool';
    btn.dataset.tool = id;
    btn.setAttribute('aria-label', def.label);
    btn.innerHTML = def.icon;
    btn.addEventListener('click', () => onPick(id));
    rail.appendChild(btn);
    buttons.set(id, btn);
  }

  let visible = false;

  // Last-painted state, so paint() never touches the DOM twice in a row.
  const last = {
    tool: null, glyph: null, ready: null, enabled: null,
    hint: null, seeds: null, wheat: null, walletEmpty: null, carried: null,
  };

  function paint(state) {
    const tool = state.tool;
    const carried = !!state.carried;

    // Carried wins over everything (pressing drops), then the door wins over
    // hoes, then the selected tool. The star on the rail still names `tool`.
    const glyph = carried
      ? DROP_ICON
      : state.glyph || (tool ? TOOL_DEFS[tool].icon : '');

    if (carried !== last.carried) {
      last.carried = carried;
      action.classList.toggle('carrying', carried);
    }
    if (glyph !== last.glyph) {
      last.glyph = glyph;
      glyphEl.innerHTML = glyph;
    }
    if (tool !== last.tool) {
      last.tool = tool;
      for (const [id, btn] of buttons) {
        const on = id === tool;
        btn.classList.toggle('selected', on);
        btn.setAttribute('aria-pressed', on ? 'true' : 'false');
      }
    }

    const ready = state.ready;
    if (ready !== last.ready) {
      last.ready = ready;
      for (const [id, btn] of buttons) btn.classList.toggle('ready', id === ready);
    }

    const enabled = !!state.enabled;
    if (enabled !== last.enabled) {
      last.enabled = enabled;
      action.disabled = !enabled;
    }

    const hintText = state.hint || '';
    if (hintText !== last.hint) {
      last.hint = hintText;
      hint.textContent = hintText;
    }

    const seeds = state.counts && state.counts.seeds;
    const wheat = state.counts && state.counts.wheat;
    if (seeds !== last.seeds) {
      last.seeds = seeds;
      seedsEl.textContent = String(seeds ?? 0);
    }
    if (wheat !== last.wheat) {
      last.wheat = wheat;
      wheatEl.textContent = String(wheat ?? 0);
    }
    const walletEmpty = (seeds ?? 0) === 0;
    if (walletEmpty !== last.walletEmpty) {
      last.walletEmpty = walletEmpty;
      wallet.classList.toggle('empty', walletEmpty);
    }
  }

  return {
    get visible() { return visible; },

    show() {
      visible = true;
      rail.classList.add('visible');
      wallet.classList.add('visible');
      hint.classList.add('visible');
      action.classList.add('farming');
      rail.setAttribute('aria-hidden', 'false');
      wallet.setAttribute('aria-hidden', 'false');
    },

    hide() {
      visible = false;
      rail.classList.remove('visible', 'farming');
      wallet.classList.remove('visible');
      hint.classList.remove('visible');
      action.classList.remove('farming');
      action.classList.remove('carrying');
      rail.setAttribute('aria-hidden', 'true');
      wallet.setAttribute('aria-hidden', 'true');
      // Force a repaint on the next show: hide() armed the house's own carry
      // cue, and re-entering the farm must not replay a stale glyph.
      last.tool = null;
      last.carried = null;
    },

    /** @param {object} state see paint(), above. */
    paint,

    /** A short refusal. Plays once; the animation resets itself. */
    warn() {
      action.classList.remove('warn');
      // Force a reflow so re-adding the class restarts the animation rather
      // than doing nothing because the browser thinks it is still running.
      void action.offsetWidth;
      action.classList.add('warn');
    },
  };
}