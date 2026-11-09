/**
 * OminX Engine — FPS map kit: props, cover, objectives and outdoor scatter.
 *
 * Everything here is generated geometry, grouped into meshes so the level mesher can merge
 * them into a handful of draw calls. Every prop reports its collision hint (`collider`), so a
 * designer can drag a crate into the map and immediately have it block movement and bullets.
 * @module engine/geometry/Props
 */
import { Mesh } from './Mesh.js';
import { Vector3 } from '../math/Vector3.js';
import { Matrix4 } from '../math/Matrix4.js';
import { RNG } from '../math/Random.js';
import {
  createBox, createCylinder, createSphere, createCone, createCapsule, createTorus,
  createTube, createPlane, createIcosphere, createStairs, createWedge, createCoverBlock,
  createWallWithOpening, createExtrusion,
} from './Primitives.js';

/** Collider hints consumed by the physics/level-compile step. */
export const ColliderHint = {
  None: 'none',
  Box: 'box',
  Sphere: 'sphere',
  Capsule: 'capsule',
  Cylinder: 'cylinder',
  Mesh: 'mesh',
};

let _uid = 0;
function prop(name, mesh, opts = {}) {
  _uid++;
  return {
    id: `prop_${_uid}`,
    name,
    mesh,
    collider: opts.collider ?? ColliderHint.Box,
    static: opts.static !== false,
    material: opts.material ?? 'Default',
    blocksBullets: opts.blocksBullets !== false,
    blocksVision: opts.blocksVision !== false,
    tags: opts.tags ?? [],
    castShadow: opts.castShadow !== false,
    cover: opts.cover ?? 0,          // 0 = no cover, 1 = full body cover (bot AI uses this)
    destructible: opts.destructible ?? false,
    health: opts.health ?? 0,
    anchor: opts.anchor ?? 'bottom',
  };
}

// ---------------------------------------------------------------------------
// Cover & barriers (the bread and butter of FPS level design)
// ---------------------------------------------------------------------------
export function crate(size = 0.8, opts = {}) {
  const m = createBox(size, size, size, { uvScale: 1 / size });
  // corner reinforcements — reads as a wooden crate at a glance
  const t = size * 0.07;
  for (const sx of [-1, 1]) {
    for (const sz of [-1, 1]) {
      const post = createBox(t, size * 1.005, t);
      post.translate(sx * (size / 2 - t / 2), 0, sz * (size / 2 - t / 2));
      m.merge(post);
    }
  }
  for (const y of [-size / 2 + t / 2, size / 2 - t / 2]) {
    for (const sz of [-1, 1]) {
      const rail = createBox(size * 1.005, t, t);
      rail.translate(0, y, sz * (size / 2 - t / 2));
      m.merge(rail);
      const rail2 = createBox(t, t, size * 1.005);
      rail2.translate(sz * (size / 2 - t / 2), y, 0);
      m.merge(rail2);
    }
  }
  return prop('Crate', m, { material: 'Wood', cover: size > 1.0 ? 0.6 : 0.3, destructible: opts.destructible ?? false, health: 120 });
}

export function barrel(opts = {}) {
  const h = opts.height ?? 0.9;
  const r = opts.radius ?? 0.29;
  const m = createCylinder(r, r, h, 18, 1, false);
  for (const y of [-h * 0.3, 0, h * 0.3]) {
    const ring = createTube(r * 1.06, r * 1.02, 0.05, 18);
    ring.translate(0, y, 0);
    m.merge(ring);
  }
  const cap = createCylinder(r * 0.55, r * 0.55, 0.03, 10);
  cap.translate(r * 0.4, h / 2, 0);
  m.merge(cap);
  return prop(opts.explosive ? 'ExplosiveBarrel' : 'Barrel', m, {
    material: opts.explosive ? 'Hazard' : 'Metal',
    collider: ColliderHint.Cylinder,
    cover: 0.45,
    destructible: true,
    health: opts.explosive ? 60 : 100,
    tags: opts.explosive ? ['explosive'] : [],
    castShadow: true,
  });
}

export function sandbagWall(width = 3, height = 1.2, opts = {}) {
  const m = new Mesh({ name: 'SandbagWall' });
  const bagW = 0.5, bagH = 0.24, bagD = 0.34;
  const rows = Math.max(1, Math.round(height / bagH));
  const cols = Math.max(1, Math.round(width / bagW));
  const rng = new RNG(9001);
  for (let row = 0; row < rows; row++) {
    const offset = (row % 2) * bagW * 0.5;
    const y = -height / 2 + row * bagH + bagH / 2;
    for (let c = -1; c <= cols; c++) {
      const x = -width / 2 + c * bagW + offset;
      if (x > width / 2 + bagW * 0.4) continue;
      const bag = createBox(bagW * 0.98, bagH * 0.95, bagD, { uvScale: 1 });
      bag.scaleMesh(1, 1, 1 + rng.nextNumber(-0.08, 0.08));
      const mm = new Matrix4().makeRotationY(rng.nextNumber(-0.05, 0.05));
      mm.setPosition(x, y, rng.nextNumber(-0.02, 0.02));
      m.merge(bag, mm);
    }
  }
  return prop('SandbagWall', m, { material: 'Sandbag', cover: height >= 1.0 ? 0.75 : 0.4, destructible: false });
}

