import * as THREE from 'three';
import { Player } from './player.js';
import { Joystick, CameraLook } from './joystick.js';
import { buildHouse, resolveAgainstRects, PLAYER_RADIUS } from './house.js';
import { FurnitureSystem, registerDefaults } from './furniture.js';
import { GameSounds } from './sound.js';

const CAMERA_PITCH = THREE.MathUtils.degToRad(52);
const CAMERA_DISTANCE = 11;
const CAMERA_LOOK_AHEAD = 1.6;
const CAMERA_HEIGHT = 3.2;
const CAMERA_FOLLOW_RATE = 5;

// Zoom is clamped so the camera cannot clip into the plushie or fly off.
const ZOOM_MIN = 4.5;
const ZOOM_MAX = 17;

// Background, shared with index.html so the loading overlay does not flash a
// different colour before the canvas exists.
const BACKDROP = 0x2f3742;

// Where the four pieces and the sign start out. All on grid cells, all clear
// of the doorway gaps so nothing spawns blocking a door.
const START_LAYOUT = [
  // Living room, back against the east exterior wall.
  { id: 'sofa', x: 10.0, z: -6.0, rotation: -Math.PI / 2 },
  { id: 'table', x: 6.5, z: -5.0, rotation: 0 },
  // Bedroom, headboard to the west exterior wall.
  { id: 'bed', x: -10.0, z: -6.0, rotation: Math.PI / 2 },
  // Kitchen, free-standing.
  { id: 'chair', x: 9.0, z: 5.0, rotation: 0 },
  { id: 'sign', x: 3.0, z: -2.0, rotation: 0 },
];

