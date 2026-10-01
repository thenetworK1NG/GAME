/**
 * Multitouch-safe virtual joystick.
 *
 * Pins one finger by `identifier` when the gesture starts, so a second thumb
 * touching the screen (or a stray palm) cannot hijack the stick mid-drag.
 * Emits a normalised vector in {x, y} where +y is "up" on screen and the
 * magnitude is 0..1.
 */

const DEAD_ZONE = 0.15;

// Local helper so this module stays free of a three.js import.
const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);

export class Joystick {
  constructor(rootId = 'joystick', knobId = 'knob') {
    this.root = document.getElementById(rootId);
    this.knob = document.getElementById(knobId);

    if (!this.root || !this.knob) {
      throw new Error('Joystick: missing #%s or #%s in the DOM', rootId, knobId);
    }

    this.vector = { x: 0, y: 0 };
    this.touchId = null;

    // Max travel of the knob, i.e. the point where the stick is fully pushed.
    this.maxTravel = this.root.clientWidth / 2 - this.knob.clientWidth / 2;

    this._onStart = this._onStart.bind(this);
    this._onMove = this._onMove.bind(this);
    this._onEnd = this._onEnd.bind(this);

    // `passive: false` so we can preventDefault and suppress scrolling/zoom
    // without the browser logging a passive-listener violation.
    const opts = { passive: false };
    this.root.addEventListener('touchstart', this._onStart, opts);
    this.root.addEventListener('touchmove', this._onMove, opts);
    this.root.addEventListener('touchend', this._onEnd, opts);
    this.root.addEventListener('touchcancel', this._onEnd, opts);

    // Mouse support so the game is testable on a desktop browser.
    this.root.addEventListener('mousedown', this._onStart, opts);
    window.addEventListener('mousemove', this._onMove, opts);
    window.addEventListener('mouseup', this._onEnd, opts);

    // Recompute travel after layout settles (fonts, safe-area insets, rotation).
    window.addEventListener('resize', () => this._measure());
    window.addEventListener('orientationchange', () => setTimeout(() => this._measure(), 120));
    this._measure();
  }

  _measure() {
    this.maxTravel = Math.max(
      1,
      this.root.clientWidth / 2 - this.knob.clientWidth / 2
    );
  }

  _centre() {
    const rect = this.root.getBoundingClientRect();
    return {
      x: rect.left + rect.width / 2,
      y: rect.top + rect.height / 2,
    };
  }

  _onStart(event) {
    // Mouse gives us a single pointer with no identifier to compare.
    if (event.type === 'mousedown') {
      if (this.touchId !== null) return;
      this.touchId = 'mouse';
    } else {
      for (const touch of event.changedTouches) {
        if (this.touchId === null) {
          this.touchId = touch.identifier;
          break;
        }
      }
      if (this.touchId === null) return;
    }

    event.preventDefault();
    this.root.classList.add('active');
    this._onMove(event);
  }

  _onMove(event) {
    if (this.touchId === null) return;

    let point = null;

    if (event.type === 'mousemove') {
      if (this.touchId !== 'mouse') return;
      point = { x: event.clientX, y: event.clientY };
    } else {
      for (const touch of event.changedTouches) {
        if (touch.identifier === this.touchId) {
          point = { x: touch.clientX, y: touch.clientY };
          break;
        }
      }
    }

    // The pinned finger left the touch list entirely.
    if (!point) return;

    event.preventDefault();

    const centre = this._centre();
    let dx = point.x - centre.x;
    let dy = point.y - centre.y;

    const distance = Math.hypot(dx, dy);
    if (distance > this.maxTravel) {
      // Clamp onto the rim so the stick cannot be dragged outside its housing.
      const scale = this.maxTravel / distance;
      dx *= scale;
      dy *= scale;
    }

    this.knob.style.transform = `translate(${dx}px, ${dy}px)`;

    const nx = dx / this.maxTravel;
    const ny = -dy / this.maxTravel; // screen-down is world-negative

    const magnitude = Math.hypot(nx, ny);
    if (magnitude < DEAD_ZONE) {
      this.vector.x = 0;
      this.vector.y = 0;
      return;
    }

    // Rescale past the dead zone so the first responsive input starts at 0
    // rather than jumping straight to 0.15.
    const scaled = (magnitude - DEAD_ZONE) / (1 - DEAD_ZONE);
    const factor = scaled / magnitude;

    this.vector.x = nx * factor;
    this.vector.y = ny * factor;
  }

  _onEnd(event) {
    if (event.type === 'mouseup') {
      if (this.touchId !== 'mouse') return;
    } else {
      let released = false;
      for (const touch of event.changedTouches) {
        if (touch.identifier === this.touchId) {
          released = true;
          break;
        }
      }
      if (!released) return;
    }

    event.preventDefault();
    this.touchId = null;
    this.vector.x = 0;
    this.vector.y = 0;
    this.knob.style.transform = 'translate(0px, 0px)';
    this.root.classList.remove('active');
  }

  /** Magnitude of the current stick deflection, 0..1. */
  get strength() {
    return Math.hypot(this.vector.x, this.vector.y);
  }
}

