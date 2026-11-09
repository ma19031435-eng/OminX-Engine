/**
 * OminX Engine — weapons, ballistics data and the weapon state machine.
 *
 * Written for a modern military shooter: per-weapon recoil *patterns* (not random kick), spread
 * that grows while firing and decays when you stop, ADS with its own spread/turn-rate profile,
 * burst and single fire modes, magazines with reload cancel windows, attachments that rewrite
 * stats, hit zones (head/torso/limb) with damage falloff, projectiles with travel time and
 * drop for launchers/snipers, shell ejection, tracers, dry fire, and melee with an arc test.
 *
 * Everything is data-driven: `WeaponLibrary.rifle()` returns a definition other systems read
 * (ballistics, HUD, AI, netcode replication), so a new gun is a table entry, not code.
 *
 * @module engine/src/gameplay/Weapons.js
 */
import { Vector3 } from '../math/Vector3.js';
import { RNG } from '../math/Random.js';
import { Signal } from '../core/Signal.js';
import { clamp, clamp01, lerp, DEG2RAD, RAD2DEG } from '../math/MathUtils.js';

/** Weapon classes — drive ammo pools, movement penalties and AI behaviour. */
export const WeaponClass = {
  Rifle: 'rifle',
  SMG: 'smg',
  Shotgun: 'shotgun',
  Sniper: 'sniper',
  Pistol: 'pistol',
  LMG: 'lmg',
  Launcher: 'launcher',
  Melee: 'melee',
  Grenade: 'grenade',
};

/** Fire modes. */
export const FireMode = { Single: 'single', Burst: 'burst', Auto: 'auto', Charge: 'charge' };

/** Ammo pools shared between weapons of the same class family. */
export const AmmoType = {
  Light: 'light',     // SMG / pistol
  Medium: 'medium',   // assault rifles
  Heavy: 'heavy',     // LMG
  Shell: 'shell',     // shotgun
  Sniper: 'sniper',   // bolt-action / DMR
  Rocket: 'rocket',   // launchers
  Grenade: 'grenade',
};

/**
 * Generates a deterministic recoil pattern: the vertical climb slows after the first few shots
 * and the horizontal drift follows a sign-flipping sweep, which is what makes a spray
 * *learnable*. Seeded so every client and the server agree shot-for-shot.
 */
export function generateRecoilPattern(seed, shots, { vertical = 0.9, growth = 0.055, horizontal = 0.34, drift = 2.6, flipEvery = 4, jitter = 0.12 } = {}) {
  const rng = new RNG(seed);
  const pattern = [];
  let sideSign = rng.chance(0.5) ? 1 : -1;
  let side = 0;
  for (let i = 0; i < shots; i++) {
    // Vertical: strong initial kick, gently increasing with each shot.
    const up = vertical * (1 + i * growth) * (1 + rng.nextNumber(-jitter, jitter) * 0.35);
    if (i > 0 && i % flipEvery === 0) sideSign *= -1;
    side = lerp(side, sideSign * horizontal * (1 + i * 0.12), 1 / drift);
    pattern.push({ up, side: side * (1 + rng.nextNumber(-jitter, jitter)), index: i });
  }
  return pattern;
}

/** Attachment slots and their stat effects. */
export const AttachmentSlot = { Muzzle: 'muzzle', Optic: 'optic', Grip: 'grip', Magazine: 'magazine', Laser: 'laser', Stock: 'stock', Barrel: 'barrel' };

/**
 * Attachment catalogue.
 *
 * `mods` values are **fractions** (0.4 = +40 %, -0.06 = −6 %) except the flags `sightClean`,
 * `scope`, `thermal`, `laser`, `glint`, `visible` and `nightVisionOnly`.
 *
 * Sign convention: for damage/velocity/range/magazine/recoil/spread, positive = better. For the
 * time stats (`adsTime`, `equipTime`, `reloadTime`), positive = **faster** (the value is applied
 * as `time /= (1 + mod)`), so `fastMag` is `reloadTime: 0.22` and a heavy optic is negative.
 *
 * Compatibility is a weapon-class list plus an optional per-weapon allow list.
 */
