import * as THREE from 'three';
import { Player } from './player.js';
import { Joystick, CameraLook } from './joystick.js';
import { GameSounds } from './sound.js';
import { createPortal } from './portal.js';
import { createHouseWorld } from './house-world.js';
import { createFarmWorld } from './farm/index.js';

// Camera framing. These belong to the shell, not to a world: there is one
// camera, shared by every world, and a world only differs by the optional
// `rig` overrides it declares (the farm sits higher to look down on the plots).
const CAMERA_PITCH = THREE.MathUtils.degToRad(52);
const CAMERA_DISTANCE = 11;
const CAMERA_LOOK_AHEAD = 1.6;
const CAMERA_HEIGHT = 3.2;
const CAMERA_FOLLOW_RATE = 5;

// Tilt is clamped so the view cannot flip over or dive under the floor.
const PITCH_MIN = THREE.MathUtils.degToRad(28);
const PITCH_MAX = THREE.MathUtils.degToRad(76);

// Zoom is clamped so the camera cannot clip into the plushie or fly off.
const ZOOM_MIN = 4.5;
const ZOOM_MAX = 17;

const CAMERA_RIG = {
  pitch: CAMERA_PITCH,
  height: CAMERA_HEIGHT,
  lookAhead: CAMERA_LOOK_AHEAD,
  followRate: CAMERA_FOLLOW_RATE,
};

/**
 * The shell: renderer, one camera, one player, one set of input devices, and
 * whichever world is currently active. Everything that is specific to the
 * house lives in ./house-world.js, and everything specific to the farm lives
 * in ./farm/. A world is:
 *
 *   scene            THREE.Scene to render
 *   spawn            {x, z, heading} where the plushie appears on entry
 *   update(dt)       per-frame world work
 *   useAction()      the action button
 *   rotate()         the rotate button
 *   enter()/exit()   optional world switches
 *   rig              optional camera framing overrides
 */
function fail(err) {
  const panel = document.getElementById('error');
  const text = document.getElementById('error-text');
  const loading = document.getElementById('loading');
  if (loading) loading.classList.add('hidden');
  if (panel) panel.style.display = 'flex';
  if (text) {
    text.textContent = (err && (err.stack || err.message)) || String(err);
  }
  console.error(err);
}

