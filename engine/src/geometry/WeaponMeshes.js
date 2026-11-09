/**
 * OminX Engine — procedural weapon models for the FPS viewmodel.
 *
 * Each weapon is a set of named parts so the animation layer can move the slide/bolt,
 * rotate the magazine during a reload, drop the trigger, and snap the iron sights to the
 * camera. Anchors (`muzzle`, `ejectionPort`, `adsSight`, `pivot`) are in weapon-local space,
 * so gameplay code never has to hardcode offsets.
 *
 * Local convention: -Z is forward (weapon points away from the player), +Y up.
 * @module engine/geometry/WeaponMeshes
 */
import { Mesh } from './Mesh.js';
import { Vector3 } from '../math/Vector3.js';
import { Matrix4 } from '../math/Matrix4.js';
import { Quaternion } from '../math/Quaternion.js';
import { createBox as boxMesh, createCylinder as cylinderMesh, createTube as tubeMesh, createWedge as wedgeMesh, createSphere as sphereMesh } from './Primitives.js';

/** Material slots every weapon draws from — the renderer maps these to PBR presets. */
export const WeaponMaterials = {
  gunmetal: 'WeaponGunmetal',
  polymer: 'WeaponPolymer',
  wood: 'WeaponWood',
  accent: 'WeaponAccent',
  glass: 'WeaponGlass',
  brass: 'WeaponBrass',
};

class PartBuilder {
  constructor() { this.mesh = new Mesh({ name: 'part' }); }
  box(sx, sy, sz, x = 0, y = 0, z = 0, rx = 0, ry = 0, rz = 0, uvScale = 1) {
    const m = new Matrix4();
    const rot = new Matrix4().makeRotationFromEuler(rx, ry, rz);
    m.compose(new Vector3(x, y, z), quatFromMatrix(rot), new Vector3(1, 1, 1));
    const box = boxMesh(sx, sy, sz, uvScale);
    this.mesh.merge(box, m);
    return this;
  }
  cylinder(r, h, x = 0, y = 0, z = 0, axis = 'z', segments = 14, rTop = null) {
    const cyl = cylinderMesh(r, rTop ?? r, h, segments);
    const m = new Matrix4();
    if (axis === 'z') m.makeRotationX(Math.PI / 2);
    else if (axis === 'x') m.makeRotationZ(Math.PI / 2);
    m.setPosition(x, y, z);
    this.mesh.merge(cyl, m);
    return this;
  }
  tube(outer, inner, h, x = 0, y = 0, z = 0, axis = 'z', segments = 14) {
    const t = tubeMesh(outer, inner, h, segments);
    const m = new Matrix4();
    if (axis === 'z') m.makeRotationX(Math.PI / 2);
    else if (axis === 'x') m.makeRotationZ(Math.PI / 2);
    m.setPosition(x, y, z);
    this.mesh.merge(t, m);
    return this;
  }
  wedge(sx, sy, sz, x = 0, y = 0, z = 0, ry = 0) {
    const w = wedgeMesh(sx, sy, sz);
    const m = new Matrix4();
    if (ry) m.makeRotationY(ry);
    m.setPosition(x, y, z);
    this.mesh.merge(w, m);
    return this;
  }
  build(name) { this.mesh.name = name; this.mesh.computeBounds(); return this.mesh; }
  get geometry() { return this.mesh; }
}

function quatFromMatrix(m) { return new Quaternion().setFromRotationMatrix(m); }

// ---------------------------------------------------------------------------
// Shared sub-part builders
// ---------------------------------------------------------------------------
function ironSights(b, { frontZ, rearZ, y, height = 0.032 }) {
  // front post
  b.box(0.014, height, 0.02, 0, y + height / 2, frontZ);
  b.box(0.03, 0.012, 0.03, 0, y + 0.006, frontZ);
  // rear aperture (two ears + base)
  b.box(0.055, height * 0.75, 0.02, 0, y + height * 0.375, rearZ);
  b.box(0.012, height * 0.9, 0.022, -0.028, y + height * 0.45, rearZ);
  b.box(0.012, height * 0.9, 0.022, 0.028, y + height * 0.45, rearZ);
}

function picatinnyRail(b, length, y, z, width = 0.024, pitch = 0.022) {
  b.box(width, 0.008, length, 0, y, z);
  const n = Math.max(2, Math.floor(length / pitch));
  for (let i = 0; i < n; i++) {
    const zz = z - length / 2 + (i + 0.5) * (length / n);
    b.box(width * 1.05, 0.007, (length / n) * 0.5, 0, y + 0.007, zz);
  }
}

/**
 * Assault rifle — the default FPS primary. Flat-shooting, 30-round magazine, optic-ready.
 * @returns {WeaponModel}
 */