export const AttachmentLibrary = {
  compensator: { id: 'compensator', name: 'Compensator', slot: AttachmentSlot.Muzzle, classes: ['rifle', 'smg', 'lmg'], mods: { recoilVertical: -0.18, recoilHorizontal: -0.12, spreadPerShot: -0.1, muzzleFlash: -0.25, adsSpeed: -0.03 } },
  suppressor: { id: 'suppressor', name: 'Suppressor', slot: AttachmentSlot.Muzzle, classes: ['rifle', 'smg', 'pistol', 'sniper'], mods: { damage: -0.06, muzzleVelocity: -0.08, recoilVertical: -0.06, soundRadius: -0.55, muzzleFlash: -0.9, spreadPerShot: -0.05 } },
  muzzleBrake: { id: 'muzzleBrake', name: 'Muzzle Brake', slot: AttachmentSlot.Muzzle, classes: ['sniper', 'lmg'], mods: { recoilVertical: -0.22, adsSpeed: -0.05, soundRadius: 0.15, muzzleFlash: -0.35 } },
  monolithic: { id: 'monolithic', name: 'Monolithic Suppressor', slot: AttachmentSlot.Muzzle, classes: ['sniper', 'rifle'], mods: { damage: -0.03, muzzleVelocity: -0.05, soundRadius: -0.65, adsSpeed: -0.06, recoilVertical: -0.08 } },
  reflexSight: { id: 'reflexSight', name: 'Reflex Sight', slot: AttachmentSlot.Optic, classes: ['rifle', 'smg', 'pistol', 'lmg', 'shotgun'], mods: { adsSpeed: -0.04, adsZoom: 0.0, sightClean: 1 } },
  holoSight: { id: 'holoSight', name: 'Holographic Sight', slot: AttachmentSlot.Optic, classes: ['rifle', 'smg', 'lmg'], mods: { adsSpeed: -0.06, adsZoom: 0.05, sightClean: 1 } },
  acog4x: { id: 'acog4x', name: '4x ACOG', slot: AttachmentSlot.Optic, classes: ['rifle', 'lmg', 'sniper'], mods: { adsZoom: 0.75, adsSpeed: -0.18, adsSensitivity: -0.15, spreadAim: -0.12, scope: 1 } },
  scope8x: { id: 'scope8x', name: '8x Scope', slot: AttachmentSlot.Optic, classes: ['sniper'], mods: { adsZoom: 2.0, adsSpeed: -0.3, adsSensitivity: -0.4, scope: 1, glint: true } },
  thermal: { id: 'thermal', name: 'Thermal Scope', slot: AttachmentSlot.Optic, classes: ['sniper', 'lmg'], mods: { adsZoom: 1.4, adsSpeed: -0.35, thermal: true, glint: true } },
  verticalGrip: { id: 'verticalGrip', name: 'Vertical Grip', slot: AttachmentSlot.Grip, classes: ['rifle', 'smg', 'lmg'], mods: { recoilVertical: -0.14, spreadMove: -0.12, adsSpeed: -0.03 } },
  angledGrip: { id: 'angledGrip', name: 'Angled Grip', slot: AttachmentSlot.Grip, classes: ['rifle', 'smg'], mods: { adsSpeed: 0.12, recoilHorizontal: -0.1, spreadHip: -0.05 } },
  bipod: { id: 'bipod', name: 'Bipod', slot: AttachmentSlot.Grip, classes: ['lmg', 'sniper'], mods: { proneRecoil: -0.5, proneSpread: -0.45, adsSpeed: -0.08 } },
  extendedMag: { id: 'extendedMag', name: 'Extended Magazine', slot: AttachmentSlot.Magazine, classes: ['rifle', 'smg', 'pistol', 'lmg'], mods: { magazineSize: 0.4, reloadTime: -0.06, moveSpeed: -0.02 } },
  fastMag: { id: 'fastMag', name: 'Fast Magazine', slot: AttachmentSlot.Magazine, classes: ['rifle', 'smg', 'pistol', 'shotgun'], mods: { reloadTime: 0.22 } },
  lightweightMag: { id: 'lightweightMag', name: 'Lightweight Magazine', slot: AttachmentSlot.Magazine, classes: ['rifle', 'lmg'], mods: { magazineSize: -0.1, adsSpeed: 0.1, moveSpeed: 0.03 } },
  laserTactical: { id: 'laserTactical', name: 'Tactical Laser', slot: AttachmentSlot.Laser, classes: ['pistol', 'smg', 'rifle'], mods: { spreadHip: -0.22, laser: '#ff3b3b', adsSpeed: 0.05, visible: true } },
  laserIr: { id: 'laserIr', name: 'IR Laser', slot: AttachmentSlot.Laser, classes: ['rifle', 'smg', 'pistol'], mods: { spreadHip: -0.26, laser: '#7dff7d', nightVisionOnly: true } },
  heavyStock: { id: 'heavyStock', name: 'Heavy Stock', slot: AttachmentSlot.Stock, classes: ['rifle', 'lmg', 'sniper'], mods: { recoilVertical: -0.12, recoilRecovery: 0.15, adsSpeed: -0.12, moveSpeed: -0.03 } },
  skeletonStock: { id: 'skeletonStock', name: 'Skeleton Stock', slot: AttachmentSlot.Stock, classes: ['rifle', 'smg'], mods: { adsSpeed: 0.14, recoilRecovery: -0.05, moveSpeed: 0.02 } },
  longBarrel: { id: 'longBarrel', name: 'Long Barrel', slot: AttachmentSlot.Barrel, classes: ['rifle', 'sniper', 'lmg'], mods: { range: 0.2, muzzleVelocity: 0.15, adsSpeed: -0.08, spreadMove: -0.05 } },
  shortBarrel: { id: 'shortBarrel', name: 'Short Barrel', slot: AttachmentSlot.Barrel, classes: ['rifle', 'smg', 'shotgun'], mods: { range: -0.12, adsSpeed: 0.12, moveSpeed: 0.04, spreadMove: 0.08, muzzleFlash: 0.2 } },
  breacher: { id: 'breacher', name: 'Breacher Choke', slot: AttachmentSlot.Barrel, classes: ['shotgun'], mods: { spreadHip: -0.2, range: 0.15, adsSpeed: -0.05 } },
};

/**
 * Applies attachments to a weapon definition, returning a new definition. Multipliers are
 * additive (`damage: -0.06` = −6 %) and clamped so no attachment combo can break the gun.
 */