async function main() {
  const stage = document.getElementById('stage');

  // ---------- Renderer ----------

  const renderer = new THREE.WebGLRenderer({
    antialias: true,
    powerPreference: 'high-performance',
  });
  // Cap device pixel ratio: a 3x phone panel triples the fill cost for no
  // visible gain at this camera distance.
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  renderer.shadowMap.enabled = true;
  // PCFSoftShadowMap was removed in 0.186 and silently falls back to this one with
  // a console warning, so name it directly.
  renderer.shadowMap.type = THREE.PCFShadowMap;
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  stage.appendChild(renderer.domElement);

  // ---------- Camera ----------

  // near/far are pulled in as tight as the scene allows: at the old 0.1/300 the
  // 3000:1 ratio thinned out depth precision badly enough for near-coplanar
  // floor surfaces to shimmer. Nothing comes closer than roughly 1.5 units, and
  // the far corner of the house from a fully zoomed-out camera is about 35.
  const camera = new THREE.PerspectiveCamera(58, 1, 0.3, 100);
  camera.position.set(0, CAMERA_HEIGHT, CAMERA_DISTANCE);

  const rig = { ...CAMERA_RIG };

  // ---------- Shared actors ----------

  const joystick = new Joystick();
  const look = new CameraLook(stage, {
    min: ZOOM_MIN,
    max: ZOOM_MAX,
    // While the farm holds a canvas press it owns the gesture - painting a
    // sweep of plots, or tapping a walk goal - so a dragging single finger must
    // not also orbit the camera and pull the aim off the field.
    suppressDrag: () => !!(active && active.holding),
  });
  look.distance = CAMERA_DISTANCE;
  look.targetDistance = CAMERA_DISTANCE;

  const player = new Player();
  await player.ready;

  const sounds = new GameSounds(camera, 'sound/pickup_place.mp3');

  const actionButton = document.getElementById('action');
  const rotateButton = document.getElementById('rotate');

  // ---------- Worlds ----------

  // Frozen while a sheet is open and for the whole of a world swap, so nothing
  // walks anywhere while the player is choosing where to go.
  let paused = false;

  // Built before the worlds because a door needs something to open, but its
  // callbacks only fire later, once `worlds` below actually exists.
  const portal = createPortal({
    onTravel: (id) => { if (worlds[id]) enterWorld(worlds[id]); },
    onPause: (value) => { paused = value; },
  });

  const houseWorld = createHouseWorld({
    camera, player, sounds, actionButton, rotateButton, portal,
  });
  const farmWorld = createFarmWorld({
    camera, player, sounds, actionButton, rotateButton, portal, renderer,
  });
  const worlds = { house: houseWorld, farm: farmWorld };
  let active = null;
  // Set whenever the active world changes, so the camera cuts to the new view
  // instead of lerping across the gap between two places.
  let snapCamera = false;

  function enterWorld(world) {
    if (world === active) return;
    active?.exit?.();
    active = world;
    Object.assign(rig, CAMERA_RIG, world.rig);
    // An overhead world opens zoomed to its framing distance.
    const overhead = world.rig && world.rig.overhead;
    if (overhead && overhead.distance) {
      look.distance = look.targetDistance = overhead.distance;
    }
    player.position.set(world.spawn.x, 0, world.spawn.z);
    if (world.spawn.heading !== undefined) player.heading = world.spawn.heading;
    world.enter?.();
    snapCamera = true;
  }

  enterWorld(houseWorld);

  document.getElementById('loading').classList.add('hidden');

  // ---------- Buttons ----------
  //
  // pointerdown rather than click for the press itself: no 300ms tap delay,
  // and it feels immediate on touch. preventDefault suppresses the
  // compatibility mouse events.
  //
  // A mouse press fires both pointerdown and click, so a guard is needed or the
  // handler runs twice. Touch has no click once pointerdown is defaulted, which
  // leaves the guard cleared for the keyboard path below.
  let handledByPointer = false;

  actionButton.addEventListener('pointerdown', (event) => {
    event.preventDefault();
    handledByPointer = true;
    if (paused) return;
    active.useAction?.();
  });
  actionButton.addEventListener('pointerup', (event) => event.preventDefault());
  actionButton.addEventListener('pointercancel', () => { handledByPointer = false; });

  // Keyboard parity for Enter/Space on the focused button.
  actionButton.addEventListener('click', (event) => {
    event.preventDefault();
    if (handledByPointer) {
      handledByPointer = false;
      return;
    }
    if (paused) return;
    active.useAction?.();
  });

  rotateButton.addEventListener('pointerdown', (event) => {
    event.preventDefault();
    if (paused) return;
    active.rotate?.();
  });

  // ---------- Resize ----------

  function resize() {
    const width = stage.clientWidth || window.innerWidth;
    const height = stage.clientHeight || window.innerHeight;
    camera.aspect = width / Math.max(1, height);
    camera.updateProjectionMatrix();
    renderer.setSize(width, height, false);
  }
  window.addEventListener('resize', resize);
  window.addEventListener('orientationchange', () => setTimeout(resize, 150));
  resize();

  // ---------- Loop ----------

  // Timer, not Clock: Clock is deprecated as of 0.186. Timer needs an explicit
  // update(timestamp) each frame, and connect() opts into the Page Visibility
  // API so a backgrounded tab does not resume with one enormous delta.
  const timer = new THREE.Timer();
  timer.connect(document);
  const stickVector = new THREE.Vector2();
  const cameraFocus = new THREE.Vector3();
  const cameraDesired = new THREE.Vector3();

  // The camera yaw is now entirely the player's own doing: the view stays exactly
  // where the drag left it. Both mechanisms that used to undo a manual rotation
  // are gone, because both were fighting what was asked for:
  //   - the follow chase pulled cameraYaw toward the character's heading, which
  //     silently absorbed the drag. This is the "view snaps back" behaviour.
  //   - the recentre decayed yawOffset back to zero on any walk.
  // With neither, the camera only moves when the player drags it, so the stick's
  // basis is stable. That also means the old spin hazard cannot occur: it only
  // existed because the camera used to rotate itself in response to input.
  let cameraYaw = 0;

  function tick() {
    requestAnimationFrame(tick);

    timer.update();
    // Clamped so a stalled frame cannot teleport the plushie through a wall.
    const dt = Math.min(timer.getDelta(), 0.05);

    // While paused the world and the camera are held exactly where they are.
    // The frame keeps rendering behind the sheet; it just stops advancing.
    if (!paused) {
      stickVector.set(joystick.vector.x, joystick.vector.y);

      // The offset persists rather than easing back: it is the player's view.
      const zoomDistance = look.update(dt);
      const overhead = rig.overhead;
      const pitch = THREE.MathUtils.clamp(
        rig.pitch + (look.tiltOffset || 0),
        PITCH_MIN,
        PITCH_MAX
      );

      // Overhead worlds anchor their yaw to the rig instead of the follow
      // heading, so tapping south still walks down-screen in any orientation.
      cameraYaw = overhead ? overhead.yaw + look.yawOffset : look.yawOffset;

      // The stick is measured against the rotated view, so pushing up always
      // moves up-screen in the orientation the player set. An active world may
      // replace the thumb stick with auto-steering toward a tapped goal.
      const move = active.stick ? active.stick(joystick.vector, cameraYaw) : stickVector;
      player.update(dt, move, cameraYaw);
      active.update(dt, cameraYaw);

      // ---------- Camera ----------

      if (overhead) {
        // A fixed frame over an anchor point: the whole field stays in view no
        // matter where the plushie wanders, and the player only moves the view
        // on purpose (drag to orbit, pinch to zoom).
        const oPitch = THREE.MathUtils.clamp(
          overhead.pitch + (look.tiltOffset || 0),
          PITCH_MIN,
          PITCH_MAX
        );
        const focal = { x: overhead.center[0], z: overhead.center[1] };
        const horizontal = Math.cos(oPitch) * zoomDistance;
        cameraFocus.set(focal.x, 0.6, focal.z);
        cameraDesired.set(
          focal.x - Math.sin(cameraYaw) * horizontal,
          Math.sin(oPitch) * zoomDistance,
          focal.z - Math.cos(cameraYaw) * horizontal
        );
      } else {
        // Look slightly ahead of the player so there is room to see where they
        // are heading.
        cameraFocus.x = player.position.x + Math.sin(player.heading) * rig.lookAhead;
        cameraFocus.z = player.position.z + Math.cos(player.heading) * rig.lookAhead;
        cameraFocus.y = rig.height * 0.55;

        const horizontal = Math.cos(pitch) * zoomDistance;
        cameraDesired.set(
          cameraFocus.x - Math.sin(cameraYaw) * horizontal,
          cameraFocus.y + Math.sin(pitch) * zoomDistance,
          cameraFocus.z - Math.cos(cameraYaw) * horizontal
        );
      }

      if (snapCamera) {
        camera.position.copy(cameraDesired);
        snapCamera = false;
      } else {
        camera.position.lerp(cameraDesired, Player.damp(rig.followRate, dt));
      }
      camera.lookAt(cameraFocus);
    }

    renderer.render(active.scene, camera);
  }

  tick();

  // Expose a little state for console tinkering.
  window.game = {
    renderer, camera, player, joystick, look, sounds, worlds, portal, enterWorld,
    get paused() { return paused; },
    get active() { return active; },
    get scene() { return active.scene; },
    get house() { return houseWorld; },
    get farm() { return farmWorld; },
    get furniture() { return houseWorld.furniture; },
    get carried() { return houseWorld.furniture.carried; },
    get target() { return houseWorld.furniture.target; },
  };
}

main().catch(fail);

window.addEventListener('error', (e) => fail(e.error || e.message));
window.addEventListener('unhandledrejection', (e) => fail(e.reason));