export function jerseyBarrier(length = 2.2, height = 0.95) {
  const hd = 0.3;
  const profile = [
    [-hd, 0], [hd, 0], [hd * 0.45, height * 0.62], [hd * 0.3, height], [-hd * 0.3, height], [-hd * 0.45, height * 0.62],
  ];
  const m = createExtrusion(profile.map(([x, y]) => [x, y]), length, { invertCaps: true });
  // The extrusion runs along Y; rotate so the profile is the cross-section and length runs along X.
  m.applyMatrix(new Matrix4().makeRotationZ(Math.PI / 2).premultiply(new Matrix4().makeRotationY(Math.PI / 2)));
  m.computeNormals(false);
  m.name = 'JerseyBarrier';
  return prop('JerseyBarrier', m, { material: 'Concrete', cover: 0.7 });
}

export function lowCover(width = 1.6, height = 0.75) {
  return prop('LowCover', createCoverBlock(width, height, 0.55, 0.08), { material: 'Concrete', cover: height > 1.0 ? 0.7 : 0.45 });
}

export function concreteWall(width = 4, height = 3, thickness = 0.25, opts = {}) {
  const m = opts.doorway ? createWallWithOpening({ width, height, thickness, openingWidth: opts.openingWidth ?? 1.1, openingHeight: opts.openingHeight ?? 2.2 })
    : createBox(width, height, thickness);
  return prop('ConcreteWall', m, { material: 'Concrete', cover: 1, blocksVision: !opts.window });
}

export function windowedWall(width = 4, height = 3, thickness = 0.25, opts = {}) {
  return prop('WindowedWall', createWallWithOpening({
    width, height, thickness,
    openingWidth: opts.openingWidth ?? 2.2,
    openingHeight: opts.openingHeight ?? 1.0,
    openingY: opts.sillHeight ?? 1.0,
  }), { material: 'Concrete', cover: 0.5, blocksVision: false, tags: ['window'] });
}

export function stairs(steps = 8, width = 2, stepHeight = 0.2, stepDepth = 0.28) {
  return prop('Stairs', createStairs(steps, width, stepHeight, stepDepth), { material: 'Concrete', collider: ColliderHint.Mesh, cover: 0.2 });
}

export function ramp(width = 2.4, height = 1.2, depth = 3) {
  const m = createWedge(width, height, depth, { uvScale: 1 });
  m.applyMatrix(new Matrix4().makeRotationY(0));
  m.translate(0, height / 2, 0);
  return prop('Ramp', m, { material: 'Metal', collider: ColliderHint.Mesh, cover: 0.2 });
}

// ---------------------------------------------------------------------------
// Buildings & structures
// ---------------------------------------------------------------------------
export function container(length = 6, height = 2.6, width = 2.4, opts = {}) {
  const m = new Mesh({ name: 'Container' });
  const t = 0.12;
  const shell = [
    [width, height, t, 0, 0, -length / 2 + t / 2],
    [width, height, t, 0, 0, length / 2 - t / 2],
    [t, height, length, -width / 2 + t / 2, 0, 0],
    [t, height, length, width / 2 - t / 2, 0, 0],
    [width, t, length, 0, height / 2 - t / 2, 0],
  ];
  if (!opts.openTop) shell.push([width, t, length, 0, -height / 2 + t / 2, 0]);
  if (opts.openFaces) {
    // door opening on one long side
    const doorW = 1.0, doorH = 2.0;
    const side = shell[2];
    side[0] = t; side[1] = height; side[2] = length;
    const left = createBox(t, height, (length - doorW) / 2);
    left.translate(-width / 2 + t / 2, 0, -(doorW + (length - doorW) / 2) / 2);
    const right = createBox(t, height, (length - doorW) / 2);
    right.translate(-width / 2 + t / 2, 0, (doorW + (length - doorW) / 2) / 2);
    const lintel = createBox(t, height - doorH, doorW);
    lintel.translate(-width / 2 + t / 2, doorH / 2 + (height - doorH) / 4, 0);
    m.merge(left); m.merge(right); m.merge(lintel);
    shell.splice(2, 1);
  }
  for (const [sx, sy, sz, x, y, z] of shell) {
    const b = createBox(sx, sy, sz, { uvScale: 0.5 });
    b.translate(x, y, z);
    m.merge(b);
  }
  // corrugation ribs
  const ribs = Math.floor(length / 0.45);
  for (let i = 0; i < ribs; i++) {
    const z = -length / 2 + (i + 0.5) * (length / ribs);
    for (const sx of [-1, 1]) {
      const rib = createBox(0.03, height * 0.94, 0.06);
      rib.translate(sx * (width / 2 - 0.01), 0, z);
      m.merge(rib);
    }
  }
  return prop('Container', m, { material: opts.hazard ? 'Hazard' : 'Metal', cover: 1, tags: ['structure'], destructible: false });
}