export function applyAttachments(definition, attachmentIds = []) {
  // Deep-copy the mutable sub-objects: writing through a shallow copy would mutate the shared
  // library definition, so attaching a compensator to one weapon would buff every rifle.
  const out = {
    ...definition,
    mods: { ...definition.mods },
    recoil: { ...definition.recoil },
    audio: { ...definition.audio },
    attachments: [],
  };
  const applied = [];
  for (const id of attachmentIds) {
    const attachment = typeof id === 'string' ? AttachmentLibrary[id] : id;
    if (!attachment) continue;
    if (attachment.classes && !attachment.classes.includes(definition.class)) continue;
    if (attachment.weapons && !attachment.weapons.includes(definition.id)) continue;
    applied.push(attachment);
    for (const [key, value] of Object.entries(attachment.mods)) {
      if (typeof value !== 'number') { out.mods[key] = value; continue; }
      out.mods[key] = (out.mods[key] ?? 0) + value;
    }
  }
  const m = out.mods;
  const scale = (stat, key, min = -Infinity, max = Infinity) => {
    if (!m[key]) return;
    out[stat] = clamp(out[stat] * (1 + m[key]), min, max);
  };
  const faster = (stat, key, min) => {
    if (!m[key]) return;
    out[stat] = Math.max(min, out[stat] / (1 + m[key]));
  };

  scale('damage', 'damage', 1);
  scale('muzzleVelocity', 'muzzleVelocity', 60);
  scale('range', 'range', 8);
  scale('spreadPerShot', 'spreadPerShot');
  scale('moveSpeedScale', 'moveSpeed', 0.75, 1.08);
  scale('soundRadius', 'soundRadius', 20);
  scale('muzzleFlashScale', 'muzzleFlash', 0.05, 1.8);
  faster('reloadTime', 'reloadTime', 0.35);
  faster('adsTime', 'adsSpeed', 0.05);
  faster('equipTime', 'adsSpeed', 0.1);
  if (m.magazineSize) out.magazineSize = Math.max(1, Math.round(definition.magazineSize * (1 + m.magazineSize)));
  if (m.adsZoom) out.adsZoom = Math.max(1, out.adsZoom * (1 + m.adsZoom));
  out.recoil.vertical = clamp(out.recoil.vertical * (1 + (m.recoilVertical ?? 0)), 0.02, 12);
  out.recoil.horizontal = clamp(out.recoil.horizontal * (1 + (m.recoilHorizontal ?? 0)), 0.02, 12);
  out.recoil.recovery = clamp(out.recoil.recovery * (1 + (m.recoilRecovery ?? 0)), 0.5, 20);
  if (m.spreadHip || m.spreadMove || m.spreadAim) {
    out.baseSpread = Math.max(0.0008, out.baseSpread * (1 + (m.spreadHip ?? 0) * 0.6 + (m.spreadMove ?? 0) * 0.2 + (m.spreadAim ?? 0) * 0.2));
    out.moveSpread = Math.max(0.001, out.moveSpread * (1 + (m.spreadMove ?? 0)));
    out.adsSpread = Math.max(0.0004, out.adsSpread * (1 + (m.spreadAim ?? 0)));
  }
  out.attachments = applied.map((a) => a.id);
  if (applied.some((a) => a.mods.scope)) out.scopeOverlay = true;
  if (applied.some((a) => a.mods.glint)) out.scopeGlint = true;
  if (applied.some((a) => a.mods.sightClean)) out.sightClean = true;
  if (applied.some((a) => a.mods.thermal)) out.thermal = true;
  const laser = applied.find((a) => a.mods.laser);
  if (laser) { out.laser = laser.mods.laser; out.laserNightVisionOnly = !!laser.mods.nightVisionOnly; }
  if (m.damage) out.damage = Math.round(out.damage);
  // Rebuild the recoil pattern from the modified stats so spray patterns stay consistent.
  out.recoilPattern = generateRecoilPattern(definition.seed ?? hashString(definition.id), 40, {
    vertical: out.recoil.vertical,
    horizontal: out.recoil.horizontal,
    growth: out.recoil.growth,
  });
  return out;
}

function hashString(text) {
  let h = 2166136261;
  for (let i = 0; i < text.length; i++) { h ^= text.charCodeAt(i); h = Math.imul(h, 16777619); }
  return (h >>> 0) % 100000;
}

/** Base fields every weapon definition shares (so partial tables stay readable). */
const WeaponDefaults = {
  class: WeaponClass.Rifle,
  ammoType: AmmoType.Medium,
  fireModes: [FireMode.Auto],
  burstCount: 3,
  burstDelay: 0.16,
  damage: 30,
  headshotMultiplier: 2.6,
  limbMultiplier: 0.85,
  range: 120,
  falloffStart: 45,
  falloffEnd: 110,
  minDamageScale: 0.62,
  pellets: 1,
  projectiles: 0,
  projectileSpeed: 0,
  projectileDrop: 0,
  penetration: 0.55,
  magazineSize: 30,
  reserveAmmo: 180,
  rpm: 700,
  reloadTime: 2.1,
  reloadEmptyTime: 2.6,
  reloadFinishWindow: 0.45,     // fraction of the reload that can still be cancelled
  adsTime: 0.32,
  adsSpread: 0.0012,
  adsZoom: 1.0,
  spread: 0.02,
  baseSpread: 0.0075,           // radians at rest, hipfire
  moveSpread: 0.02,             // added at full speed
  airSpread: 0.055,
  crouchSpreadScale: 0.7,
  proneSpreadScale: 0.5,
  spreadPerShot: 0.0022,
  maxSpread: 0.075,
  spreadDecay: 0.055,           // radians per second
  firstShotAccuracy: 0.35,      // scale applied to the first shot after settling
  recoil: { vertical: 0.9, horizontal: 0.34, growth: 0.055, recovery: 5.2, visKick: 0.4, adsScale: 0.62 },
  muzzleVelocity: 780,
  tracerEvery: 3,
  soundRadius: 260,
  equipTime: 0.62,
  holsterTime: 0.42,
  meleeRange: 0,
  moveSpeedScale: 1,
  hipFire: true,
  adsAllowed: true,
  worldModel: 'rifle',
  viewModel: 'rifle',
  icon: 'rifle',
  audio: { fire: 'fire_rifle', reload: 'reload_rifle', equip: 'equip_rifle', dry: 'dryfire', shell: 'shell_drop' },
  shellEject: true,
  suppressed: false,
  thermal: false,
  scopeOverlay: false,
  scopeGlint: false,
  tags: [],
  mods: {},
};