export function createRifle() {
  const receiver = new PartBuilder();
  const barrelPart = new PartBuilder();
  const handguard = new PartBuilder();
  const grip = new PartBuilder();
  const stock = new PartBuilder();
  const magazine = new PartBuilder();
  const bolt = new PartBuilder();
  const trigger = new PartBuilder();
  const optic = new PartBuilder();

  // --- receiver: the visual anchor of the whole gun
  receiver.box(0.062, 0.085, 0.30, 0, 0, -0.02);
  receiver.box(0.07, 0.026, 0.22, 0, 0.052, -0.02);       // upper ridge
  receiver.box(0.05, 0.05, 0.10, 0, -0.045, 0.10);        // buffer tower / stock interface
  receiver.box(0.03, 0.05, 0.04, 0, 0.045, -0.155);       // front sight base block
  // ejection port detail
  receiver.box(0.008, 0.028, 0.06, 0.033, 0.012, -0.055);
  // charging handle
  receiver.box(0.05, 0.012, 0.03, 0.012, 0.045, 0.075);
  picatinnyRail(receiver, 0.2, 0.066, -0.06);

  // --- barrel + gas block + muzzle device
  barrelPart.cylinder(0.011, 0.26, 0, 0.012, -0.35, 'z', 14);
  barrelPart.cylinder(0.019, 0.05, 0, 0.012, -0.245, 'z', 14);  // gas block
  barrelPart.cylinder(0.0165, 0.062, 0, 0.012, -0.5, 'z', 14);  // muzzle brake body
  barrelPart.tube(0.0165, 0.0115, 0.062, 0, 0.012, -0.5, 'z', 14);
  for (let i = 0; i < 3; i++) barrelPart.box(0.036, 0.006, 0.012, 0, 0.012 + 0.005, -0.483 - i * 0.016);

  // --- handguard with vent slots (classic quad-rail look)
  handguard.tube(0.026, 0.021, 0.22, 0, 0.012, -0.30, 'z', 12);
  for (let i = 0; i < 4; i++) {
    const a = (i / 4) * Math.PI * 2;
    handguard.box(0.026, 0.006, 0.026, Math.cos(a) * 0.024, 0.012 + Math.sin(a) * 0.024, -0.3, 0, a, Math.PI / 2);
  }
  handguard.box(0.05, 0.05, 0.03, 0, 0.012, -0.205);

  // --- pistol grip (angled 20°)
  grip.box(0.034, 0.105, 0.05, 0, -0.082, 0.075, 0.35, 0, 0);
  grip.box(0.038, 0.02, 0.056, 0, -0.132, 0.09, 0.35, 0, 0);
  grip.cylinder(0.008, 0.02, 0, -0.055, 0.03, 'x', 10);

  // --- magazine (curved 30rd, removable → reload animation)
  magazine.box(0.03, 0.14, 0.055, 0, -0.115, -0.045, 0, 0, 0.12);
  magazine.box(0.033, 0.02, 0.06, 0, -0.185, -0.055, 0, 0, 0.12);
  magazine.box(0.034, 0.012, 0.05, 0, -0.055, -0.04);

  // --- bolt carrier (animates on fire)
  bolt.box(0.026, 0.024, 0.07, 0.028, 0.03, -0.07);

  // --- trigger (rotates during fire)
  trigger.box(0.012, 0.036, 0.010, 0, -0.056, 0.032, 0.2, 0, 0);
  trigger.box(0.02, 0.012, 0.014, 0, -0.075, 0.03);

  // --- stock (collapsible, extends back +Z)
  stock.box(0.05, 0.062, 0.10, 0, 0.005, 0.155);
  stock.box(0.056, 0.02, 0.03, 0, 0.04, 0.13);
  stock.box(0.048, 0.075, 0.02, 0, -0.005, 0.21);
  stock.wedge(0.048, 0.03, 0.05, 0, 0.03, 0.20);
  stock.box(0.05, 0.014, 0.16, 0, -0.028, 0.16);

  // --- red dot optic (a distinct look, and it gives us an ADS anchor)
  optic.box(0.044, 0.026, 0.09, 0, 0.098, -0.02);
  optic.tube(0.028, 0.024, 0.06, 0, 0.104, -0.05, 'z', 16);
  optic.box(0.03, 0.03, 0.008, 0, 0.104, -0.081);
  optic.box(0.05, 0.014, 0.02, 0, 0.084, -0.02);

  const parts = [
    { name: 'receiver', material: WeaponMaterials.gunmetal, mesh: receiver.build('receiver') },
    { name: 'barrel', material: WeaponMaterials.gunmetal, mesh: barrelPart.build('barrel') },
    { name: 'handguard', material: WeaponMaterials.polymer, mesh: handguard.build('handguard') },
    { name: 'grip', material: WeaponMaterials.polymer, mesh: grip.build('grip') },
    { name: 'stock', material: WeaponMaterials.polymer, mesh: stock.build('stock') },
    { name: 'magazine', material: WeaponMaterials.polymer, mesh: magazine.build('magazine'), pivot: new Vector3(0, -0.05, -0.03), animate: 'magazine' },
    { name: 'bolt', material: WeaponMaterials.gunmetal, mesh: bolt.build('bolt'), animate: 'bolt', travel: new Vector3(0, 0, 0.055) },
    { name: 'trigger', material: WeaponMaterials.gunmetal, mesh: trigger.build('trigger'), pivot: new Vector3(0, -0.04, 0.03), animate: 'trigger' },
    { name: 'optic', material: WeaponMaterials.gunmetal, mesh: optic.build('optic') },
  ];
  return makeModel('AssaultRifle', parts, {
    muzzle: new Vector3(0, 0.012, -0.535),
    ejectionPort: new Vector3(0.04, 0.02, -0.05),
    adsSight: new Vector3(0, 0.098, -0.05),
    shellEjectDir: new Vector3(1, 0.55, 0.35).normalize(),
    hipPivot: new Vector3(0, -0.05, 0.12),
    length: 0.75,
  });
}