export function watchtower(height = 4.2, size = 2.6) {
  const m = new Mesh({ name: 'Watchtower' });
  const legR = 0.09;
  const half = size / 2 - legR;
  for (const sx of [-1, 1]) {
    for (const sz of [-1, 1]) {
      const leg = createBox(legR * 2, height, legR * 2, { uvScale: 1 });
      leg.translate(sx * half, height / 2, sz * half);
      m.merge(leg);
    }
  }
  // cross bracing
  for (let i = 0; i < 3; i++) {
    const y = height * (0.25 + i * 0.25);
    for (const sz of [-1, 1]) {
      const brace = createBox(size, 0.08, 0.08);
      brace.translate(0, y, sz * half);
      m.merge(brace);
      const brace2 = createBox(0.08, 0.08, size);
      brace2.translate(sz * half, y, 0);
      m.merge(brace2);
    }
  }
  // platform
  const platform = createBox(size + 0.4, 0.16, size + 0.4);
  platform.translate(0, height, 0);
  m.merge(platform);
  // railing
  const railH = 1.0;
  for (const [dx, dz, w, d] of [[0, half + 0.2, size + 0.4, 0.08], [0, -half - 0.2, size + 0.4, 0.08], [half + 0.2, 0, 0.08, size + 0.4], [-half - 0.2, 0, 0.08, size + 0.4]]) {
    const rail = createBox(w, railH, d);
    rail.translate(dx, height + 0.08 + railH / 2, dz);
    m.merge(rail);
  }
  // roof + posts
  for (const sx of [-1, 1]) for (const sz of [-1, 1]) {
    const post = createBox(0.1, 1.8, 0.1);
    post.translate(sx * half, height + 1.0, sz * half);
    m.merge(post);
  }
  const roof = createBox(size + 0.8, 0.12, size + 0.8);
  roof.translate(0, height + 1.95, 0);
  m.merge(roof);
  return prop('Watchtower', m, { material: 'Wood', cover: 1, static: true, tags: ['structure', 'vantage'] });
}

export function buildingBlock(width = 8, depth = 8, height = 3.2, opts = {}) {
  const m = new Mesh({ name: 'BuildingBlock' });
  const t = 0.25;
  const doorW = 1.2, doorH = 2.2;
  const wallRow = (w, h, d, x, y, z) => {
    const b = createBox(w, h, d, { uvScale: 0.5 });
    b.translate(x, y, z);
    m.merge(b);
  };
  // floor
  wallRow(width, t, depth, 0, -t / 2, 0);
  // roof
  if (!opts.openRoof) wallRow(width, t, depth, 0, height + t / 2, 0);
  else {
    wallRow(width, t, depth * 0.4, 0, height + t / 2, -depth * 0.3);
  }
  const hw = width / 2, hd = depth / 2;
  // back & front walls
  wallRow(width, height, t, 0, height / 2, -hd + t / 2);
  // front wall with a doorway split
  const segW = (width - doorW) / 2;
  wallRow(segW, height, t, -(doorW / 2 + segW / 2), height / 2, hd - t / 2);
  wallRow(segW, height, t, doorW / 2 + segW / 2, height / 2, hd - t / 2);
  wallRow(doorW, height - doorH, t, 0, doorH + (height - doorH) / 2, hd - t / 2);
  // side walls with windows
  for (const sx of [-1, 1]) {
    const windowZ = 1.6, sill = 1.0, winH = 0.9;
    const zFront = hd - windowZ, zBack = -hd + windowZ;
    wallRow(t, height, windowZ * 2 - 0.2, sx * (hw - t / 2), height / 2, 0);
    wallRow(t, sill, depth - 2 * windowZ, sx * (hw - t / 2), sill / 2, 0);
    wallRow(t, winH, depth - 2 * windowZ, sx * (hw - t / 2), sill + winH + (height - sill - winH) / 2 - (height - sill - winH) / 2 + (height - (sill + winH)) / 2, 0);
    wallRow(t, height - (sill + winH), depth - 2 * windowZ, sx * (hw - t / 2), sill + winH + (height - (sill + winH)) / 2, 0);
    void zFront; void zBack;
  }
  // interior pillar for cover, and a rooftop parapet
  const pillar = createBox(0.4, height - 0.4, 0.4);
  pillar.translate(opts.pillarX ?? 1.8, (height - 0.4) / 2, opts.pillarZ ?? -1.2);
  m.merge(pillar);
  if (!opts.openRoof) {
    for (const [x, z, w, d] of [[0, -hd + t / 2, width, t], [0, hd - t / 2, width, t], [-hw + t / 2, 0, t, depth], [hw - t / 2, 0, t, depth]]) {
      const par = createBox(w, 0.9, d);
      par.translate(x, height + t + 0.45, z);
      m.merge(par);
    }
  }
  return prop('BuildingBlock', m, { material: 'Concrete', cover: 1, tags: ['structure', 'interior'] });
}