/** Builds a complete weapon definition from a partial table entry. */
export function defineWeapon(def) {
  const merged = { ...WeaponDefaults, ...def, recoil: { ...WeaponDefaults.recoil, ...(def.recoil ?? {}) }, audio: { ...WeaponDefaults.audio, ...(def.audio ?? {}) }, audio2: undefined };
  merged.seed = merged.seed ?? hashString(merged.id ?? merged.name ?? 'weapon');
  merged.cycleTime = 60 / merged.rpm;
  merged.recoilPattern = merged.recoilPattern ?? generateRecoilPattern(merged.seed, 40, { vertical: merged.recoil.vertical, horizontal: merged.recoil.horizontal, growth: merged.recoil.growth });
  merged.maxRange = merged.range;
  return merged;
}

/**
 * The weapon catalogue. Numbers are tuned against the shared movement/ballistics model so the
 * classes feel distinct: SMGs win up close, ARs are the default, snipers own the long lanes,
 * shotguns clear rooms, LMGs suppress and launchers remove cover.
 */
export const WeaponLibrary = {
  rifle: () => defineWeapon({
    id: 'rifle', name: 'AR-15 "Vector"', class: WeaponClass.Rifle, ammoType: AmmoType.Medium,
    damage: 33, rpm: 640, magazineSize: 30, reserveAmmo: 210,
    fireModes: [FireMode.Auto, FireMode.Single],
    adsTime: 0.29, adsSpread: 0.001, adsZoom: 1.6,
    spreadPerShot: 0.0026, maxSpread: 0.062, projectiles: 0, muzzleVelocity: 880, penetration: 0.7,
    audio: { fire: 'fire_rifle', reload: 'reload_rifle', equip: 'equip_rifle' },
    tags: ['assault', 'standard'],
  }),
  carbine: () => defineWeapon({
    id: 'carbine', name: 'MK18 Carbine', class: WeaponClass.Rifle, ammoType: AmmoType.Medium,
    damage: 28, rpm: 780, magazineSize: 30, reserveAmmo: 180, range: 90, falloffStart: 32,
    adsTime: 0.24, moveSpeedScale: 1.03,
    baseSpread: 0.0085, spreadPerShot: 0.003, maxSpread: 0.07, penetration: 0.66,
    tags: ['closeQuarters'],
  }),
  smg: () => defineWeapon({
    id: 'smg', name: 'MP-9 "Wasp"', class: WeaponClass.SMG, ammoType: AmmoType.Light,
    damage: 22, rpm: 900, magazineSize: 32, reserveAmmo: 256, range: 70, falloffStart: 22, falloffEnd: 60,
    adsTime: 0.21, adsZoom: 1.35, moveSpeedScale: 1.05,
    baseSpread: 0.0105, spreadPerShot: 0.0021, maxSpread: 0.08, penetration: 0.5, recoil: { vertical: 0.62, horizontal: 0.42, recovery: 6.4 },
    tags: ['closeQuarters'],
  }),
  shotgun: () => defineWeapon({
    id: 'shotgun', name: 'B-12 Breacher', class: WeaponClass.Shotgun, ammoType: AmmoType.Shell,
    damage: 18, pellets: 9, spread: 0.055, rpm: 75, magazineSize: 8, reserveAmmo: 40,
    range: 22, falloffStart: 6, falloffEnd: 18, minDamageScale: 0.25,
    fireModes: [FireMode.Single], adsTime: 0.35, adsZoom: 1.1, penetration: 0.3,
    spreadPerShot: 0.004, maxSpread: 0.09, recoil: { vertical: 1.9, horizontal: 0.5, recovery: 3.2, visKick: 0.9 },
    reloadTime: 2.9, reloadEmptyTime: 3.6, audio: { fire: 'fire_shotgun', reload: 'reload_shotgun', equip: 'equip_shotgun' },
    tags: ['closeQuarters', 'breach'],
  }),
  sniper: () => defineWeapon({
    id: 'sniper', name: 'AX-50 Bolt', class: WeaponClass.Sniper, ammoType: AmmoType.Sniper,
    damage: 96, headshotMultiplier: 2.1, limbMultiplier: 0.75, rpm: 46, magazineSize: 5, reserveAmmo: 30,
    fireModes: [FireMode.Single], adsTime: 0.52, adsSpread: 0.0002, adsZoom: 4.5, scopeOverlay: true,
    range: 400, falloffStart: 260, falloffEnd: 400, minDamageScale: 0.85, penetration: 0.95,
    projectiles: 1, projectileSpeed: 820, projectileDrop: 0.65, muzzleVelocity: 820,
    moveSpeedScale: 0.92, baseSpread: 0.028, spreadPerShot: 0.01, maxSpread: 0.1, spreadDecay: 0.09,
    recoil: { vertical: 3.4, horizontal: 0.3, recovery: 2.2, visKick: 1.6 },
    reloadTime: 3.1, reloadEmptyTime: 3.6, scopeGlint: true,
    audio: { fire: 'fire_sniper', reload: 'reload_sniper', equip: 'equip_rifle' },
    tags: ['precision', 'longRange'],
  }),
  dmr: () => defineWeapon({
    id: 'dmr', name: 'M-14 DMR', class: WeaponClass.Sniper, ammoType: AmmoType.Sniper,
    damage: 58, rpm: 200, magazineSize: 12, reserveAmmo: 60, adsTime: 0.42, adsZoom: 3.2, adsSpread: 0.0006,
    fireModes: [FireMode.Single], range: 300, falloffStart: 180, minDamageScale: 0.8, penetration: 0.85,
    projectiles: 1, projectileSpeed: 900, projectileDrop: 0.35,
    recoil: { vertical: 2.1, horizontal: 0.35, recovery: 3.0, visKick: 1.0 }, scopeGlint: true,
    tags: ['precision'],
  }),
  lmg: () => defineWeapon({
    id: 'lmg', name: 'PKM Support', class: WeaponClass.LMG, ammoType: AmmoType.Heavy,
    damage: 38, rpm: 620, magazineSize: 100, reserveAmmo: 200, adsTime: 0.58, adsZoom: 1.5,
    moveSpeedScale: 0.86, baseSpread: 0.016, spreadPerShot: 0.002, maxSpread: 0.09, spreadDecay: 0.045,
    penetration: 0.8, reloadTime: 5.2, reloadEmptyTime: 6.0,
    recoil: { vertical: 1.15, horizontal: 0.75, recovery: 4.0 },
    audio: { fire: 'fire_lmg', reload: 'reload_lmg', equip: 'equip_lmg' },
    tags: ['suppression'],
  }),
  pistol: () => defineWeapon({
    id: 'pistol', name: 'P-19 Sidearm', class: WeaponClass.Pistol, ammoType: AmmoType.Light,
    damage: 26, rpm: 420, magazineSize: 15, reserveAmmo: 90, range: 60, falloffStart: 20, falloffEnd: 50,
    fireModes: [FireMode.Single], adsTime: 0.19, adsZoom: 1.2, moveSpeedScale: 1.06,
    equipTime: 0.4, holsterTime: 0.28, baseSpread: 0.012, spreadPerShot: 0.0035, penetration: 0.45,
    recoil: { vertical: 0.85, horizontal: 0.3, recovery: 6.5, visKick: 0.5 },
    reloadTime: 1.55, reloadEmptyTime: 2.15, audio: { fire: 'fire_pistol', reload: 'reload_pistol', equip: 'equip_pistol' },
    tags: ['sidearm'],
  }),
  machinePistol: () => defineWeapon({
    id: 'machinePistol', name: 'G-18 Machine Pistol', class: WeaponClass.Pistol, ammoType: AmmoType.Light,
    damage: 18, rpm: 1100, magazineSize: 20, reserveAmmo: 120, adsTime: 0.18,
    fireModes: [FireMode.Auto, FireMode.Single], baseSpread: 0.018, spreadPerShot: 0.0032, maxSpread: 0.095, penetration: 0.4,
    recoil: { vertical: 0.7, horizontal: 0.55, recovery: 7.0 }, equipTime: 0.35,
    tags: ['sidearm', 'closeQuarters'],
  }),
  knife: () => defineWeapon({
    id: 'knife', name: 'Combat Knife', class: WeaponClass.Melee, ammoType: AmmoType.Grenade,
    damage: 55, backstabDamage: 200, headshotMultiplier: 1.6, rpm: 120, magazineSize: 0, reserveAmmo: 0,
    fireModes: [FireMode.Single], meleeRange: 2.1, meleeArc: 0.7, adsAllowed: false, hipFire: true,
    equipTime: 0.3, holsterTime: 0.2, moveSpeedScale: 1.12, penetration: 0,
    audio: { fire: 'melee_swing', reload: 'none', equip: 'equip_knife' },
    tags: ['melee'],
  }),
  launcher: () => defineWeapon({
    id: 'launcher', name: 'RPG-9', class: WeaponClass.Launcher, ammoType: AmmoType.Rocket,
    damage: 130, splashRadius: 6.5, splashDamage: 110, rpm: 30, magazineSize: 1, reserveAmmo: 3,
    fireModes: [FireMode.Single], adsTime: 0.7, adsZoom: 1.0, hipFire: true, adsSpread: 0.004,
    projectiles: 1, projectileSpeed: 72, projectileDrop: 3.2, rockets: true, penetration: 0,
    moveSpeedScale: 0.9, equipTime: 0.9, reloadTime: 4.2, reloadEmptyTime: 4.6,
    recoil: { vertical: 4.5, horizontal: 0.4, recovery: 1.6, visKick: 2.2 },
    audio: { fire: 'fire_launcher', reload: 'reload_launcher', equip: 'equip_launcher' },
    tags: ['explosive', 'antiVehicle'],
  }),
  grenadeLauncher: () => defineWeapon({
    id: 'grenadeLauncher', name: 'M-32 Grenade Launcher', class: WeaponClass.Launcher, ammoType: AmmoType.Rocket,
    damage: 40, splashRadius: 4.5, splashDamage: 95, rpm: 90, magazineSize: 6, reserveAmmo: 12,
    fireModes: [FireMode.Single], projectiles: 1, projectileSpeed: 76, projectileDrop: 2.4, rockets: false,
    bounce: 0.35, fuse: 1.4, adsTime: 0.45, penetration: 0,
    recoil: { vertical: 1.6, horizontal: 0.3, recovery: 3.0, visKick: 1.2 },
    tags: ['explosive'],
  }),
};

