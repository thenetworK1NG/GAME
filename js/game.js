import * as THREE from 'three';
import { Player } from './player.js';
import { Joystick, CameraLook } from './joystick.js';

const MAP_SIZE = 60;          // playable field is MAP_SIZE x MAP_SIZE
const BOUNDARY_MARGIN = 2;    // keeps the plushie a little inside the edge
const PLAYER_RADIUS = 0.55;

const CAMERA_PITCH = THREE.MathUtils.degToRad(52);
const CAMERA_DISTANCE = 11;
const CAMERA_LOOK_AHEAD = 1.6;
const CAMERA_HEIGHT = 3.2;
const CAMERA_FOLLOW_RATE = 5;

// Zoom is clamped so the camera cannot clip into the plushie or fly off.
const ZOOM_MIN = 4.5;
const ZOOM_MAX = 17;

/** Mulberry32: small, fast, seedable PRNG so the map is identical each load. */
function makeRandom(seed) {
  let a = seed >>> 0;
  return function random() {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const clampToMap = (v) =>
  THREE.MathUtils.clamp(v, -MAP_SIZE / 2 + BOUNDARY_MARGIN, MAP_SIZE / 2 - BOUNDARY_MARGIN);

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
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  stage.appendChild(renderer.domElement);

  // ---------- Scene and camera ----------

  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x9ed2f0);
  scene.fog = new THREE.Fog(0x9ed2f0, 45, 105);

  const camera = new THREE.PerspectiveCamera(58, 1, 0.1, 300);
  camera.position.set(0, CAMERA_HEIGHT, CAMERA_DISTANCE);

  // ---------- Lighting ----------

  const hemi = new THREE.HemisphereLight(0xffffff, 0x6a8f5a, 0.75);
  scene.add(hemi);

  const sun = new THREE.DirectionalLight(0xfff2d8, 2.1);
  sun.position.set(18, 28, 12);
  sun.castShadow = true;
  sun.shadow.mapSize.set(2048, 2048);
  sun.shadow.camera.near = 1;
  sun.shadow.camera.far = 90;
  const shadowSpan = MAP_SIZE * 0.62;
  sun.shadow.camera.left = -shadowSpan;
  sun.shadow.camera.right = shadowSpan;
  sun.shadow.camera.top = shadowSpan;
  sun.shadow.camera.bottom = -shadowSpan;
  sun.shadow.bias = -0.0006;
  sun.shadow.normalBias = 0.035;
  scene.add(sun);
  scene.add(sun.target);

  // ---------- Ground and path ----------

  const groundGeo = new THREE.PlaneGeometry(MAP_SIZE, MAP_SIZE, 1, 1);
  const groundMat = new THREE.MeshStandardMaterial({
    color: 0x6aa64f,
    roughness: 1,
    metalness: 0,
  });
  const ground = new THREE.Mesh(groundGeo, groundMat);
  ground.rotation.x = -Math.PI / 2;
  ground.receiveShadow = true;
  scene.add(ground);

  // Dirt path tiles laid along two crossing lanes, plus a border of edge
  // tiles so the walkable area reads as a field rather than an infinite plane.
  const pathMat = new THREE.MeshStandardMaterial({
    color: 0xb99a6b,
    roughness: 1,
    metalness: 0,
  });
  const tileSize = 3;
  const pathGeo = new THREE.PlaneGeometry(tileSize, tileSize);
  const pathTiles = [];

  for (let x = -MAP_SIZE / 2 + tileSize / 2; x < MAP_SIZE / 2; x += tileSize) {
    for (let z = -MAP_SIZE / 2 + tileSize / 2; z < MAP_SIZE / 2; z += tileSize) {
      // A horizontal lane, a vertical lane, and a stitched border.
      const onHorizontal = Math.abs(z) < tileSize * 0.75;
      const onVertical = Math.abs(x) < tileSize * 0.75;
      const onBorder =
        Math.abs(x) > MAP_SIZE / 2 - tileSize * 1.25 ||
        Math.abs(z) > MAP_SIZE / 2 - tileSize * 1.25;
      if (onHorizontal || onVertical || onBorder) {
        pathTiles.push([x, z]);
      }
    }
  }

  const paths = new THREE.InstancedMesh(pathGeo, pathMat, pathTiles.length);
  paths.receiveShadow = true;
  const matrix = new THREE.Matrix4();
  const quaternion = new THREE.Quaternion().setFromEuler(
    new THREE.Euler(-Math.PI / 2, 0, 0)
  );
  const one = new THREE.Vector3(1, 1, 1);
  pathTiles.forEach(([x, z], i) => {
    matrix.compose(new THREE.Vector3(x, 0.01, z), quaternion, one);
    paths.setMatrixAt(i, matrix);
  });
  paths.instanceMatrix.needsUpdate = true;
  scene.add(paths);

  // ---------- Scenery ----------

  const random = makeRandom(20260901);

  const trunkGeo = new THREE.CylinderGeometry(0.28, 0.38, 1.5, 7);
  const leafGeo = new THREE.ConeGeometry(1.5, 3.4, 8);
  const trunkMat = new THREE.MeshStandardMaterial({ color: 0x6b4a2f, roughness: 1 });
  const leafMat = new THREE.MeshStandardMaterial({ color: 0x3f7a35, roughness: 0.95 });

  function makeTree(scale) {
    const tree = new THREE.Group();
    const trunk = new THREE.Mesh(trunkGeo, trunkMat);
    trunk.position.y = 0.75;
    trunk.castShadow = true;
    trunk.receiveShadow = true;
    const leaves = new THREE.Mesh(leafGeo, leafMat);
    leaves.position.y = 1.5 + 1.7;
    leaves.castShadow = true;
    tree.add(trunk, leaves);
    tree.scale.setScalar(scale);
    return tree;
  }

  function makeRock(scale) {
    const rock = new THREE.Mesh(
      new THREE.DodecahedronGeometry(0.55, 0),
      new THREE.MeshStandardMaterial({ color: 0x8d8b86, roughness: 0.95, flatShading: true })
    );
    rock.position.y = 0.34 * scale;
    rock.rotation.set(random() * 3, random() * 3, random() * 3);
    rock.scale.set(scale, scale * 0.8, scale);
    rock.castShadow = true;
    rock.receiveShadow = true;
    return rock;
  }

  function makeBush(scale) {
    const bush = new THREE.Mesh(
      new THREE.IcosahedronGeometry(0.72, 0),
      new THREE.MeshStandardMaterial({ color: 0x4f9440, roughness: 1, flatShading: true })
    );
    bush.position.y = 0.5 * scale;
    bush.scale.set(scale, scale * 0.8, scale);
    bush.rotation.y = random() * Math.PI;
    bush.castShadow = true;
    bush.receiveShadow = true;
    return bush;
  }

  // Keep props off the crossing lanes and away from the spawn point.
  function onPath(x, z) {
    return Math.abs(x) < 4.5 || Math.abs(z) < 4.5;
  }

  const scenery = new THREE.Group();
  scene.add(scenery);

  function scatter(factory, count, minScale, maxScale, clearance) {
    let placed = 0;
    let attempts = 0;
    const limit = MAP_SIZE / 2 - 1.5;
    while (placed < count && attempts < count * 60) {
      attempts++;
      const x = (random() * 2 - 1) * limit;
      const z = (random() * 2 - 1) * limit;
      if (onPath(x, z)) continue;
      if (Math.hypot(x, z) < clearance) continue;
      const prop = factory(THREE.MathUtils.lerp(minScale, maxScale, random()));
      prop.position.set(x, 0, z);
      prop.rotation.y = random() * Math.PI * 2;
      scenery.add(prop);
      placed++;
    }
    return placed;
  }

  const trees = scatter(makeTree, 30, 0.85, 1.35, 5);
  const rocks = scatter(makeRock, 16, 0.6, 1.5, 5);
  const bushes = scatter(makeBush, 22, 0.7, 1.2, 4);

  // ---------- Player ----------

  const joystick = new Joystick();
  const look = new CameraLook(stage, { min: ZOOM_MIN, max: ZOOM_MAX });
  look.distance = CAMERA_DISTANCE;
  look.targetDistance = CAMERA_DISTANCE;
  const player = new Player();
  scene.add(player.group);
  await player.ready;

  document.getElementById('loading').classList.add('hidden');

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

  const clock = new THREE.Clock();
  const stickVector = new THREE.Vector2();
  const cameraTarget = new THREE.Vector3();
  const cameraDesired = new THREE.Vector3();

  // Camera orbits around a yaw that trails the player's heading, so the
  // plushie always faces up-screen while walking.
  let cameraYaw = 0;
  let cameraFocus = new THREE.Vector3();

  function tick() {
    requestAnimationFrame(tick);

    const dt = Math.min(clock.getDelta(), 0.05);

    stickVector.set(joystick.vector.x, joystick.vector.y);
    const walking = stickVector.length() > 0.01;

    // Drag-to-look contributes an offset on top of the follow yaw, and eases
    // back to zero as soon as the player walks. The offset is resolved BEFORE
    // movement so the stick stays camera-relative to what is on screen.
    const zoomDistance = look.update(dt, walking, 3.2);
    const pitch = THREE.MathUtils.clamp(
      CAMERA_PITCH + (look.tiltOffset || 0),
      THREE.MathUtils.degToRad(28),
      THREE.MathUtils.degToRad(76)
    );

    // The yaw the stick is measured against, including the manual look offset.
    const effectiveYaw = cameraYaw + look.yawOffset;

    // Rotate the screen-space stick into world space here so the camera-follow
    // gate can see which way the player is actually travelling.
    const fCos = Math.cos(effectiveYaw);
    const fSin = Math.sin(effectiveYaw);
    const travelX = stickVector.x * -fCos + stickVector.y * fSin;
    const travelZ = stickVector.x * fSin + stickVector.y * fCos;
    // Positive = heading away from the camera, negative = toward it.
    const awayFromCamera = travelX * fSin + travelZ * fCos;

    // Ease the camera yaw toward the player's heading.
    //
    // Only chase the heading when the stick is held essentially straight ahead.
    // Input is camera-relative, so rotating the camera also rotates the basis the
    // next frame's input is measured against. Any lateral stick component
    // therefore feeds itself: the player turns, the camera follows, the input
    // basis turns with it, and the camera spins without bound. Measured on a
    // simulation of this loop, a held back-pull spun the camera ~2550deg in 6s,
    // a held strafe ~220deg/s, and a held forward-diagonal made the player orbit
    // in place. With the stick straight ahead the travel direction already
    // equals the camera forward, so the chase is a self-cancelling no-op and is
    // safe to run. Releasing the stick, or pushing forward again, is what pulls
    // the view back behind the player.
    const chaseWeight = stickVector.y > 0.9 && Math.abs(stickVector.x) < 0.3 ? 1 : 0;
    if (chaseWeight > 0) {
      let yawDelta = player.heading - cameraYaw;
      while (yawDelta > Math.PI) yawDelta -= Math.PI * 2;
      while (yawDelta < -Math.PI) yawDelta += Math.PI * 2;
      cameraYaw += yawDelta * Player.damp(CAMERA_FOLLOW_RATE * 0.5, dt) * chaseWeight;
    }

    player.update(dt, stickVector, effectiveYaw);

    // Soft-clamp inside the field edges.
    player.position.x = clampToMap(player.position.x);
    player.position.z = clampToMap(player.position.z);
    player.group.position.copy(player.position);

    // Look slightly ahead of the player so there is room to see where they
    // are heading.
    cameraFocus.x = player.position.x + Math.sin(player.heading) * CAMERA_LOOK_AHEAD;
    cameraFocus.z = player.position.z + Math.cos(player.heading) * CAMERA_LOOK_AHEAD;
    cameraFocus.y = CAMERA_HEIGHT * 0.55;

    const horizontal = Math.cos(pitch) * zoomDistance;
    cameraDesired.set(
      cameraFocus.x - Math.sin(effectiveYaw) * horizontal,
      cameraFocus.y + Math.sin(pitch) * zoomDistance,
      cameraFocus.z - Math.cos(effectiveYaw) * horizontal
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
  window.game = { scene, camera, renderer, player, joystick, look, trees, rocks, bushes, MAP_SIZE };
}

main().catch(fail);

window.addEventListener('error', (e) => fail(e.error || e.message));
window.addEventListener('unhandledrejection', (e) => fail(e.reason));