export function fenceSection(length = 3, height = 1.8, opts = {}) {
  const m = new Mesh({ name: 'Fence' });
  const postR = 0.05;
  for (const x of [-length / 2, 0, length / 2]) {
    const post = createCylinder(postR, postR, height, 8);
    post.translate(x, height / 2, 0);
    m.merge(post);
  }
  // chain-link grid (cheap: two rail boxes + diagonal cross pattern every 0.25m)
  for (const [y, t] of [[height - 0.08, 0.06], [0.1, 0.05], [height * 0.5, 0.05]]) {
    const rail = createBox(length, t, 0.04);
    rail.translate(0, y, 0);
    m.merge(rail);
  }
  if (opts.solid) {
    const panel = createBox(length, height - 0.1, 0.04);
    panel.translate(0, height / 2, 0);
    m.merge(panel);
  } else {
    const cell = 0.28;
    const n = Math.floor(length / cell);
    for (let i = 0; i <= n; i++) {
      const x = -length / 2 + i * cell;
      const d1 = createBox(0.02, Math.hypot(cell, height - 0.2), 0.02);
      d1.applyMatrix(new Matrix4().makeRotationZ(Math.atan2(height - 0.2, cell)));
      d1.translate(x, height / 2, 0);
      m.merge(d1);
      const d2 = createBox(0.02, Math.hypot(cell, height - 0.2), 0.02);
      d2.applyMatrix(new Matrix4().makeRotationZ(-Math.atan2(height - 0.2, cell)));
      d2.translate(x, height / 2, 0);
      m.merge(d2);
    }
  }
  return prop('Fence', m, { material: 'Metal', cover: 0.25, blocksVision: !!opts.solid, tags: ['fence'] });
}

export function ladder(height = 3.2, width = 0.5) {
  const m = new Mesh({ name: 'Ladder' });
  for (const sx of [-1, 1]) {
    const rail = createBox(0.06, height, 0.06);
    rail.translate(sx * width / 2, height / 2, 0);
    m.merge(rail);
  }
  const rungs = Math.floor(height / 0.34);
  for (let i = 1; i <= rungs; i++) {
    const rung = createCylinder(0.022, 0.022, width, 6);
    rung.applyMatrix(new Matrix4().makeRotationZ(Math.PI / 2));
    rung.translate(0, i * (height / (rungs + 1)), 0);
    m.merge(rung);
  }
  return prop('Ladder', m, { material: 'Metal', cover: 0, tags: ['climbable'], castShadow: false, collider: ColliderHint.None });
}

// ---------------------------------------------------------------------------
// Gameplay objectives & pickups
// ---------------------------------------------------------------------------
export function spawnPad(radius = 1.1, team = 'neutral') {
  const m = new Mesh({ name: 'SpawnPad' });
  const base = createCylinder(radius, radius, 0.08, 24);
  m.merge(base);
  const ring = createTube(radius * 0.85, radius * 0.7, 0.1, 24);
  ring.translate(0, 0.04, 0);
  m.merge(ring);
  // team chevron arrow on the ground
  const chevron = createWedge(0.5, 0.06, 0.7);
  chevron.translate(0, 0.06, 0.1);
  const chevron2 = createWedge(0.5, 0.06, 0.7);
  chevron2.translate(0, 0.06, -0.35);
  m.merge(chevron); m.merge(chevron2);
  return prop('SpawnPad', m, {
    material: team === 'red' ? 'TeamRed' : team === 'blue' ? 'TeamBlue' : 'Accent',
    cover: 0, blocksBullets: false, blocksVision: false, castShadow: false, tags: ['spawn', `team:${team}`],
    collider: ColliderHint.Cylinder,
  });
}

export function healthPickup() {
  const m = new Mesh({ name: 'HealthPickup' });
  const orb = createIcosphere(0.28, 2);
  orb.scaleMesh(1, 1.15, 1);
  m.merge(orb);
  const crossA = createBox(0.34, 0.09, 0.09);
  const crossB = createBox(0.09, 0.34, 0.09);
  crossA.translate(0, 0, 0.24);
  crossB.translate(0, 0, 0.24);
  m.merge(crossA); m.merge(crossB);
  return prop('HealthPickup', m, { material: 'Health', cover: 0, blocksBullets: false, blocksVision: false, castShadow: false, tags: ['pickup', 'health'], collider: ColliderHint.Sphere });
}