/** Grenade types thrown by `WeaponSystem` (not fired as weapons). */
export const GrenadeLibrary = {
  frag: { id: 'frag', name: 'Frag Grenade', damage: 120, splashRadius: 6.5, fuse: 3.4, bounce: 0.45, friction: 0.7, mass: 0.4, cookable: true, ai_attraction: 3, audio: 'grenade_frag', tags: ['lethal'] },
  semtex: { id: 'semtex', name: 'Semtex', damage: 130, splashRadius: 6, fuse: 2.6, sticky: true, bounce: 0.05, mass: 0.4, ai_attraction: 3, audio: 'grenade_semtex', tags: ['lethal'] },
  smoke: { id: 'smoke', name: 'Smoke Grenade', damage: 0, radius: 5.5, fuse: 1.2, duration: 14, bounce: 0.5, mass: 0.5, blocksVision: true, audio: 'grenade_smoke', tags: ['tactical'] },
  flash: { id: 'flash', name: 'Flashbang', damage: 5, radius: 9, fuse: 1.8, duration: 3.2, blindIntensity: 0.95, bounce: 0.5, mass: 0.35, audio: 'grenade_flash', tags: ['tactical'] },
  gas: { id: 'gas', name: 'Tear Gas', damage: 18, radius: 5, fuse: 1.0, duration: 9, dotPerSecond: 4, bounce: 0.4, mass: 0.5, audio: 'grenade_gas', tags: ['tactical'] },
  emp: { id: 'emp', name: 'EMP Grenade', damage: 0, radius: 8, fuse: 1.4, duration: 6, disableElectronics: true, bounce: 0.4, mass: 0.4, audio: 'grenade_emp', tags: ['tactical'] },
  incendiary: { id: 'incendiary', name: 'Incendiary', damage: 20, radius: 4.5, fuse: 1.0, duration: 8, dotPerSecond: 12, bounce: 0.15, mass: 0.5, audio: 'grenade_fire', tags: ['lethal'] },
};

