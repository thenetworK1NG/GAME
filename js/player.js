import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';

export const MODEL_URL = 'models/plushie.glb';

/**
 * Movement tuning.
 *
 * The exported walk clip advances the root by 1.379 units per 0.967s cycle,
 * i.e. a natural speed of ~1.43 u/s. To travel at WALK_SPEED the clip has to
 * play faster by the same factor, otherwise the feet slide against the
 * ground. WALK_SPEED / NATURAL_SPEED is the matching timeScale.
 */
const WALK_SPEED = 2.3;
const NATURAL_SPEED = 1.379 / 0.967;
const WALK_TIME_SCALE = WALK_SPEED / NATURAL_SPEED;

const CROSSFADE = 0.25; // seconds
const TURN_RATE = 10;   // radians/second of yaw slerp

/**
 * The mesh is authored facing +Z, and the camera sits on the -Z side looking
 * back at the player, so the plushie's front already points away from the
 * lens. No yaw correction is applied here; `heading` stays in the same +Z
 * convention as `atan2(worldX, worldZ)` below.
 */
const MODEL_YAW = 0;

export class Player {
  constructor() {
    this.group = new THREE.Group();
    this.position = new THREE.Vector3(0, 0, 0);
    this.heading = 0;
    this.speed = 0;

    this.mixer = null;
    this.actions = {};
    this.root = null;

    this._loading = this.load();
  }

  get ready() {
    return this._loading;
  }

  async load() {
    const loader = new GLTFLoader();
    const gltf = await loader.loadAsync(MODEL_URL);

    this.root = gltf.scene;

    // Traverse so every skinned mesh casts a shadow.
    this.root.traverse((child) => {
      if (child.isSkinnedMesh) {
        child.castShadow = true;
        child.receiveShadow = false;
        // glTF exports up to 4 bone influences; the mesh may still be flagged
        // as frustum-cullable against a stale bounds sphere.
        child.frustumCulled = false;
      }
    });

    // Apply the orientation fix on an inner node so `heading` on the outer
    // group stays independent of it.
    const pivot = new THREE.Group();
    pivot.rotation.y = MODEL_YAW;
    pivot.add(this.root);

    this.group.add(pivot);
    this.group.position.copy(this.position);

    const clips = gltf.animations;
    const idle = clips.find((c) => c.name.toLowerCase() === 'idle');
    const walk = clips.find((c) => c.name.toLowerCase() === 'walk');

    if (!idle || !walk) {
      throw new Error(
        'Expected "Idle" and "Walk" clips, got: ' +
          clips.map((c) => `"${c.name}"`).join(', ')
      );
    }

    this.mixer = new THREE.AnimationMixer(this.root);
    this.actions.idle = this.mixer.clipAction(idle);
    this.actions.walk = this.mixer.clipAction(walk);

    for (const action of [this.actions.idle, this.actions.walk]) {
      action.setLoop(THREE.LoopRepeat, Infinity);
      action.clampWhenFinished = false;
      action.play();
    }

    this.actions.walk.timeScale = WALK_TIME_SCALE;
    this.actions.walk.setEffectiveWeight(0);
    this.actions.idle.setEffectiveWeight(1);

    return this;
  }

  /**
   * @param {number} dt         seconds since last frame
   * @param {THREE.Vector2} move  desired direction, length 0..1 (screen space)
   * @param {number} cameraYaw   camera yaw, so input is camera-relative
   */
  update(dt, move, cameraYaw) {
    if (!this.mixer) return;

    const intent = Math.min(1, move.length());

    // Camera-relative: rotate the screen-space stick into world space.
    // The camera sits at focus - (sin yaw, cos yaw) * distance, so its ground
    // forward is f = (sin yaw, 0, cos yaw). Screen-right is r = f x up, which
    // for up = +Y gives (-cos yaw, 0, sin yaw) -- note the NEGATIVE cos term.
    // Decomposing the stick onto that basis:
    //   world = move.x * r + move.y * f
    const cos = Math.cos(cameraYaw);
    const sin = Math.sin(cameraYaw);
    const worldX = move.x * -cos + move.y * sin;
    const worldZ = move.x * sin + move.y * cos;

    this.speed = intent * WALK_SPEED;

    if (intent > 0.001) {
      const step = this.speed * dt;
      this.position.x += worldX * step;
      this.position.z += worldZ * step;

      // Turn toward the direction of travel, taking the short way round.
      const target = Math.atan2(worldX, worldZ);
      let delta = target - this.heading;
      while (delta > Math.PI) delta -= Math.PI * 2;
      while (delta < -Math.PI) delta += Math.PI * 2;

      const maxTurn = TURN_RATE * dt;
      this.heading += THREE.MathUtils.clamp(delta, -maxTurn, maxTurn);
    }

    this.group.position.copy(this.position);
    this.group.rotation.y = this.heading;

    // Crossfade between the two clips rather than a hard switch.
    const walkWeight = THREE.MathUtils.clamp(intent * 2.2, 0, 1);
    this.actions.walk.setEffectiveWeight(walkWeight);
    this.actions.idle.setEffectiveWeight(1 - walkWeight);

    // Freeze the idle pose weight at zero while walking so that when the
    // player stops, the idle clip resumes from a sane pose instead of
    // snapping to whatever frame it froze on.
    if (walkWeight > 0.5) {
      this.actions.idle.paused = true;
    } else {
      this.actions.idle.paused = false;
    }

    this.mixer.update(dt);
  }

  /** Frame-rate independent smoothing factor. */
  static damp(rate, dt) {
    return 1 - Math.exp(-rate * dt);
  }

  dispose() {
    if (this.mixer) this.mixer.stopAllAction();
    if (this.root) {
      this.root.traverse((child) => {
        if (child.geometry) child.geometry.dispose();
        const mats = Array.isArray(child.material)
          ? child.material
          : [child.material];
        for (const mat of mats) {
          if (!mat) continue;
          if (mat.map) mat.map.dispose();
          mat.dispose();
        }
      });
    }
  }
}