export function ammoPickup(kind = 'rifle') {
  const m = new Mesh({ name: 'AmmoPickup' });
  const box = createBox(0.42, 0.26, 0.3);
  m.merge(box);
  const lid = createBox(0.44, 0.05, 0.32);
  lid.translate(0, 0.15, 0);
  m.merge(lid);
  const latch = createBox(0.1, 0.06, 0.06);
  latch.translate(0, 0.06, -0.16);
  m.merge(latch);
  for (let i = 0; i < 4; i++) {
    const round = createCylinder(0.022, 0.022, 0.12, 8);
    round.applyMatrix(new Matrix4().makeRotationZ(Math.PI / 2));
    round.translate(-0.1 + i * 0.06, 0.18, 0.05);
    m.merge(round);
  }
  return prop('AmmoPickup', m, { material: 'Accent', cover: 0, blocksBullets: false, blocksVision: false, castShadow: false, tags: ['pickup', 'ammo', `ammo:${kind}`] });
}

export function armorPickup() {
  const m = new Mesh({ name: 'ArmorPickup' });
  const plate = createBox(0.36, 0.42, 0.12);
  m.merge(plate);
  const collar = createBox(0.22, 0.12, 0.14);
  collar.translate(0, 0.24, 0.01);
  m.merge(collar);
  const side = createBox(0.08, 0.3, 0.14);
  side.translate(0.22, -0.02, 0);
  m.merge(side);
  const side2 = side.clone();
  side2.applyMatrix(new Matrix4().makeScale(-1, 1, 1));
  m.merge(side2);
  return prop('ArmorPickup', m, { material: 'TeamBlue', cover: 0, blocksBullets: false, blocksVision: false, castShadow: false, tags: ['pickup', 'armor'] });
}

export function weaponPickup() {
  const m = new Mesh({ name: 'WeaponPickup' });
  const base = createBox(0.7, 0.1, 0.34);
  m.merge(base);
  const rack = createBox(0.5, 0.12, 0.12);
  rack.translate(0, 0.1, 0);
  m.merge(rack);
  return prop('WeaponPickup', m, { material: 'Accent', cover: 0, blocksBullets: false, blocksVision: false, castShadow: false, tags: ['pickup', 'weapon'] });
}

export function capturePoint(radius = 3, team = 'neutral') {
  const m = new Mesh({ name: 'CapturePoint' });
  const ring = createTube(radius, radius - 0.25, 0.12, 40);
  ring.translate(0, 0.06, 0);
  m.merge(ring);
  const inner = createCylinder(radius - 0.3, radius - 0.3, 0.04, 32);
  inner.translate(0, 0.02, 0);
  m.merge(inner);
  for (let i = 0; i < 4; i++) {
    const a = (i / 4) * Math.PI * 2;
    const post = createBox(0.14, 1.4, 0.14);
    post.translate(Math.cos(a) * (radius - 0.1), 0.7, Math.sin(a) * (radius - 0.1));
    m.merge(post);
    const light = createIcosphere(0.1, 1);
    light.translate(Math.cos(a) * (radius - 0.1), 1.46, Math.sin(a) * (radius - 0.1));
    m.merge(light);
  }
  const banner = createBox(0.08, 2.2, 0.08);
  banner.translate(0, 1.1, -(radius - 0.1));
  m.merge(banner);
  return prop('CapturePoint', m, {
    material: team === 'red' ? 'TeamRed' : team === 'blue' ? 'TeamBlue' : 'Accent',
    cover: 0, blocksBullets: false, blocksVision: false, tags: ['objective', 'capture', `team:${team}`],
  });
}

export function bombSite(radius = 2.4) {
  const m = new Mesh({ name: 'BombSite' });
  const ring = createTube(radius, radius - 0.3, 0.1, 32);
  ring.translate(0, 0.05, 0);
  m.merge(ring);
  const cross = createBox(radius * 1.4, 0.05, 0.24);
  cross.translate(0, 0.03, 0);
  m.merge(cross);
  const cross2 = createBox(0.24, 0.05, radius * 1.4);
  cross2.translate(0, 0.03, 0);
  m.merge(cross2);
  return prop('BombSite', m, { material: 'Hazard', cover: 0, blocksBullets: false, blocksVision: false, tags: ['objective', 'bombsite'] });
}

export function bombCrate() {
  const m = new Mesh({ name: 'BombCrate' });
  const body = createBox(0.6, 0.5, 0.6);
  m.merge(body);
  const lid = createBox(0.64, 0.08, 0.64);
  lid.translate(0, 0.29, 0);
  m.merge(lid);
  const handle = createTube(0.09, 0.06, 0.05, 12);
  handle.translate(0, 0.34, 0);
  m.merge(handle);
  return prop('BombCrate', m, { material: 'Hazard', cover: 0, blocksBullets: false, blocksVision: false, tags: ['objective', 'bomb'] });
}