/**
 * Persistent state of one weapon held by one actor.
 *
 * The weapon itself is dumb data + a state machine: `update(dt)` ticks the fire/reload timers
 * and emits signals (`Fired`, `Reloaded`, `DryFire`, …) that ballistics, audio, animation and
 * netcode listen to. That keeps weapon logic testable headlessly.
 */
export class Weapon {
  /**
   * @param {object} definition weapon definition (plain or attachment-modified)
   * @param {object} [opts] { owner, attachments, ammoInMagazine, reserve }
   */
  constructor(definition, opts = {}) {
    this.definition = definition;
    this.id = definition.id;
    this.name = definition.name;
    this.class = definition.class;
    this.owner = opts.owner ?? null;
    this.attachments = opts.attachments ?? definition.attachments ?? [];

    this.ammo = opts.ammoInMagazine ?? definition.magazineSize;
    this.reserve = opts.reserve ?? definition.reserveAmmo;
    this.fireTimer = 0;
    this.burstRemaining = 0;
    this.burstTimer = 0;
    this.reloading = false;
    this.reloadTimer = 0;
    this.reloadDuration = definition.reloadTime;
    this.reloadCancelable = true;
    this.chargeTime = 0;
    this.charge = 0;
    this.triggerHeld = false;
    this.triggerReady = true;         // single/burst modes need a release before the next shot
    this.shotsInBurst = 0;
    this.spread = definition.baseSpread;
    this.recoilIndex = 0;
    this.recoilRecoveryTimer = 0;
    this.lastFireTime = -Infinity;
    this.lastShotTime = -Infinity;
    this.cooledDown = true;          // true once spread/recoil fully recovered (first-shot accuracy)
    this.heat = 0;                   // LMG barrel heat (visual + spread penalty)
    this.adsBlend = 0;
    this.lastShot = null;
    this.totalShots = 0;
    this.grenades = opts.grenades ?? { frag: 1, smoke: 1 };

    this.Fired = new Signal('Weapon.Fired');
    this.DryFire = new Signal('Weapon.DryFire');
    this.ReloadStarted = new Signal('Weapon.ReloadStarted');
    this.ReloadFinished = new Signal('Weapon.ReloadFinished');
    this.BurstTick = new Signal('Weapon.BurstTick');
    this.Empty = new Signal('Weapon.Empty');
  }

  static create(def, opts) { return new Weapon(def, opts); }

  get isMelee() { return this.class === WeaponClass.Melee; }
  get isLauncher() { return this.class === WeaponClass.Launcher; }
  get magazineEmpty() { return this.ammo <= 0; }
  get definitionLite() { return this.definition; }

  /** Recoil kick for the next shot, in radians (pattern-based, deterministic). */
  nextRecoil() {
    const pattern = this.definition.recoilPattern;
    const entry = pattern[Math.min(this.recoilIndex, pattern.length - 1)];
    return entry;
  }

  /**
   * Advances timers, spread decay and recoil recovery.
   * @param {number} dt
   * @param {object} [ctx] { onGround, speed, stance, sprinting, adsWanted }
   */
  update(dt, ctx = {}) {
    const def = this.definition;
    this.fireTimer = Math.max(0, this.fireTimer - dt);
    this.burstTimer = Math.max(0, this.burstTimer - dt);
    this.recoilRecoveryTimer += dt;
    this.heat = Math.max(0, this.heat - dt * (this.class === WeaponClass.LMG ? 0.55 : 1.4));

    // Spread decays back toward the resting value.
    const resting = this.restingSpread(ctx);
    if (this.spread > resting) {
      this.spread = Math.max(resting, this.spread - def.spreadDecay * dt);
    } else {
      this.spread = Math.min(resting, this.spread + def.spreadDecay * 2 * dt);
    }

    // Recoil pattern resets once the weapon has settled (this is what "first shot accuracy" means).
    const settleTime = 0.32;
    if (this.recoilIndex > 0 && this.recoilRecoveryTimer > settleTime && this.fireTimer <= 0) {
      const drop = Math.ceil(this.recoilIndex * dt * def.recoil.recovery);
      this.recoilIndex = Math.max(0, this.recoilIndex - Math.max(1, drop));
      if (this.recoilIndex === 0) this.cooledDown = true;
    }
    if (this.fireTimer > 0) this.cooledDown = false;

    // Reload progress.
    if (this.reloading) {
      this.reloadTimer += dt;
      if (this.reloadTimer >= this.reloadDuration) this.finishReload();
    }

    // Burst continuation.
    if (this.burstRemaining > 0 && this.burstTimer <= 0 && this.fireTimer <= 0 && !this.reloading) {
      this.fireBurstShot();
    }

    // Charge weapons (railguns, bows): charge while the trigger is held.
    if (def.fireModes.includes(FireMode.Charge)) {
      this.charge = clamp01(this.triggerHeld ? this.charge + dt / (def.chargeTime ?? 1) : this.charge - dt * 2);
    }
    return this;
  }

