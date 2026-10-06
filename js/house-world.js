import * as THREE from 'three';
import { buildHouse, resolveAgainstRects, PLAYER_RADIUS } from './house.js';
import { FurnitureSystem, registerDefaults } from './furniture.js';

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

/**
 * The house as a world: scene, lights, furniture and everything that only
 * makes sense indoors. The shell owns the renderer, the single camera, the
 * player and the input devices, and drives whatever `update()` this returns.
 *
 * Returned object, the contract the shell codes against:
 *   scene      THREE.Scene to render
 *   spawn      where the plushie appears on entry
 *   update(dt) per-frame world work: collision, interaction, wall fade, lights
 *   useAction()  the action button
 *   rotate()     the rotate button
 *   enter()/exit()  optional world switches
 */
export function createHouseWorld({ camera, player, sounds, actionButton, rotateButton }) {
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(BACKDROP);
  // No fog: it was tuned for an open field reaching 60 units, and inside a 24
  // unit house the near plane is never reached, so it did nothing but tint the
  // far walls at the zoom limit.

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

  // Wired through the furniture event hook, so the audio module stays unaware
  // of the game and this stays unaware of how a cue is voiced.
  furniture.onEvent = (cue) => sounds.play(cue);

  // The print starts on the east wall of the living room, a little past the
  // sofa. Placed via the same wall maths the carry path uses so it lands flush
  // against the plaster rather than guessed at.
  furniture.placeMounted('art', 11.7, -2);

  // ---------- Per-frame scratch ----------
  //
  // Rebuilt in place rather than reallocated: this runs every frame, and a
  // mobile target makes per-frame garbage worth avoiding.
  const scratch = { x: 0, z: 0 };
  const solidRects = [];

  function update(dt) {
    // ---------- Collision ----------
    //
    // Walls and solid furniture are both plain XZ rects, so this is
    // circle-vs-AABB and nothing more. Solved after movement, and run in
    // alternating passes because pushing clear of a wall can shove the plushie
    // into the furniture beside it, which is exactly what happens in a doorway.
    scratch.x = player.position.x;
    scratch.z = player.position.z;

    resolveAgainstRects(scratch, PLAYER_RADIUS, house.colliders, 2);

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

    // Keep the shadow frustum centred on the player.
    sun.position.set(player.position.x + 18, 28, player.position.z + 12);
    sun.target.position.set(player.position.x, 0, player.position.z);
    sun.target.updateMatrixWorld();
  }

  return {
    scene,
    spawn: SPAWN,
    house,
    furniture,
    update,
    enter() {
      player.group.position.copy(player.position);
      scene.add(player.group);
    },
    useAction() {
      if (furniture.carried) furniture.drop();
      else if (furniture.target) furniture.target.use();
    },
    rotate() {
      furniture.rotate();
    },
  };
}