export function flagStand() {
  const m = new Mesh({ name: 'FlagStand' });
  const base = createCylinder(0.4, 0.4, 0.16, 20);
  m.merge(base);
  const pole = createCylinder(0.05, 0.05, 3.2, 12);
  pole.translate(0, 1.6, 0);
  m.merge(pole);
  const flag = createBox(1.1, 0.7, 0.03);
  flag.translate(0.55, 2.7, 0);
  m.merge(flag);
  return prop('FlagStand', m, { material: 'Accent', cover: 0, blocksBullets: false, blocksVision: false, tags: ['objective', 'flag'] });
}

// ---------------------------------------------------------------------------
// Outdoor / terrain scatter
// ---------------------------------------------------------------------------
export function tree(seed = 1, opts = {}) {
  const rng = new RNG(seed * 7919 + 13);
  const m = new Mesh({ name: 'Tree' });
  const trunkH = opts.trunkHeight ?? rng.nextNumber(3, 5.5);
  const trunkR = opts.trunkRadius ?? rng.nextNumber(0.16, 0.28);
  const trunk = createCylinder(trunkR * 0.7, trunkR * 1.3, trunkH, 10, 3);
  trunk.translate(0, trunkH / 2, 0);
  m.merge(trunk);
  const branchCount = 5;
  for (let i = 0; i < branchCount; i++) {
    const a = (i / branchCount) * Math.PI * 2 + rng.nextNumber(-0.4, 0.4);
    const y = trunkH * rng.nextNumber(0.55, 0.95);
    const len = rng.nextNumber(0.7, 1.6);
    const br = createCylinder(0.05, trunkR * 0.6, len, 7);
    const tilt = rng.nextNumber(0.6, 1.15);
    br.applyMatrix(new Matrix4().makeRotationZ(tilt));
    br.applyMatrix(new Matrix4().makeRotationY(a));
    br.translate(Math.cos(a) * len * 0.35, y + len * 0.3, Math.sin(a) * len * 0.35);
    m.merge(br);
  }
  const foliage = opts.blobCount ?? 6;
  for (let i = 0; i < foliage; i++) {
    const a = rng.nextNumber(0, Math.PI * 2);
    const r = rng.nextNumber(0.2, 1.1);
    const y = trunkH + rng.nextNumber(-0.5, 1.2);
    const s = rng.nextNumber(0.8, 1.7);
    const blob = createIcosphere(s * 0.9, 1);
    blob.scaleMesh(1, 0.85, 1);
    blob.translate(Math.cos(a) * r, y, Math.sin(a) * r);
    m.merge(blob);
  }
  m.computeNormals(false);
  return prop('Tree', m, { material: 'Foliage', collider: ColliderHint.Cylinder, cover: 0.6, blocksVision: false, castShadow: true, tags: ['nature'] });
}

export function pineTree(seed = 1) {
  const rng = new RNG(seed * 104729 + 7);
  const m = new Mesh({ name: 'PineTree' });
  const h = rng.nextNumber(6, 9);
  const trunk = createCylinder(0.14, 0.26, h, 8);
  trunk.translate(0, h / 2, 0);
  m.merge(trunk);
  const layers = 5;
  for (let i = 0; i < layers; i++) {
    const t = i / (layers - 1);
    const y = h * (0.28 + t * 0.62);
    const r = 1.9 * (1 - t * 0.78);
    const cone = createCone(r, 1.5, 12);
    cone.translate(0, y + 0.6, 0);
    m.merge(cone);
  }
  m.computeNormals(false);
  return prop('PineTree', m, { material: 'Foliage', collider: ColliderHint.Cylinder, cover: 0.7, blocksVision: false, tags: ['nature', 'concealment'] });
}

export function rock(seed = 1, scale = 1) {
  const rng = new RNG(seed * 31337 + 11);
  const geo = createIcosphere(scale, 2);
  const p = geo.positions;
  for (let i = 0; i < p.length; i += 3) {
    const n = 1 + rng.nextNumber(-0.28, 0.24);
    p[i] *= n; p[i + 1] *= n * rng.nextNumber(0.55, 0.85); p[i + 2] *= n;
  }
  geo.computeNormals(false);
  geo.computeBounds();
  return prop('Rock', geo, { material: 'Rock', collider: ColliderHint.Sphere, cover: scale > 1 ? 0.75 : 0.4 });
}

export function bush(seed = 1) {
  const rng = new RNG(seed * 7717 + 3);
  const m = new Mesh({ name: 'Bush' });
  const blobs = 5;
  for (let i = 0; i < blobs; i++) {
    const s = rng.nextNumber(0.4, 0.8);
    const b = createIcosphere(s, 1);
    b.scaleMesh(1, 0.7, 1);
    b.translate(rng.nextNumber(-0.4, 0.4), s * 0.45, rng.nextNumber(-0.4, 0.4));
    m.merge(b);
  }
  m.computeNormals(false);
  return prop('Bush', m, { material: 'Foliage', collider: ColliderHint.None, cover: 0.15, blocksVision: false, blocksBullets: false, tags: ['nature', 'concealment'] });
}