  /** Spread the weapon currently rests at, given movement/stance/ADS. */
  restingSpread(ctx = {}) {
    const def = this.definition;
    const speed = ctx.speed ?? 0;
    const stance = ctx.stance ?? 'stand';
    let spread = def.baseSpread;
    if (ctx.ads) spread = lerp(def.baseSpread, def.adsSpread, this.adsBlend);
    // Movement adds spread proportional to how fast we're actually moving.
    const moveFactor = clamp01(speed / 6.6);
    spread += def.moveSpread * moveFactor * (ctx.ads ? 0.55 : 1);
    if (!ctx.onGround) spread += def.airSpread * (ctx.ads ? 0.7 : 1);
    if (ctx.sprinting) spread += def.moveSpread * 0.6;
    if (stance === 'crouch') spread *= def.crouchSpreadScale;
    if (stance === 'prone') spread *= def.proneSpreadScale;
    if (this.heat > 0) spread += this.heat * 0.004;
    if (!ctx.ads && !this.cooledDown) spread = Math.max(spread, this.spread);
    return spread;
  }

  /**
   * Attempts to fire.
   * @param {object} ctx { spreadReady?, onGround, speed, stance, sprinting, ads, now }
   * @returns {boolean} true when a shot was produced (signals carry the details)
   */
  tryFire(ctx = {}) {
    const def = this.definition;
    if (this.reloading) return null;
    if (this.fireTimer > 0) return null;
    if (def.fireModes.includes(FireMode.Charge) && this.class !== WeaponClass.Melee) {
      if (this.charge < 0.99) return null;
    }
    // Single and burst fire require a fresh trigger pull.
    const primaryMode = this.selectedFireMode;
    if ((primaryMode === FireMode.Single || primaryMode === FireMode.Burst) && !this.triggerReady && !this.isMelee) return null;
    if (this.magazineEmpty && !this.isMelee) {
      this.DryFire.emit(this);
      this.Empty.emit(this);
      return null;
    }
    // Returns the shot payload (descriptors, recoil, index) so the caller — player, bot or
    // server — can hand it straight to ballistics without rebuilding it.
    return this.shoot(ctx);
  }

  /** The fire mode currently selected (players can toggle auto/single). */
  get selectedFireMode() {
    if (!this._fireMode || !this.definition.fireModes.includes(this._fireMode)) return this.definition.fireModes[0];
    return this._fireMode;
  }

  setFireMode(mode) {
    if (this.definition.fireModes.includes(mode)) this._fireMode = mode;
    return this;
  }

  toggleFireMode() {
    const modes = this.definition.fireModes;
    if (modes.length < 2) return this.selectedFireMode;
    const index = modes.indexOf(this.selectedFireMode);
    this._fireMode = modes[(index + 1) % modes.length];
    return this._fireMode;
  }

  /** Performs one shot: consumes ammo, spawns shots, kicks recoil/spread, emits `Fired`. */
  shoot(ctx = {}) {
    const def = this.definition;
    const mode = this.selectedFireMode;
    if (this.isMelee) {
      this.fireTimer = def.cycleTime;
      this.triggerReady = false;
      const shot = this._makeShotDescriptors(ctx, 1);
      this.lastShot = shot[0];
      this.totalShots++;
      this.Fired.emit({ weapon: this, shots: shot, melee: true, definition: def });
      return { weapon: this, shots: shot, melee: true, definition: def };
    }
    this.ammo--;
    this.totalShots++;
    this.fireTimer = def.cycleTime;
    this.lastFireTime = ctx.now ?? 0;
    this.lastShotTime = this.lastFireTime;
    this.cooledDown = false;
    this.recoilRecoveryTimer = 0;
    if (mode === FireMode.Burst && this.burstRemaining <= 0) {
      this.burstRemaining = (def.burstCount ?? 3) - 1;
      this.burstTimer = def.burstDelay ?? 0.16;
      this.triggerReady = false;
    }
    const shots = this._makeShotDescriptors(ctx, def.pellets ?? 1);
    this.spread = Math.min(def.maxSpread, this.spread + def.spreadPerShot);
    this.heat = Math.min(1, this.heat + (this.class === WeaponClass.LMG ? 0.09 : 0.05));
    this.lastShot = shots[0];
    const recoil = this.nextRecoil();
    const event = {
      weapon: this,
      shots,
      definition: def,
      spread: this.spread,
      pellets: def.pellets ?? 1,
      recoil,
      shotIndex: this.recoilIndex++,
      hipFire: !ctx.ads,
    };
    this.Fired.emit(event);
    return event;
  }

  fireBurstShot() {
    const def = this.definition;
    if (this.magazineEmpty) { this.burstRemaining = 0; return false; }
    this.recoilRecoveryTimer = 0;
    this.ammo--;
    this.totalShots++;
    this.burstRemaining--;
    this.burstTimer = def.burstDelay ?? 0.16;
    this.fireTimer = def.cycleTime;
    const shots = this._makeShotDescriptors(this._burstContext ?? {}, def.pellets ?? 1);
    this.spread = Math.min(def.maxSpread, this.spread + def.spreadPerShot);
    this.BurstTick.emit({ weapon: this, shots, remaining: this.burstRemaining });
    this.Fired.emit({ weapon: this, shots, definition: def, burst: true, recoil: this.nextRecoil(), shotIndex: this.recoilIndex++ });
    return true;
  }