/** Pistol — secondary, fast swap, big ADS zoom gain. */
export function createPistol() {
  const slide = new PartBuilder();
  const frame = new PartBuilder();
  const grip = new PartBuilder();
  const barrel = new PartBuilder();
  const magazine = new PartBuilder();
  const trigger = new PartBuilder();

  slide.box(0.04, 0.045, 0.19, 0, 0.012, -0.03);
  slide.box(0.042, 0.012, 0.19, 0, 0.032, -0.03);
  // slide serrations
  for (let i = 0; i < 5; i++) slide.box(0.044, 0.028, 0.006, 0, 0.014, 0.01 + i * 0.012);
  slide.box(0.03, 0.016, 0.03, 0, 0.03, -0.115);
  slide.box(0.012, 0.014, 0.012, 0, 0.046, -0.135);  // front sight
  slide.box(0.038, 0.014, 0.012, 0, 0.046, 0.04);    // rear sight
  slide.box(0.034, 0.01, 0.05, 0, 0.006, -0.05);     // ejection port lip

  frame.box(0.036, 0.03, 0.16, 0, -0.02, -0.03);
  frame.box(0.032, 0.02, 0.06, 0, -0.03, -0.10);
  frame.box(0.026, 0.014, 0.03, 0, -0.045, -0.125);  // accessory rail

  grip.box(0.032, 0.11, 0.05, 0, -0.09, 0.045, 0.3, 0, 0);
  grip.box(0.036, 0.018, 0.055, 0, -0.14, 0.06, 0.3, 0, 0);
  for (let i = 0; i < 4; i++) grip.box(0.034, 0.006, 0.048, 0, -0.065 - i * 0.018, 0.05 + i * 0.005, 0.3, 0, 0);

  barrel.cylinder(0.009, 0.05, 0, 0.012, -0.145, 'z', 12);
  barrel.tube(0.013, 0.0088, 0.03, 0, 0.012, -0.15, 'z', 12);

  magazine.box(0.026, 0.115, 0.038, 0, -0.095, 0.045, 0.3, 0, 0);
  magazine.box(0.03, 0.014, 0.042, 0, -0.145, 0.058, 0.3, 0, 0);

  trigger.box(0.01, 0.03, 0.008, 0, -0.048, 0.012, 0.2, 0, 0);
  trigger.box(0.016, 0.008, 0.028, 0, -0.062, 0.014);

  const parts = [
    { name: 'slide', material: WeaponMaterials.gunmetal, mesh: slide.build('slide'), animate: 'bolt', travel: new Vector3(0, 0, 0.045) },
    { name: 'frame', material: WeaponMaterials.polymer, mesh: frame.build('frame') },
    { name: 'grip', material: WeaponMaterials.polymer, mesh: grip.build('grip') },
    { name: 'barrel', material: WeaponMaterials.gunmetal, mesh: barrel.build('barrel') },
    { name: 'magazine', material: WeaponMaterials.gunmetal, mesh: magazine.build('magazine'), pivot: new Vector3(0, -0.04, 0.045), animate: 'magazine' },
    { name: 'trigger', material: WeaponMaterials.gunmetal, mesh: trigger.build('trigger'), pivot: new Vector3(0, -0.04, 0.012), animate: 'trigger' },
  ];
  return makeModel('Pistol', parts, {
    muzzle: new Vector3(0, 0.012, -0.175),
    ejectionPort: new Vector3(0.024, 0.02, -0.05),
    adsSight: new Vector3(0, 0.052, -0.03),
    shellEjectDir: new Vector3(1, 0.6, 0.4).normalize(),
    hipPivot: new Vector3(0, -0.06, 0.06),
    length: 0.28,
  });
}

