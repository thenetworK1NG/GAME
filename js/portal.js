import * as THREE from 'three';
import { registerObject, GRID } from './furniture.js';
import {
  FRONT_DOOR, DOOR_W, WALL_T, WALL_H, HEADER_H,
} from './house.js';

/**
 * Doors, the destination sheet, and the fade between places.
 *
 * Two halves that deliberately do not know about each other: `placeDoor` hangs
 * a physical door in the house (it belongs to the house world, which owns the
 * furniture), while `createPortal` owns the DOM for choosing a destination and
 * the world switch itself (it belongs to the shell, which owns the worlds).
 * Both talk to a door through `onUse`, so either half can be replaced without
 * touching the other.
 */

// The opening the door stands in: full wall height minus the header above it.
const OPEN_H = WALL_H - HEADER_H;
const POST_W = 0.14;
const LEAF_GAP = 0.04;   // hairline where the two leaves meet
const LEAF_D = 0.09;

/**
 * Everywhere a door can take you. One row per place; adding a destination
 * later means adding a row here and registering a world under the same id in
 * game.js -- nothing else in this file changes.
 */
export const DESTINATIONS = [
  {
    id: 'house',
    title: 'Your House',
    blurb: 'The cutaway three-room house, furniture and all.',
    icon:
      '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" ' +
      'stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round">' +
      '<path d="M3.5 11 12 4l8.5 7" />' +
      '<path d="M5.5 10v10h13V10" />' +
      '<path d="M10 20v-5.5h4V20" /></svg>',
  },
  {
    id: 'farm',
    title: 'Meadow Farm',
    blurb: 'A floating island of soil, waiting to be worked.',
    icon:
      '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" ' +
      'stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round">' +
      '<path d="M12 21v-7" />' +
      '<path d="M12 14c0-3.3 2.7-6 6-6 0 3.3-2.7 6-6 6Z" />' +
      '<path d="M12 16c-3.3 0-6-2.4-6-5.6 3.3 0 6 2.4 6 5.6Z" /></svg>',
  },
];

/**
 * The front door itself: a paneled double leaf filling the gap cut in the north
 * wall, plus a doormat on the room side.
 *
 * Built from boxes on purpose. The house is soft-edged low-poly and this is
 * part of the house, so anything with a bevel or a hinge curve would read as
 * a different object sitting in a hole in the wall.
 */
function buildFrontDoor() {
  const group = new THREE.Group();

  const wood = new THREE.MeshStandardMaterial({
    color: 0x7a5230, roughness: 0.72, metalness: 0, transparent: true, opacity: 1,
  });
  const trim = new THREE.MeshStandardMaterial({
    color: 0x5b4128, roughness: 0.8, metalness: 0, transparent: true, opacity: 1,
  });
  const brass = new THREE.MeshStandardMaterial({
    color: 0xc9a24a, roughness: 0.35, metalness: 0.55, transparent: true, opacity: 1,
  });
  const mat = new THREE.MeshStandardMaterial({ color: 0x6c4a33, roughness: 1 });

  const halfW = DOOR_W / 2;
  const innerHalf = halfW - POST_W;

  // Jambs at each edge of the gap, standing slightly proud of the wall face.
  for (const side of [-1, 1]) {
    const post = new THREE.Mesh(
      new THREE.BoxGeometry(POST_W, OPEN_H, WALL_T + 0.08),
      trim
    );
    post.position.set(side * (halfW - POST_W / 2), OPEN_H / 2, 0);
    post.castShadow = true;
    post.receiveShadow = true;
    group.add(post);
  }

  // Two leaves meeting in the middle. Both faces get a raised panel, because
  // you see the door from outside as well as in.
  const leafW = (innerHalf * 2 - LEAF_GAP) / 2;
  const leafH = OPEN_H - 0.12;
  for (const side of [-1, 1]) {
    const cx = side * (LEAF_GAP / 2 + leafW / 2);
    const leaf = new THREE.Mesh(new THREE.BoxGeometry(leafW, leafH, LEAF_D), wood);
    leaf.position.set(cx, 0.06 + leafH / 2, 0);
    leaf.castShadow = true;
    leaf.receiveShadow = true;
    group.add(leaf);

    for (const face of [-1, 1]) {
      const panel = new THREE.Mesh(
        new THREE.BoxGeometry(leafW - 0.3, leafH - 0.5, 0.03),
        trim
      );
      panel.position.set(cx, leaf.position.y, face * (LEAF_D / 2 + 0.015));
      group.add(panel);
    }

    const knob = new THREE.Mesh(new THREE.SphereGeometry(0.07, 12, 10), brass);
    knob.position.set(side * (LEAF_GAP / 2 + 0.17), 1.05, LEAF_D / 2 + 0.05);
    group.add(knob);
    const stem = new THREE.Mesh(new THREE.CylinderGeometry(0.03, 0.03, 0.08, 8), brass);
    stem.rotation.x = Math.PI / 2;
    stem.position.set(knob.position.x, knob.position.y, LEAF_D / 2 + 0.01);
    group.add(stem);
  }

  // Doormat, room side. Deliberately not in the fade list: it lies flat on the
  // floor, never occludes anything, and should not dim with the door.
  const doormat = new THREE.Mesh(new THREE.BoxGeometry(1.7, 0.05, 0.9), mat);
  doormat.position.set(0, 0.03, WALL_T / 2 + 0.5);
  doormat.receiveShadow = true;
  doormat.userData.noFade = true;
  group.add(doormat);

  return group;
}