/**
 * Camera look control for the area outside the joystick.
 *
 * One finger dragging anywhere on the stage orbits the camera. The rotation is
 * stored as an offset from the follow heading and is handed back through
 * `consumeRecenter()` so the game loop can blend it away smoothly once the
 * player walks again, rather than snapping.
 *
 * Two fingers pinch to zoom. `distance` is clamped to [min, max] and then
 * eased toward its target so the zoom never feels steppy.
 */
export class CameraLook {
  constructor(stage, { min = 4.5, max = 17, sensitivity = 0.006 } = {}) {
    this.stage = stage;
    this.min = min;
    this.max = max;
    this.sensitivity = sensitivity;

    this.yawOffset = 0;      // radians, relative to the follow heading
    this.tiltOffset = 0;     // radians, added to the base pitch
    this.distance = 11;      // current, eased
    this.targetDistance = 11;

    this._pointers = new Map();
    this._pinchStart = 0;
    this._pinchBaseDistance = 11;
    this._lastX = 0;
    this._lastY = 0;
    this._activeId = null;
    this._pinching = false;

    this._onDown = this._onDown.bind(this);
    this._onMove = this._onMove.bind(this);
    this._onUp = this._onUp.bind(this);
    this._onWheel = this._onWheel.bind(this);

    const opts = { passive: false };
    stage.addEventListener('pointerdown', this._onDown, opts);
    stage.addEventListener('pointermove', this._onMove, opts);
    stage.addEventListener('pointerup', this._onUp, opts);
    stage.addEventListener('pointercancel', this._onUp, opts);
    stage.addEventListener('wheel', this._onWheel, opts);
    // Safari pinch-to-zoom the page instead of the canvas without this.
    stage.addEventListener('gesturestart', (e) => e.preventDefault(), opts);
  }

  _clampDistance(value) {
    return clamp(value, this.min, this.max);
  }

  _onDown(event) {
    // The joystick handles its own touches; ignore anything that started on it.
    if (event.target.closest && event.target.closest('#joystick')) return;

    this._pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
    event.preventDefault();

    if (this._pointers.size === 1) {
      this._activeId = event.pointerId;
      this._lastX = event.clientX;
      this._lastY = event.clientY;
      this._pinching = false;
    } else if (this._pointers.size === 2) {
      this._beginPinch();
    }
  }

  _beginPinch() {
    const [a, b] = [...this._pointers.values()];
    this._pinchStart = Math.hypot(a.x - b.x, a.y - b.y) || 1;
    this._pinchBaseDistance = this.targetDistance;
    this._pinching = true;
    this._activeId = null;
  }

  _onMove(event) {
    if (!this._pointers.has(event.pointerId)) return;
    event.preventDefault();
    this._pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });

    if (this._pointers.size >= 2) {
      if (!this._pinching) this._beginPinch();
      const [a, b] = [...this._pointers.values()];
      const span = Math.hypot(a.x - b.x, a.y - b.y) || 1;
      // Fingers apart (span grows) => pull the camera in.
      const ratio = this._pinchStart / span;
      this.targetDistance = this._clampDistance(this._pinchBaseDistance * ratio);
      return;
    }

    if (event.pointerId !== this._activeId) return;

    const dx = event.clientX - this._lastX;
    const dy = event.clientY - this._lastY;
    this._lastX = event.clientX;
    this._lastY = event.clientY;

    // Horizontal drag orbits; a little vertical tilt is added on top so the
    // camera can be raised without a separate control.
    this.yawOffset -= dx * this.sensitivity;
    this.tiltOffset = clamp(this.tiltOffset + dy * this.sensitivity * 0.35, -0.22, 0.34);
  }

  _onUp(event) {
    if (!this._pointers.has(event.pointerId)) return;
    this._pointers.delete(event.pointerId);
    if (this._pointers.size < 2) this._pinching = false;
    if (event.pointerId === this._activeId) {
      this._activeId = null;
      // A second finger lifted mid-pinch: re-anchor so the view does not jump.
      const only = [...this._pointers.values()][0];
      if (only) {
        this._activeId = null;
        this._lastX = only.x;
        this._lastY = only.y;
      }
    }
  }

  _onWheel(event) {
    event.preventDefault();
    const step = Math.sign(event.deltaY) * 0.6;
    this.targetDistance = this._clampDistance(this.targetDistance + step);
  }

  /**
   * Called each frame. `walking` enables the smooth recentre; returns the
   * eased distance so the camera can use it directly.
   */
  update(dt, walking, damping) {
    if (walking) {
      // Ease the manual offset back to the follow heading rather than cutting,
      // so letting go of the drag does not snap the view.
      this.yawOffset *= Math.exp(-damping * dt);
      if (Math.abs(this.yawOffset) < 1e-4) this.yawOffset = 0;
      this.tiltOffset = clamp(this.tiltOffset * Math.exp(-damping * dt), -0.22, 0.34);
    }
    this.distance += (this.targetDistance - this.distance) * (1 - Math.exp(-12 * dt));
    return this.distance;
  }

  dispose() {
    this.stage.removeEventListener('pointerdown', this._onDown);
    this.stage.removeEventListener('pointermove', this._onMove);
    this.stage.removeEventListener('pointerup', this._onUp);
    this.stage.removeEventListener('pointercancel', this._onUp);
    this.stage.removeEventListener('wheel', this._onWheel);
  }
}