/** SMG — high RPM, big movement penalty, tight hipfire. */
export function createSMG() {
  const body = new PartBuilder();
  const barrel = new PartBuilder();
  const grip = new PartBuilder();
  const magazine = new PartBuilder();
  const bolt = new PartBuilder();
  const stock = new PartBuilder();
  const trigger = new PartBuilder();

  body.box(0.05, 0.07, 0.24, 0, 0, -0.02);
  body.box(0.056, 0.02, 0.16, 0, 0.042, -0.05);
  body.box(0.04, 0.04, 0.08, 0, -0.04, 0.09);
  picatinnyRail(body, 0.14, 0.052, -0.06);

  barrel.cylinder(0.014, 0.16, 0, 0.008, -0.26, 'z', 14);
  barrel.tube(0.02, 0.014, 0.08, 0, 0.008, -0.3, 'z', 14);
  for (let i = 0; i < 4; i++) barrel.box(0.044, 0.006, 0.014, 0, 0.008, -0.27 - i * 0.018);
  barrel.box(0.046, 0.046, 0.06, 0, 0.008, -0.17);

  grip.box(0.032, 0.095, 0.046, 0, -0.075, 0.065, 0.3, 0, 0);
  grip.box(0.036, 0.016, 0.05, 0, -0.12, 0.078, 0.3, 0, 0);
  grip.box(0.03, 0.05, 0.05, 0.0, -0.055, -0.11, 0, 0, 0);   // angled foregrip
  grip.box(0.026, 0.036, 0.036, 0, -0.085, -0.115, 0.4, 0, 0);

  magazine.box(0.026, 0.16, 0.05, 0, -0.125, -0.03, 0, 0, 0.05);
  magazine.box(0.03, 0.02, 0.055, 0, -0.205, -0.035);
  // stick mag visual ribs
  for (let i = 0; i < 4; i++) magazine.box(0.028, 0.006, 0.052, 0, -0.07 - i * 0.03, -0.032);

  bolt.box(0.024, 0.022, 0.05, 0.026, 0.03, -0.05);

  stock.tube(0.016, 0.012, 0.1, 0, 0.01, 0.17, 'z', 10);
  stock.box(0.045, 0.06, 0.02, 0, 0.005, 0.23);
  stock.box(0.05, 0.014, 0.03, 0, 0.036, 0.22);
  stock.box(0.045, 0.012, 0.1, 0, -0.022, 0.18);

  trigger.box(0.01, 0.03, 0.008, 0, -0.05, 0.022, 0.2, 0, 0);
  trigger.box(0.016, 0.008, 0.024, 0, -0.064, 0.024);

  const parts = [
    { name: 'body', material: WeaponMaterials.polymer, mesh: body.build('body') },
    { name: 'barrel', material: WeaponMaterials.gunmetal, mesh: barrel.build('barrel') },
    { name: 'grip', material: WeaponMaterials.polymer, mesh: grip.build('grip') },
    { name: 'magazine', material: WeaponMaterials.polymer, mesh: magazine.build('magazine'), pivot: new Vector3(0, -0.05, -0.03), animate: 'magazine' },
    { name: 'bolt', material: WeaponMaterials.gunmetal, mesh: bolt.build('bolt'), animate: 'bolt', travel: new Vector3(0, 0, 0.05) },
    { name: 'stock', material: WeaponMaterials.polymer, mesh: stock.build('stock') },
    { name: 'trigger', material: WeaponMaterials.gunmetal, mesh: trigger.build('trigger'), pivot: new Vector3(0, -0.04, 0.022), animate: 'trigger' },
  ];
  return makeModel('SMG', parts, {
    muzzle: new Vector3(0, 0.008, -0.345),
    ejectionPort: new Vector3(0.03, 0.02, -0.04),
    adsSight: new Vector3(0, 0.05, -0.05),
    shellEjectDir: new Vector3(1, 0.6, 0.3).normalize(),
    hipPivot: new Vector3(0, -0.05, 0.1),
    length: 0.55,
  });
}