const SPAWN = { x: 6.0, z: -1.0 };

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

  // ---------- Scene and camera ----------

  const scene = new THREE.Scene();
  scene.background = new THREE.Color(BACKDROP);
  // No fog: it was tuned for an open field reaching 60 units, and inside a 24
  // unit house the near plane is never reached, so it did nothing but tint the
  // far walls at the zoom limit.

  // near/far are pulled in as tight as the scene allows: at the old 0.1/300 the
  // 3000:1 ratio thinned out depth precision badly enough for near-coplanar
  // floor surfaces to shimmer. Nothing comes closer than roughly 1.5 units, and
  // the far corner of the house from a fully zoomed-out camera is about 35.
  const camera = new THREE.PerspectiveCamera(58, 1, 0.3, 100);
  camera.position.set(0, CAMERA_HEIGHT, CAMERA_DISTANCE);

  // ---------- Lighting ----------

  // Interiors need more ambient fill than a field does, or the wall the player
  // is standing next to goes black as soon as the sun is behind it.
  const hemi = new THREE.HemisphereLight(0xfff6ea, 0x6a6a62, 1.05);
  scene.add(hemi);

  // The directional light stays the "window light". Tightened around the house
  // so the 2048 shadow map spends its resolution on rooms rather than grass.
  const sun = new THREE.DirectionalLight(0xfff2d8, 2.0);
  sun.position.set(18, 28, 12);
  sun.castShadow = true;
  sun.shadow.mapSize.set(2048, 2048);
  sun.shadow.camera.near = 1;
  sun.shadow.camera.far = 90;
  const shadowSpan = 15;
  sun.shadow.camera.left = -shadowSpan;
  sun.shadow.camera.right = shadowSpan;
  sun.shadow.camera.top = shadowSpan;
  sun.shadow.camera.bottom = -shadowSpan;
  sun.shadow.bias = -0.0006;
  sun.shadow.normalBias = 0.035;
  scene.add(sun);
  scene.add(sun.target);

  // ---------- House ----------

  const house = buildHouse(scene);

  registerDefaults();
  const furniture = new FurnitureSystem({
    scene,
    walls: house.walls,
    bounds: house.bounds,
    headers: house.headers,
  });
  for (const entry of START_LAYOUT) furniture.place(entry.id, entry.x, entry.z, entry.rotation);

  // ---------- Sound ----------
  // Wired through the furniture event hook, so the audio module stays unaware
  // of the game and this stays unaware of how a cue is voiced.
  const sounds = new GameSounds(camera, 'sound/pickup_place.mp3');
  furniture.onEvent = (cue) => sounds.play(cue);

  // The print starts on the east wall of the living room, a little past the
  // sofa. Placed via the same wall maths the carry path uses so it lands flush
  // against the plaster rather than guessed at.
  furniture.placeMounted('art', 11.7, -2);

  // ---------- Player ----------

  const joystick = new Joystick();
  const look = new CameraLook(stage, { min: ZOOM_MIN, max: ZOOM_MAX });
  look.distance = CAMERA_DISTANCE;
  look.targetDistance = CAMERA_DISTANCE;
  const player = new Player();
  player.position.set(SPAWN.x, 0, SPAWN.z);
  scene.add(player.group);
  await player.ready;

  document.getElementById('loading').classList.add('hidden');

  // ---------- Buttons ----------

  // pointerdown rather than click for the press itself: no 300ms tap delay,
  // and it feels immediate on touch. preventDefault suppresses the
  // compatibility mouse events.
  //
  // A mouse press fires both pointerdown and click, so a guard is needed or the
  // handler runs twice. Touch has no click once pointerdown is defaulted, which
  // leaves the guard cleared for the keyboard path below.
  const actionButton = document.getElementById('action');
  const rotateButton = document.getElementById('rotate');
  let handledByPointer = false;

  /** One verb: place the carried piece, or use whatever is in range. */
  function useAction() {
    if (furniture.carried) furniture.drop();
    else if (furniture.target) furniture.target.use();
  }

  actionButton.addEventListener('pointerdown', (event) => {
    event.preventDefault();
    handledByPointer = true;
    useAction();
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
    useAction();
  });

  rotateButton.addEventListener('pointerdown', (event) => {
    event.preventDefault();
    furniture.rotate();
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
  const scratch = { x: 0, z: 0 };
  const solidRects = [];

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

    stickVector.set(joystick.vector.x, joystick.vector.y);

    // The offset persists rather than easing back: it is the player's view.
    const zoomDistance = look.update(dt);
    const pitch = THREE.MathUtils.clamp(
      CAMERA_PITCH + (look.tiltOffset || 0),
      THREE.MathUtils.degToRad(28),
      THREE.MathUtils.degToRad(76)
    );

    // The stick is measured against the rotated view, so pushing up always
    // moves up-screen in the orientation the player set.
    cameraYaw = look.yawOffset;

    player.update(dt, stickVector, cameraYaw);

    // ---------- Collision ----------
    //
    // Walls and solid furniture are both plain XZ rects, so this is
    // circle-vs-AABB and nothing more. Solved after movement, and run in
    // alternating passes because pushing clear of a wall can shove the plushie
    // into the furniture beside it, which is exactly what happens in a doorway.
    scratch.x = player.position.x;
    scratch.z = player.position.z;

    resolveAgainstRects(scratch, PLAYER_RADIUS, house.colliders, 2);

    // Rebuilt in place rather than reallocated: this runs every frame, and a
    // mobile target makes per-frame garbage worth avoiding.
    let solidCount = 0;
    for (const inst of furniture.instances) {
      // A carried piece rides along above the floor, so it must not shove the
      // player while it is being carried.
      if (inst.solid && !inst.carried) solidRects[solidCount++] = inst.rect;
    }
    solidRects.length = solidCount;
    resolveAgainstRects(scratch, PLAYER_RADIUS, solidRects, 2);
    resolveAgainstRects(scratch, PLAYER_RADIUS, house.colliders, 2);

    player.position.x = scratch.x;
    player.position.z = scratch.z;
    player.group.position.copy(player.position);

    // ---------- Interaction ----------

    furniture.update(dt, player);
    actionButton.disabled = !furniture.target && !furniture.carried;
    actionButton.classList.toggle('carrying', !!furniture.carried);
    rotateButton.classList.toggle('visible', !!furniture.carried);

    // ---------- Walls ----------

    house.updateWalls(dt, camera, player.position);

    // ---------- Camera ----------

    // Look slightly ahead of the player so there is room to see where they
    // are heading.
    cameraFocus.x = player.position.x + Math.sin(player.heading) * CAMERA_LOOK_AHEAD;
    cameraFocus.z = player.position.z + Math.cos(player.heading) * CAMERA_LOOK_AHEAD;
    cameraFocus.y = CAMERA_HEIGHT * 0.55;

    const horizontal = Math.cos(pitch) * zoomDistance;
    cameraDesired.set(
      cameraFocus.x - Math.sin(cameraYaw) * horizontal,
      cameraFocus.y + Math.sin(pitch) * zoomDistance,
      cameraFocus.z - Math.cos(cameraYaw) * horizontal
    );

    camera.position.lerp(cameraDesired, Player.damp(CAMERA_FOLLOW_RATE, dt));
    camera.lookAt(cameraFocus);

    // Keep the shadow frustum centred on the player.
    sun.position.set(player.position.x + 18, 28, player.position.z + 12);
    sun.target.position.set(player.position.x, 0, player.position.z);
    sun.target.updateMatrixWorld();

    renderer.render(scene, camera);
  }

  tick();

  // Expose a little state for console tinkering.
  window.game = {
    scene, camera, renderer, player, joystick, look, house, furniture,
    get carried() { return furniture.carried; },
    get target() { return furniture.target; },
  };
}

main().catch(fail);

window.addEventListener('error', (e) => fail(e.error || e.message));
window.addEventListener('unhandledrejection', (e) => fail(e.reason));