export function grassPatch(seed = 1, radius = 2.2, count = 90) {
  const rng = new RNG(seed * 5077 + 17);
  const m = new Mesh({ name: 'GrassPatch' });
  for (let i = 0; i < count; i++) {
    const a = rng.nextNumber(0, Math.PI * 2);
    const r = Math.sqrt(rng.nextNumber(0, 1)) * radius;
    const h = rng.nextNumber(0.18, 0.42);
    const blade = createBox(0.05, h, 0.012, { uvScale: 1 });
    const tilt = rng.nextNumber(-0.35, 0.35);
    blade.applyMatrix(new Matrix4().makeRotationZ(tilt));
    blade.applyMatrix(new Matrix4().makeRotationY(rng.nextNumber(0, Math.PI * 2)));
    blade.translate(Math.cos(a) * r, h / 2 * Math.cos(tilt), Math.sin(a) * r);
    m.merge(blade);
  }
  return prop('GrassPatch', m, { material: 'Foliage', collider: ColliderHint.None, castShadow: false, blocksBullets: false, blocksVision: false, tags: ['nature', 'decor'] });
}

export function streetLamp(height = 5, opts = {}) {
  const m = new Mesh({ name: 'StreetLamp' });
  const base = createCylinder(0.22, 0.3, 0.3, 12);
  base.translate(0, 0.15, 0);
  m.merge(base);
  const pole = createCylinder(0.09, 0.12, height, 12);
  pole.translate(0, height / 2, 0);
  m.merge(pole);
  const arm = createBox(0.1, 0.1, 1.0);
  arm.translate(0, height - 0.1, 0.45);
  m.merge(arm);
  const head = createBox(0.36, 0.14, 0.55);
  head.translate(0, height - 0.22, 0.85);
  m.merge(head);
  return prop('StreetLamp', m, {
    material: opts.hazard ? 'Hazard' : 'Metal', cover: 0.15, tags: ['light', 'pole'],
    lights: [{ type: 'point', position: new Vector3(0, height - 0.3, 0.85), color: '#ffd9a0', intensity: 3.4, range: 12 }],
  });
}

export function trafficCone() {
  const m = new Mesh({ name: 'TrafficCone' });
  const base = createBox(0.44, 0.05, 0.44);
  base.translate(0, 0.025, 0);
  m.merge(base);
  const cone = createCone(0.18, 0.68, 12);
  cone.translate(0, 0.39, 0);
  m.merge(cone);
  const stripe = createCylinder(0.13, 0.155, 0.1, 12);
  stripe.translate(0, 0.46, 0);
  m.merge(stripe);
  return prop('TrafficCone', m, { material: 'Hazard', collider: ColliderHint.Cylinder, cover: 0 });
}

export function tires() {
  const m = new Mesh({ name: 'Tires' });
  for (let i = 0; i < 3; i++) {
    const t = createTorus(0.34, 0.14, 16, 12);
    t.applyMatrix(new Matrix4().makeRotationX(Math.PI / 2));
    t.translate(i * 0.03 - 0.03, 0.14 + i * 0.28, 0);
    m.merge(t);
  }
  return prop('Tires', m, { material: 'Rubber', collider: ColliderHint.Box, cover: 0.35 });
}

export function pallet() {
  const m = new Mesh({ name: 'Pallet' });
  for (let i = 0; i < 5; i++) {
    const board = createBox(1.1, 0.04, 0.14);
    board.translate(0, 0.12, -0.5 + i * 0.25);
    m.merge(board);
  }
  for (const z of [-0.45, 0, 0.45]) {
    const rail = createBox(1.1, 0.1, 0.1);
    rail.translate(0, 0.05, z);
    m.merge(rail);
  }
  return prop('Pallet', m, { material: 'Wood', collider: ColliderHint.Box, cover: 0.12, destructible: true, health: 40 });
}

export function shatteredGlassPane(width = 1.2, height = 1.8) {
  const m = new Mesh({ name: 'GlassPane' });
  const pane = createBox(width, height, 0.03);
  m.merge(pane);
  return prop('GlassPane', m, {
    material: 'Glass', collider: ColliderHint.Box, cover: 0.1, blocksVision: false,
    destructible: true, health: 1, tags: ['glass', 'breakable'], castShadow: false,
  });
}

export function oilDrumRack() {
  const m = new Mesh({ name: 'DrumRack' });
  for (const sx of [-1, 1]) {
    const post = createBox(0.1, 1.2, 0.1);
    post.translate(sx * 0.6, 0.6, 0);
    m.merge(post);
  }
  for (const y of [0.35, 0.8]) {
    const rail = createBox(1.3, 0.08, 0.08);
    rail.translate(0, y, 0);
    m.merge(rail);
  }
  const drum = createCylinder(0.3, 0.3, 0.9, 16);
  drum.applyMatrix(new Matrix4().makeRotationZ(Math.PI / 2));
  drum.translate(0, 0.62, 0.28);
  m.merge(drum);
  return prop('DrumRack', m, { material: 'Metal', cover: 0.5, tags: ['explosive'], destructible: true, health: 80 });
}