/** Pump shotgun — 8 pellets, brutal close range, per-shell reload timing. */
export function createShotgun() {
  const body = new PartBuilder();
  const barrel = new PartBuilder();
  const pump = new PartBuilder();
  const stock = new PartBuilder();
  const grip = new PartBuilder();
  const tube = new PartBuilder();
  const trigger = new PartBuilder();

  body.box(0.06, 0.085, 0.26, 0, 0, -0.02);
  body.box(0.05, 0.04, 0.1, 0, 0.05, -0.02);
  body.box(0.02, 0.016, 0.016, 0.026, 0.02, -0.09); // ejection port
  body.box(0.036, 0.05, 0.07, 0, -0.05, 0.09);

  barrel.cylinder(0.021, 0.46, 0, 0.022, -0.34, 'z', 16);
  barrel.cylinder(0.027, 0.03, 0, 0.022, -0.56, 'z', 16);
  barrel.box(0.012, 0.014, 0.012, 0, 0.045, -0.53);  // front bead sight
  barrel.box(0.03, 0.006, 0.02, 0, 0.04, -0.53);
  barrel.box(0.012, 0.012, 0.012, 0, 0.042, -0.12);  // rear bead

  tube.cylinder(0.016, 0.34, 0, -0.012, -0.3, 'z', 12);
  tube.cylinder(0.019, 0.02, 0, -0.012, -0.46, 'z', 12);

  pump.box(0.048, 0.042, 0.16, 0, -0.008, -0.24);
  for (let i = 0; i < 6; i++) pump.box(0.05, 0.006, 0.008, 0, -0.008, -0.31 + i * 0.026);
  pump.wedge(0.05, 0.02, 0.04, 0, -0.026, -0.17);

  grip.box(0.034, 0.10, 0.05, 0, -0.078, 0.055, 0.32, 0, 0);
  grip.box(0.038, 0.016, 0.054, 0, -0.126, 0.072, 0.32, 0, 0);

  stock.box(0.05, 0.07, 0.12, 0, 0.008, 0.17);
  stock.wedge(0.05, 0.03, 0.06, 0, 0.036, 0.14);
  stock.box(0.054, 0.09, 0.022, 0, -0.005, 0.245);
  stock.box(0.05, 0.014, 0.14, 0, -0.03, 0.19);

  trigger.box(0.012, 0.032, 0.008, 0, -0.052, 0.035, 0.2, 0, 0);
  trigger.box(0.018, 0.008, 0.03, 0, -0.068, 0.037);

  const parts = [
    { name: 'receiver', material: WeaponMaterials.gunmetal, mesh: body.build('receiver') },
    { name: 'barrel', material: WeaponMaterials.gunmetal, mesh: barrel.build('barrel') },
    { name: 'magazineTube', material: WeaponMaterials.gunmetal, mesh: tube.build('magazineTube') },
    { name: 'pump', material: WeaponMaterials.wood, mesh: pump.build('pump'), animate: 'pump', pivot: new Vector3(0, -0.008, -0.22), travel: new Vector3(0, 0, 0.1) },
    { name: 'stock', material: WeaponMaterials.wood, mesh: stock.build('stock') },
    { name: 'grip', material: WeaponMaterials.wood, mesh: grip.build('grip') },
    { name: 'trigger', material: WeaponMaterials.gunmetal, mesh: trigger.build('trigger'), pivot: new Vector3(0, -0.04, 0.035), animate: 'trigger' },
  ];
  return makeModel('PumpShotgun', parts, {
    muzzle: new Vector3(0, 0.022, -0.575),
    ejectionPort: new Vector3(0.03, 0.02, -0.09),
    adsSight: new Vector3(0, 0.045, -0.53),
    shellEjectDir: new Vector3(1, 0.5, 0.5).normalize(),
    hipPivot: new Vector3(0, -0.05, 0.12),
    length: 0.85,
    shellByShell: true,
  });
}