  /** Builds shot descriptors: direction within the spread cone, damage-scaled by distance class. */
  _makeShotDescriptors(ctx, count) {
    const def = this.definition;
    const spread = ctx.spreadOverride ?? this.spread;
    const origin = (ctx.origin ?? _origin).clone();
    const direction = (ctx.direction ?? _dir).clone().normalize();
    const shots = [];
    for (let i = 0; i < count; i++) {
      // Deterministic cone sampling: index-shifted so pellets form a stable ring pattern.
      const angle = count === 1 ? 0 : (i / count) * Math.PI * 2 + (ctx.pelletOffset ?? 0);
      const radius = count === 1 ? (ctx.spreadScale ?? 1) : (0.35 + 0.65 * ((i * 7919) % 100) / 100);
      const spreadAngle = spread * (count === 1 ? 1 : radius);
      const dir = _shotDir.copy(direction);
      if (spreadAngle > 0) {
        const right = _right.set(0, 1, 0).cross(direction).normalize();
        if (right.sqrMagnitude < 1e-6) right.set(1, 0, 0).cross(direction).normalize();
        const up = _up.copy(direction).cross(right).normalize();
        const ox = Math.cos(angle) * spreadAngle * (count === 1 ? 1 : 1);
        const oy = Math.sin(angle) * spreadAngle * (count === 1 ? 1 : 1);
        dir.addScaled(right, Math.tan(ox)).addScaled(up, Math.tan(oy)).normalize();
      }
      shots.push({
        origin: origin.clone(),
        direction: dir.clone(),
        damage: def.damage,
        velocity: def.projectileSpeed || def.muzzleVelocity,
        projectile: (def.projectiles ?? 0) > 0,
        pellet: i,
        weaponId: def.id,
        weaponClass: def.class,
        penetration: def.penetration,
        range: def.range,
      });
    }
    return shots;
  }

  // ------------------------------------------------------------------ reload
  /** Starts a reload (empty reload is slower). Returns false when it can't happen. */
  startReload({ force = false } = {}) {
    const def = this.definition;
    if (this.isMelee || this.reloading || this.ammo >= def.magazineSize || this.reserve <= 0) return false;
    if (this.burstRemaining > 0 && !force) return false;
    this.reloading = true;
    this.burstRemaining = 0;
    this.reloadTimer = 0;
    this.reloadDuration = this.magazineEmpty ? def.reloadEmptyTime : def.reloadTime;
    this.reloadCancelable = true;
    this.ReloadStarted.emit({ weapon: this, empty: this.magazineEmpty, duration: this.reloadDuration });
    return true;
  }

  /** Cancels a reload early (sprint/ADS/swap). Only allowed inside the cancel window. */
  cancelReload() {
    if (!this.reloading) return false;
    const progress = this.reloadTimer / this.reloadDuration;
    if (!this.reloadCancelable || progress > 1 - (this.definition.reloadFinishWindow ?? 0.45)) return false;
    this.reloading = false;
    this.reloadTimer = 0;
    return true;
  }

  /** Finishes the reload, moving rounds from reserve into the magazine. */
  finishReload() {
    const def = this.definition;
    const needed = def.magazineSize - this.ammo;
    const taken = Math.min(needed, this.reserve);
    this.ammo += taken;
    this.reserve -= taken;
    this.reloading = false;
    this.reloadTimer = 0;
    this.ReloadFinished.emit({ weapon: this, loaded: taken, ammo: this.ammo, reserve: this.reserve });
    return this;
  }

  /** Progress 0..1 of the current reload (drives the HUD ring and animation). */
  get reloadProgress() { return this.reloading ? clamp01(this.reloadTimer / this.reloadDuration) : (this.ammo >= this.definition.magazineSize ? 1 : 0); }

  // ------------------------------------------------------------------ helpers
  canFire(ctx = {}) {
    if (this.reloading || this.fireTimer > 0) return false;
    if (this.isMelee) return true;
    if (this.magazineEmpty) return false;
    const mode = this.selectedFireMode;
    if (mode === FireMode.Single && !this.triggerReady) return false;
    if (ctx.sprinting && this.class !== WeaponClass.Pistol && this.class !== WeaponClass.Melee) return false;
    return true;
  }

  addAmmo(amount, { reserve = true } = {}) {
    if (reserve) this.reserve += amount;
    else this.ammo = Math.min(this.definition.magazineSize, this.ammo + amount);
    return this;
  }

  /** Ammo display data for the HUD. */
  getAmmoState() {
    return {
      ammo: this.ammo,
      magazineSize: this.definition.magazineSize,
      reserve: this.reserve,
      reloading: this.reloading,
      reloadProgress: this.reloadProgress,
      low: this.ammo <= Math.max(1, Math.floor(this.definition.magazineSize * 0.25)),
      empty: this.magazineEmpty,
      fireMode: this.selectedFireMode,
      fireModes: this.definition.fireModes,
    };
  }

  /** Effective time-to-kill estimate (used by AI and by the balance test in the docs). */
  estimateTTK(targetHealth = 100) {
    const def = this.definition;
    const shotsPerSecond = def.rpm / 60;
    const damage = def.damage;
    const shots = Math.ceil(targetHealth / damage);
    return { shots, seconds: shots / shotsPerSecond, dps: damage * shotsPerSecond };
  }

  serialize() {
    return { id: this.id, ammo: this.ammo, reserve: this.reserve, mode: this.selectedFireMode, attachments: this.attachments, grenades: { ...this.grenades } };
  }

  static deserialize(data, library = WeaponLibrary) {
    const def = library[data.id]?.();
    if (!def) return null;
    const modified = applyAttachments(def, data.attachments ?? []);
    const weapon = new Weapon(modified, { attachments: data.attachments ?? [], ammoInMagazine: data.ammo, reserve: data.reserve, grenades: data.grenades });
    weapon.setFireMode(data.mode);
    return weapon;
  }
}

const _origin = new Vector3();
const _dir = new Vector3(0, 0, -1);
const _shotDir = new Vector3();
const _right = new Vector3();
const _up = new Vector3();
void RAD2DEG;
void DEG2RAD;

/** Convenience: every weapon id in the catalogue. */
export const WeaponIds = Object.keys(WeaponLibrary);

export default WeaponLibrary;