/**
 * Registers the front door and hangs it in the gap the house cut for it, then
 * hands its materials to the house's wall-fade pass so the door dims whenever
 * a wall in front of it does. Without that, the camera swinging outside would
 * show an unbroken wall with a solid door floating in the middle of it.
 */
export function placeDoor(furniture, house, portal) {
  registerObject({
    id: 'door',
    // Cells, not units: the footprint is measured in GRID steps like every
    // other object, so this lands exactly on the gap's 2.5 x 0.3 metres.
    footprint: [DOOR_W / GRID, WALL_T / GRID],
    solid: true,
    carryable: false,
    prompt: 'go',
    markerY: 2.7,
    build: buildFrontDoor,
    onUse: (inst, system) => {
      // Voiced through the same hook pickup and place use, so the sound module
      // still does not need to know what a door is.
      system.onEvent?.('door');
      portal.open('house');
    },
  });

  const inst = furniture.place('door', FRONT_DOOR.x, FRONT_DOOR.z, 0);

  house.addFading({
    group: inst.group,
    rect: inst.rect,
    axis: FRONT_DOOR.axis,
    cross: FRONT_DOOR.z,
    isHeader: false,
    materials: inst.group.children
      .filter((c) => c.isMesh && !c.userData.noFade)
      .map((c) => c.material),
    opacity: 1,
    occluding: false,
  });

  return inst;
}

const FADE_MS = 260;
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * The destination sheet and the fade that hides the swap behind it.
 *
 * `onTravel(id)` performs the actual world change; this only decides when.
 * `onPause` freezes the world while a choice is pending and for the whole trip,
 * so nothing walks off a cliff mid-fade.
 */
export function createPortal({ onTravel, onPause }) {
  const root = document.getElementById('destinations');
  const cards = document.getElementById('dest-cards');
  const closeBtn = document.getElementById('dest-close');
  const fade = document.getElementById('travel-fade');
  if (!root || !cards || !closeBtn || !fade) {
    throw new Error('portal: destination sheet missing from index.html');
  }

  let isOpen = false;
  let travelling = false;
  const buttons = new Map();

  for (const place of DESTINATIONS) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'dest-card';
    btn.innerHTML =
      `<span class="dest-icon" aria-hidden="true">${place.icon}</span>` +
      `<span class="dest-title">${place.title}</span>` +
      `<span class="dest-blurb">${place.blurb}</span>`;
    btn.addEventListener('click', () => travel(place.id));
    cards.appendChild(btn);
    buttons.set(place.id, btn);
  }

  function close() {
    if (!isOpen) return;
    isOpen = false;
    root.classList.remove('open');
    root.setAttribute('aria-hidden', 'true');
    onPause(false);
  }

  async function travel(id) {
    if (travelling) return;
    travelling = true;
    close();
    onPause(true);

    // Opaque before the swap, and the fade itself swallows taps so a second
    // press cannot fire a second trip.
    fade.classList.add('active');
    try {
      await wait(FADE_MS);
      onTravel(id);
      fade.classList.remove('active');
      await wait(FADE_MS);
    } finally {
      onPause(false);
      travelling = false;
    }
  }

  closeBtn.addEventListener('click', close);
  // Tapping the scrim behind the sheet dismisses it, the way the menu does.
  root.addEventListener('pointerdown', (event) => {
    if (event.target === root) close();
  });
  window.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && isOpen) close();
  });

  root.setAttribute('aria-hidden', 'true');

  return {
    /** Shows every destination except the one you are already standing in. */
    open(fromId) {
      if (isOpen || travelling) return;
      for (const [id, btn] of buttons) btn.hidden = id === fromId;
      isOpen = true;
      root.classList.add('open');
      root.setAttribute('aria-hidden', 'false');
      onPause(true);
    },
    close,
    travel,
    get isOpen() { return isOpen; },
    get travelling() { return travelling; },
  };
}