/** Bolt-action sniper — one-shot to the chest, scope overlay, slow bolt cycle. */
export function createSniper() {
  const body = new PartBuilder();
  const barrel = new PartBuilder();
  const scope = new PartBuilder();
  const stock = new PartBuilder();
  const grip = new PartBuilder();
  const bolt = new PartBuilder();
  const magazine = new PartBuilder();
  const trigger = new PartBuilder();

  body.box(0.055, 0.08, 0.4, 0, 0, 0.0);
  body.box(0.05, 0.03, 0.2, 0, 0.055, -0.05);
  body.box(0.02, 0.018, 0.02, 0.026, 0.02, -0.06);

  barrel.cylinder(0.014, 0.62, 0, 0.012, -0.5, 'z', 16);
  barrel.cylinder(0.019, 0.05, 0, 0.012, -0.83, 'z', 16);
  for (let i = 0; i < 3; i++) barrel.box(0.038, 0.005, 0.012, 0, 0.012, -0.815 - i * 0.016);
  barrel.cylinder(0.0115, 0.04, 0, 0.012, -0.79, 'z', 12);

  // scope: main tube + objective + ocular + turrets
  scope.tube(0.022, 0.0175, 0.24, 0, 0.086, -0.02, 'z', 20);
  scope.cylinder(0.031, 0.07, 0, 0.086, -0.17, 'z', 20);
  scope.tube(0.031, 0.0285, 0.012, 0, 0.086, -0.205, 'z', 20);
  scope.cylinder(0.028, 0.06, 0, 0.086, 0.13, 'z', 20);
  scope.tube(0.028, 0.025, 0.01, 0, 0.086, 0.158, 'z', 20);
  scope.cylinder(0.014, 0.02, 0, 0.086, 0.108, 'y', 12);  // elevation turret
  scope.cylinder(0.014, 0.02, 0.026, 0.086, 0.02, 'x', 12); // windage turret
  scope.box(0.014, 0.03, 0.02, 0, 0.055, -0.11);           // ring mounts
  scope.box(0.014, 0.03, 0.02, 0, 0.055, 0.06);

  grip.box(0.034, 0.105, 0.05, 0, -0.078, 0.08, 0.32, 0, 0);
  grip.box(0.038, 0.016, 0.054, 0, -0.128, 0.098, 0.32, 0, 0);

  stock.box(0.05, 0.075, 0.14, 0, 0.005, 0.28);
  stock.wedge(0.05, 0.035, 0.07, 0, 0.042, 0.24);
  stock.box(0.052, 0.11, 0.024, 0, -0.01, 0.36);
  stock.box(0.03, 0.03, 0.1, 0, -0.045, 0.3);
  stock.box(0.05, 0.02, 0.05, 0, 0.045, 0.24);   // cheek riser

  bolt.cylinder(0.008, 0.09, 0.038, 0.028, 0.03, 'x', 10);
  bolt.cylinder(0.013, 0.016, 0.085, 0.028, 0.03, 'x', 10);
  bolt.box(0.03, 0.014, 0.014, 0.05, 0.028, 0.03);

  magazine.box(0.026, 0.09, 0.05, 0, -0.09, -0.01, 0, 0, 0.05);
  magazine.box(0.03, 0.016, 0.054, 0, -0.132, -0.014);

  trigger.box(0.01, 0.03, 0.008, 0, -0.05, 0.04, 0.2, 0, 0);
  trigger.box(0.016, 0.008, 0.026, 0, -0.064, 0.042);

  const parts = [
    { name: 'receiver', material: WeaponMaterials.gunmetal, mesh: body.build('receiver') },
    { name: 'barrel', material: WeaponMaterials.gunmetal, mesh: barrel.build('barrel') },
    { name: 'scope', material: WeaponMaterials.gunmetal, mesh: scope.build('scope') },
    { name: 'stock', material: WeaponMaterials.polymer, mesh: stock.build('stock') },
    { name: 'grip', material: WeaponMaterials.polymer, mesh: grip.build('grip') },
    { name: 'bolt', material: WeaponMaterials.gunmetal, mesh: bolt.build('bolt'), animate: 'pump', pivot: new Vector3(0.04, 0.028, 0.03), travel: new Vector3(0.05, 0, 0) },
    { name: 'magazine', material: WeaponMaterials.gunmetal, mesh: magazine.build('magazine'), pivot: new Vector3(0, -0.05, -0.01), animate: 'magazine' },
    { name: 'trigger', material: WeaponMaterials.gunmetal, mesh: trigger.build('trigger'), pivot: new Vector3(0, -0.04, 0.04), animate: 'trigger' },
  ];
  return makeModel('BoltSniper', parts, {
    muzzle: new Vector3(0, 0.012, -0.855),
    ejectionPort: new Vector3(0.03, 0.02, -0.06),
    adsSight: new Vector3(0, 0.086, -0.02),
    shellEjectDir: new Vector3(1, 0.7, 0.3).normalize(),
    hipPivot: new Vector3(0, -0.05, 0.16),
    length: 1.2,
    boltAction: true,
  });
}

/** LMG — belt-fed, big magazine, heavy sway. */
export function createLMG() {
  const body = new PartBuilder();
  const barrel = new PartBuilder();
  const boxMag = new PartBuilder();
  const stock = new PartBuilder();
  const grip = new PartBuilder();
  const bipod = new PartBuilder();
  const trigger = new PartBuilder();

  body.box(0.075, 0.1, 0.34, 0, 0, -0.02);
  body.box(0.07, 0.03, 0.2, 0, 0.062, -0.06);
  picatinnyRail(body, 0.22, 0.078, -0.06, 0.026);
  body.box(0.03, 0.05, 0.06, 0, 0.045, 0.12);

  barrel.cylinder(0.017, 0.44, 0, 0.014, -0.42, 'z', 16);
  barrel.cylinder(0.021, 0.05, 0, 0.014, -0.3, 'z', 16);
  barrel.cylinder(0.024, 0.06, 0, 0.014, -0.66, 'z', 16);
  barrel.tube(0.024, 0.017, 0.06, 0, 0.014, -0.66, 'z', 16);
  barrel.box(0.014, 0.03, 0.014, 0, 0.05, -0.2);  // front sight

  boxMag.box(0.09, 0.13, 0.14, 0, -0.115, -0.02);
  boxMag.wedge(0.09, 0.05, 0.14, 0, -0.02, -0.02, Math.PI);
  for (let i = 0; i < 5; i++) boxMag.box(0.094, 0.006, 0.144, 0, -0.06 - i * 0.024, -0.02);
  boxMag.box(0.06, 0.05, 0.06, 0.08, 0.0, -0.02);  // belt feed

  stock.box(0.055, 0.08, 0.1, 0, 0.005, 0.19);
  stock.box(0.058, 0.1, 0.022, 0, -0.01, 0.25);
  stock.box(0.05, 0.02, 0.06, 0, 0.05, 0.17);

  grip.box(0.036, 0.1, 0.05, 0, -0.06, 0.09, 0.3, 0, 0);
  grip.box(0.04, 0.016, 0.054, 0, -0.108, 0.105, 0.3, 0, 0);

  bipod.cylinder(0.008, 0.16, -0.02, -0.08, -0.34, 'z', 8);
  bipod.cylinder(0.008, 0.16, 0.02, -0.08, -0.34, 'z', 8);
  bipod.box(0.09, 0.014, 0.03, 0, 0.01, -0.34);

  trigger.box(0.012, 0.032, 0.008, 0, -0.038, 0.05, 0.2, 0, 0);
  trigger.box(0.018, 0.008, 0.03, 0, -0.052, 0.052);

  const parts = [
    { name: 'receiver', material: WeaponMaterials.gunmetal, mesh: body.build('receiver') },
    { name: 'barrel', material: WeaponMaterials.gunmetal, mesh: barrel.build('barrel') },
    { name: 'boxMagazine', material: WeaponMaterials.gunmetal, mesh: boxMag.build('boxMagazine'), pivot: new Vector3(0, 0.05, 0), animate: 'magazine' },
    { name: 'stock', material: WeaponMaterials.polymer, mesh: stock.build('stock') },
    { name: 'grip', material: WeaponMaterials.polymer, mesh: grip.build('grip') },
    { name: 'bipod', material: WeaponMaterials.gunmetal, mesh: bipod.build('bipod') },
    { name: 'trigger', material: WeaponMaterials.gunmetal, mesh: trigger.build('trigger'), pivot: new Vector3(0, -0.03, 0.05), animate: 'trigger' },
  ];
  return makeModel('LMG', parts, {
    muzzle: new Vector3(0, 0.014, -0.71),
    ejectionPort: new Vector3(0.045, 0.02, -0.05),
    adsSight: new Vector3(0, 0.078, -0.06),
    shellEjectDir: new Vector3(1, 0.5, 0.4).normalize(),
    hipPivot: new Vector3(0, -0.06, 0.14),
    length: 1.0,
  });
}