export function lightPostBarrier() {
  const m = new Mesh({ name: 'Barrier' });
  const bar = createBox(2.4, 0.22, 0.1);
  bar.translate(0, 1.0, 0);
  m.merge(bar);
  for (const sx of [-1, 1]) {
    const leg = createBox(0.12, 1.0, 0.5);
    leg.translate(sx * 1.1, 0.5, 0);
    m.merge(leg);
  }
  for (let i = 0; i < 4; i++) {
    const stripe = createBox(0.3, 0.22, 0.12);
    stripe.translate(-0.9 + i * 0.6, 1.0, 0);
    m.merge(stripe);
  }
  return prop('Barrier', m, { material: 'Hazard', cover: 0.4 });
}

// ---------------------------------------------------------------------------
// Procedural terrain chunks (blocky, Roblox-style, and fast to raycast)
// ---------------------------------------------------------------------------
/**
 * Builds a heightfield terrain mesh from a noise function.
 * @param {object} opts
 * @param {number} [opts.size=64] world size (metres, square)
 * @param {number} [opts.resolution=32] vertices per side
 * @param {Function} [opts.heightAt] (x, z) => y
 * @param {number} [opts.uvScale=0.25]
 */
export function createTerrainChunk(opts = {}) {
  const size = opts.size ?? 64;
  const res = opts.resolution ?? 32;
  const heightAt = opts.heightAt ?? (() => 0);
  const uvScale = opts.uvScale ?? 0.25;
  const positions = [];
  const normals = [];
  const uvs = [];
  const indices = [];
  const step = size / res;
  const half = size / 2;
  const heights = new Float32Array((res + 1) * (res + 1));
  for (let z = 0; z <= res; z++) {
    for (let x = 0; x <= res; x++) {
      const wx = -half + x * step;
      const wz = -half + z * step;
      heights[z * (res + 1) + x] = heightAt(wx, wz);
    }
  }
  const getH = (x, z) => heights[Math.max(0, Math.min(res, z)) * (res + 1) + Math.max(0, Math.min(res, x))];
  for (let z = 0; z <= res; z++) {
    for (let x = 0; x <= res; x++) {
      const wx = -half + x * step;
      const wz = -half + z * step;
      const h = getH(x, z);
      positions.push(wx, h, wz);
      const hL = getH(x - 1, z), hR = getH(x + 1, z), hD = getH(x, z - 1), hU = getH(x, z + 1);
      const nx = hL - hR, ny = 2 * step, nz = hD - hU;
      const nl = Math.hypot(nx, ny, nz) || 1;
      normals.push(nx / nl, ny / nl, nz / nl);
      uvs.push(wx * uvScale, wz * uvScale);
    }
  }
  for (let z = 0; z < res; z++) {
    for (let x = 0; x < res; x++) {
      const a = z * (res + 1) + x;
      const bb = a + 1;
      const c = a + (res + 1);
      const d = c + 1;
      indices.push(a, c, bb, bb, c, d);
    }
  }
  const mesh = new Mesh({ name: 'TerrainChunk', positions, normals, uvs, indices });
  return mesh;
}

export const PropLibrary = {
  // cover & barriers
  crate, barrel, sandbagWall, jerseyBarrier, lowCover, concreteWall, windowedWall, stairs, ramp,
  // structures
  container, watchtower, buildingBlock, fenceSection, ladder,
  // objectives & pickups
  spawnPad, healthPickup, ammoPickup, armorPickup, weaponPickup, capturePoint, bombSite, bombCrate, flagStand,
  // scatter
  tree, pineTree, rock, bush, grassPatch, streetLamp, trafficCone, tires, pallet, shatteredGlassPane, oilDrumRack, lightPostBarrier,
  // terrain
  createTerrainChunk,
};

/** Editor palette: what shows up in Studio's "Insert" tab, grouped. */
export const PropPalette = [
  { category: 'Cover', items: ['crate', 'barrel', 'sandbagWall', 'jerseyBarrier', 'lowCover', 'concreteWall', 'windowedWall', 'stairs', 'ramp', 'lightPostBarrier'] },
  { category: 'Structures', items: ['container', 'watchtower', 'buildingBlock', 'fenceSection', 'ladder', 'oilDrumRack'] },
  { category: 'Objectives', items: ['spawnPad', 'capturePoint', 'bombSite', 'flagStand'] },
  { category: 'Pickups', items: ['healthPickup', 'ammoPickup', 'armorPickup', 'weaponPickup'] },
  { category: 'Scatter', items: ['tree', 'pineTree', 'rock', 'bush', 'grassPatch', 'streetLamp', 'trafficCone', 'tires', 'pallet', 'shatteredGlassPane'] },
];

export default PropLibrary;