/** Combat knife — melee fallback, always available. */
export function createKnife() {
  const blade = new PartBuilder();
  const handle = new PartBuilder();
  const guard = new PartBuilder();
  blade.box(0.008, 0.032, 0.19, 0, 0, -0.13);
  blade.wedge(0.008, 0.032, 0.06, 0, 0, -0.25);
  blade.box(0.01, 0.012, 0.16, 0, 0.02, -0.12);   // spine
  for (let i = 0; i < 5; i++) blade.box(0.012, 0.004, 0.02, 0, -0.014, -0.07 - i * 0.028);
  handle.box(0.026, 0.032, 0.11, 0, -0.004, 0.0);
  handle.box(0.03, 0.036, 0.012, 0, -0.004, -0.058);
  handle.box(0.03, 0.036, 0.012, 0, -0.004, 0.056);
  for (let i = 0; i < 5; i++) handle.box(0.028, 0.034, 0.008, 0, -0.004, -0.04 + i * 0.02);
  guard.box(0.03, 0.014, 0.024, 0, -0.012, -0.062);
  const parts = [
    { name: 'blade', material: WeaponMaterials.gunmetal, mesh: blade.build('blade') },
    { name: 'handle', material: WeaponMaterials.polymer, mesh: handle.build('handle') },
    { name: 'guard', material: WeaponMaterials.gunmetal, mesh: guard.build('guard') },
  ];
  return makeModel('Knife', parts, {
    muzzle: new Vector3(0, 0, -0.28),
    ejectionPort: new Vector3(0, 0, 0),
    adsSight: new Vector3(0, 0.02, -0.1),
    shellEjectDir: new Vector3(0, 1, 0),
    hipPivot: new Vector3(0, -0.04, 0.04),
    length: 0.34,
    melee: true,
  });
}

/** Frag grenade (thrown projectile). */
export function createGrenade() {
  const body = new PartBuilder();
  const top = new PartBuilder();
  const lever = new PartBuilder();
  const sphere = sphereMesh(0.048, 16, 12);
  sphere.scaleMesh(1, 1.25, 1);
  body.mesh.merge(sphere);
  for (let i = 0; i < 6; i++) {
    const a = (i / 6) * Math.PI * 2;
    body.box(0.006, 0.09, 0.09, Math.cos(a) * 0.046, 0, Math.sin(a) * 0.046, 0, a, 0);
  }
  top.cylinder(0.02, 0.03, 0, 0.062, 0, 'y', 12);
  top.box(0.03, 0.02, 0.03, 0, 0.078, 0);
  lever.box(0.008, 0.06, 0.02, 0.026, 0.05, 0.0);
  lever.box(0.008, 0.02, 0.05, 0.026, 0.078, -0.02);
  const parts = [
    { name: 'body', material: WeaponMaterials.gunmetal, mesh: body.build('body') },
    { name: 'fuze', material: WeaponMaterials.accent, mesh: top.build('fuze') },
    { name: 'lever', material: WeaponMaterials.gunmetal, mesh: lever.build('lever') },
  ];
  return makeModel('Grenade', parts, {
    muzzle: new Vector3(0, 0, -0.05), ejectionPort: new Vector3(0, 0, 0),
    adsSight: new Vector3(0, 0.05, 0), shellEjectDir: new Vector3(0, 1, 0),
    hipPivot: new Vector3(0, -0.03, 0.03), length: 0.12, throwable: true,
  });
}

/** Thrown throwing knife — silent one-hit kill. */
export function createThrowingKnife() {
  const b = new PartBuilder();
  b.box(0.006, 0.028, 0.14, 0, 0, -0.02);
  b.wedge(0.006, 0.028, 0.05, 0, 0, -0.115);
  b.box(0.014, 0.014, 0.05, 0, 0, 0.055);
  b.tube(0.008, 0.004, 0.012, 0, 0, 0.085, 'z', 8);
  const parts = [{ name: 'blade', material: WeaponMaterials.gunmetal, mesh: b.build('blade') }];
  return makeModel('ThrowingKnife', parts, {
    muzzle: new Vector3(0, 0, -0.1), ejectionPort: new Vector3(0, 0, 0),
    adsSight: new Vector3(0, 0.01, 0), shellEjectDir: new Vector3(0, 1, 0),
    hipPivot: new Vector3(0, 0, 0.02), length: 0.18, throwable: true,
  });
}

/** First-person hand (attached to the player when unarmed / holding a grenade). */
export function createHand() {
  const b = new PartBuilder();
  b.box(0.085, 0.05, 0.13, 0, 0, -0.02);
  for (let i = 0; i < 4; i++) {
    b.box(0.019, 0.024, 0.055, -0.032 + i * 0.021, 0.004, -0.10);
    b.box(0.018, 0.02, 0.03, -0.032 + i * 0.021, -0.002, -0.14);
  }
  b.box(0.022, 0.024, 0.05, 0.038, -0.004, -0.05);
  b.box(0.022, 0.018, 0.03, 0.05, -0.01, -0.085);
  b.box(0.06, 0.03, 0.05, 0, -0.01, 0.045);
  return new MeshModel('Hand', [{ name: 'hand', material: 'PlayerSkin', mesh: b.build('hand') }], {
    muzzle: new Vector3(0, 0, -0.16), adsSight: new Vector3(0, 0, -0.1),
    hipPivot: new Vector3(0, -0.03, 0.05), length: 0.2,
  });
}

// ---------------------------------------------------------------------------
// Model assembly
// ---------------------------------------------------------------------------
function makeModel(name, parts, anchors) {
  const merged = new Mesh({ name });
  for (const p of parts) merged.merge(p.mesh);
  return new MeshModel(name, parts, anchors, merged);
}

export class MeshModel {
  constructor(name, parts, anchors, merged = null) {
    this.name = name;
    this.parts = parts;
    this.anchors = {
      muzzle: anchors.muzzle ?? new Vector3(0, 0, -0.5),
      ejectionPort: anchors.ejectionPort ?? new Vector3(0.03, 0.02, 0),
      adsSight: anchors.adsSight ?? new Vector3(0, 0.06, -0.05),
      shellEjectDir: anchors.shellEjectDir ?? new Vector3(1, 0.6, 0.3).normalize(),
      hipPivot: anchors.hipPivot ?? new Vector3(0, -0.05, 0.1),
    };
    this.length = anchors.length ?? 0.6;
    this.flags = {
      boltAction: !!anchors.boltAction,
      shellByShell: !!anchors.shellByShell,
      melee: !!anchors.melee,
      throwable: !!anchors.throwable,
    };
    this._merged = merged;
  }
  get partNames() { return this.parts.map((p) => p.name); }
  get animes() { return this.parts.filter((p) => p.animate).map((p) => p.animate); }
  getPart(name) { return this.parts.find((p) => p.name === name); }
  /** Whole model as one mesh (used for bots' world-model weapons and LODs). */
  get merged() {
    if (!this._merged) {
      const m = new Mesh({ name: this.name });
      for (const p of this.parts) m.merge(p.mesh);
      this._merged = m;
    }
    return this._merged;
  }
  get triangleCount() { return this._merged ? this._merged.triangleCount : this.parts.reduce((s, p) => s + p.mesh.triangleCount, 0); }
  clone() { return new MeshModel(this.name, this.parts, this.anchors, this._merged); }
}

export const WeaponFactory = {
  rifle: createRifle,
  pistol: createPistol,
  smg: createSMG,
  shotgun: createShotgun,
  sniper: createSniper,
  lmg: createLMG,
  knife: createKnife,
  grenade: createGrenade,
  throwingKnife: createThrowingKnife,
  hand: createHand,
};
export function createWeaponModel(kind) {
  const fn = WeaponFactory[kind] ?? WeaponFactory.rifle;
  return fn();
}
export default WeaponFactory;
