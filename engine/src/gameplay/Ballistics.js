/**
 * OminX Engine — ballistics, hitboxes, damage application and impact effects.
 *
 * The system that turns "the trigger was pulled" into "a player took 96 damage to the head at
 * 140 m through a wooden wall, and everyone nearby heard it". It owns:
 *
 *   - **Hitboxes** — actors register head/torso/limb volumes once; every trace tests them, so
 *     headshots, limb damage and AI aiming at the right body part come from one source of truth.
 *   - **Traces** — hitscan with penetration (`CollisionWorld.traceBullet`), so bullets punch
 *     through glass/wood and stop in concrete, with damage falloff over distance.
 *   - **Projectiles** — travel time, gravity, drag, bounce, fuse, stickiness (rockets, grenades).
 *   - **Damage** — zone multipliers, armor absorption, falloff, knockback, kill attribution and
 *     a damage log (kill-cam / combat-log data).
 *   - **Effects** — decals, particle presets, tracers, impact and tail sounds, camera shake,
 *     hit-markers and killfeed entries, all dispatched as signals so audio/HUD/netcode subscribe.
 *
 * Headless by design: pass `null` for renderer-side systems and the logic still runs, which is
 * what lets the dedicated server resolve the exact same shots as the client.
 *
 * @module engine/src/gameplay/Ballistics.js
 */
import { Vector3 } from '../math/Vector3.js';
import { RNG } from '../math/Random.js';
import { Signal } from '../core/Signal.js';
import { clamp, clamp01, lerp } from '../math/MathUtils.js';
import { CollisionLayer } from '../world/Part.js';

/** Body zones and their damage multipliers (modern shooter defaults). */
export const HitZone = {
  Head: 'head',
  Neck: 'neck',
  Torso: 'torso',
  Stomach: 'stomach',
  ArmUpper: 'armUpper',
  ArmLower: 'armLower',
  LegUpper: 'legUpper',
  LegLower: 'legLower',
  Foot: 'foot',
  Shield: 'shield',
};

export const ZoneMultipliers = {
  head: 1.0,        // multiplied by the weapon's headshotMultiplier
  neck: 0.85,
  torso: 1,
  stomach: 0.95,
  armUpper: 0.72,
  armLower: 0.62,
  legUpper: 0.78,
  legLower: 0.65,
  foot: 0.5,
  shield: 0.35,
};

/** What kind of damage is being dealt — drives feedback, armour rules and AI reactions. */
export const DamageType = {
  Bullet: 'bullet',
  Pellet: 'pellet',
  Explosion: 'explosion',
  Fire: 'fire',
  Melee: 'melee',
  Fall: 'fall',
  Drowning: 'drowning',
  Environment: 'environment',
  Vehicle: 'vehicle',
  Gas: 'gas',
};

/** Immutable-ish damage packet passed through the whole damage pipeline. */
export class DamageInfo {
  constructor(opts = {}) {
    this.amount = opts.amount ?? 0;
    this.type = opts.type ?? DamageType.Bullet;
    this.attacker = opts.attacker ?? null;
    this.inflictor = opts.inflictor ?? opts.attacker ?? null;
    this.weapon = opts.weapon ?? null;
    this.hitZone = opts.hitZone ?? HitZone.Torso;
    this.point = opts.point ?? new Vector3();
    this.direction = opts.direction ?? new Vector3();
    this.normal = opts.normal ?? new Vector3();
    this.distance = opts.distance ?? 0;
    this.penetrated = opts.penetrated ?? 0;      // surfaces crossed before impact
    this.armorPiercing = opts.armorPiercing ?? 0;
    this.knockback = opts.knockback ?? 0;
    this.crit = opts.crit ?? false;
    this.headshot = this.hitZone === HitZone.Head;
    this.timestamp = opts.timestamp ?? 0;
    this.suppression = opts.suppression ?? 0;
  }

  /** Damage after armour, zone and falloff are all accounted for. */
  get final() { return this.amount; }
}

/** A registered hurt volume for an actor. */
export class Hitbox {
  /**
   * @param {string} zone
   * @param {Vector3} offset local offset from the actor's feet position
   * @param {number|Vector3} radius sphere radius (or half-extents for a box)
   * @param {object} [opts] { actor, box=true, armour, multiplier }
   */
  constructor(zone, offset, radius, opts = {}) {
    this.zone = zone;
    this.offset = offset.clone ? offset.clone() : new Vector3(offset.x, offset.y, offset.z);
    this.radius = radius;
    this.actor = opts.actor ?? null;
    this.isBox = opts.box ?? false;
    this.armour = opts.armour ?? 0;
    this.multiplier = opts.multiplier ?? ZoneMultipliers[zone] ?? 1;
    this.enabled = true;
    this.center = new Vector3();
    this.halfExtents = typeof radius === 'number' ? new Vector3(radius, radius, radius) : radius.clone ? radius.clone() : new Vector3(radius.x, radius.y, radius.z);
  }

  /** Refreshes the world-space centre from the actor's current position. */
  update(actorPosition, actorRotation = null) {
    this.center.copy(this.offset);
    if (actorRotation) this.center.applyQuaternion(actorRotation);
    this.center.add(actorPosition);
    return this;
  }

  /** Ray/sphere test. Returns distance along the ray or null. */
  rayTest(origin, direction, maxDistance) {
    if (!this.enabled) return null;
    if (this.isBox) return rayBox(origin, direction, this.center, this.halfExtents, maxDistance);
    return raySphere(origin, direction, this.center, this.radius, maxDistance);
  }
}

/** Standard humanoid hitbox set (feet-origin, ~1.8 m tall). */
export function humanoidHitboxes(actor, { scale = 1, armour = 0 } = {}) {
  const s = scale;
  return [
    new Hitbox(HitZone.Head, new Vector3(0, 1.62 * s, 0), 0.13 * s, { actor, armour }),
    new Hitbox(HitZone.Neck, new Vector3(0, 1.48 * s, 0), 0.09 * s, { actor, armour }),
    new Hitbox(HitZone.Torso, new Vector3(0, 1.3 * s, 0), new Vector3(0.24 * s, 0.2 * s, 0.16 * s), { actor, box: true, armour }),
    new Hitbox(HitZone.Stomach, new Vector3(0, 1.0 * s, 0), new Vector3(0.22 * s, 0.14 * s, 0.15 * s), { actor, box: true, armour }),
    new Hitbox(HitZone.ArmUpper, new Vector3(0.24 * s, 1.3 * s, 0), 0.09 * s, { actor, armour }),
    new Hitbox(HitZone.ArmLower, new Vector3(0.3 * s, 1.05 * s, 0), 0.075 * s, { actor, armour }),
    new Hitbox(HitZone.LegUpper, new Vector3(0.1 * s, 0.7 * s, 0), 0.11 * s, { actor, armour }),
    new Hitbox(HitZone.LegLower, new Vector3(0.1 * s, 0.32 * s, 0), 0.09 * s, { actor, armour }),
  ];
}

/** Impact effect tables: what a bullet does to each surface. */
export const ImpactTable = {
  concrete: { decal: 'Concrete', particles: 'impactConcrete', sound: 'impact_concrete', sparks: false, dust: 'heavy' },
  brick: { decal: 'Concrete', particles: 'impactConcrete', sound: 'impact_concrete', dust: 'heavy' },
  metal: { decal: 'Metal', particles: 'impactMetal', sound: 'impact_metal', sparks: true },
  wood: { decal: 'Wood', particles: 'impactWood', sound: 'impact_wood', dust: 'light' },
  sandbag: { decal: 'Sand', particles: 'impactSand', sound: 'impact_sand', dust: 'light' },
  dirt: { decal: 'Sand', particles: 'impactDirt', sound: 'impact_dirt', dust: 'light' },
  sand: { decal: 'Sand', particles: 'impactSand', sound: 'impact_sand', dust: 'light' },
  rock: { decal: 'Concrete', particles: 'impactConcrete', sound: 'impact_rock', sparks: true },
  grass: { decal: 'Sand', particles: 'impactDirt', sound: 'impact_grass', dust: 'light' },
  foliage: { decal: 'Sand', particles: 'impactDirt', sound: 'impact_grass' },
  glass: { decal: 'Glass', particles: 'impactGlass', sound: 'impact_glass', shatter: true },
  rubber: { decal: 'Concrete', particles: 'impactDirt', sound: 'impact_rubber' },
  hazard: { decal: 'Metal', particles: 'impactMetal', sound: 'impact_metal', sparks: true },
  skin: { decal: 'Flesh', particles: 'impactBlood', sound: 'impact_flesh', blood: true },
  water: { decal: null, particles: 'waterSplash', sound: 'impact_water' },
};

/** Projectile kinds used by launchers and thrown grenades. */
export const ProjectileKind = { Bullet: 'bullet', Rocket: 'rocket', Grenade: 'grenade', Arrow: 'arrow', Thrown: 'thrown' };

/**
 * A simulated projectile. Bullets with travel time, rockets, and thrown grenades all share this
 * type; behaviour differences are data (`gravityScale`, `bounce`, `fuse`, `sticky`).
 */
export class Projectile {
  constructor(opts = {}) {
    this.kind = opts.kind ?? ProjectileKind.Rocket;
    this.position = opts.position?.clone?.() ?? new Vector3();
    this.velocity = opts.velocity?.clone?.() ?? new Vector3();
    this.damage = opts.damage ?? 100;
    this.splashRadius = opts.splashRadius ?? 0;
    this.splashDamage = opts.splashDamage ?? 0;
    this.gravityScale = opts.gravityScale ?? 1;
    this.drag = opts.drag ?? 0;
    this.bounce = opts.bounce ?? 0;
    this.friction = opts.friction ?? 0.6;
    this.fuse = opts.fuse ?? 0;
    this.sticky = opts.sticky ?? false;
    this.penetration = opts.penetration ?? 0;
    this.lifetime = opts.lifetime ?? 12;
    this.radius = opts.radius ?? 0.06;
    this.owner = opts.owner ?? null;
    this.weapon = opts.weapon ?? null;
    this.team = opts.team ?? 'neutral';
    this.trail = opts.trail ?? 'rocketTrail';
    this.raycast = opts.raycast !== false;
    this.stuck = false;
    this.age = 0;
    this.dead = false;
    this.explosion = opts.explosion ?? null;
    this.smoke = opts.smoke ?? null;
    this.effect = opts.effect ?? null;
    this.ignore = opts.ignore ?? new Set();
    this.lastPosition = this.position.clone();
    this._trailTimer = 0;
  }
}

export class BallisticsSystem {
  /**
   * @param {import('../world/Scene.js').Scene} scene
   * @param {object} [opts] { renderer, audio, rng, onDamage, particles, decals, tracers, lights }
   */
  constructor(scene, opts = {}) {
    this.scene = scene;
    this.collision = scene?.collision ?? null;
    this.renderer = opts.renderer ?? null;
    this.audio = opts.audio ?? null;
    this.particles = opts.particles ?? opts.renderer?.particles ?? null;
    this.decals = opts.decals ?? opts.renderer?.decals ?? null;
    this.tracers = opts.tracers ?? opts.renderer?.tracers ?? null;
    this.lights = opts.lights ?? opts.renderer?.lights ?? null;
    this.onDamage = opts.onDamage ?? null;
    this.rng = opts.rng ?? new RNG(90210);
    this.gravity = opts.gravity ?? 9.81;

    /** @type {Map<object, Hitbox[]>} */
    this.actors = new Map();
    /** @type {Projectile[]} */
    this.projectiles = [];
    /** Active area volumes (smoke, fire, gas) — these outlive their projectile. */
    this.volumes = [];
    this.damageLog = [];
    this.maxDamageLog = 64;
    this.stats = { shots: 0, hits: 0, headshots: 0, kills: 0, damage: 0, projectiles: 0, explosions: 0, tracers: 0 };
    this.time = 0;
    this.hitRegistrationEnabled = true;

    this.ShotFired = new Signal('Ballistics.ShotFired');
    this.Hit = new Signal('Ballistics.Hit');
    this.ActorHit = new Signal('Ballistics.ActorHit');
    this.Kill = new Signal('Ballistics.Kill');
    this.ProjectileSpawned = new Signal('Ballistics.ProjectileSpawned');
    this.ProjectileImpact = new Signal('Ballistics.ProjectileImpact');
    this.Explosion = new Signal('Ballistics.Explosion');
    this.Suppressed = new Signal('Ballistics.Suppressed');
  }

  static create(scene, opts) { return new BallisticsSystem(scene, opts); }

  // ------------------------------------------------------------------ actor registration
  /**
   * Registers an actor (player, bot, vehicle) and its hurt volumes.
   * @param {object} actor must expose `position` (Vector3) and optionally `team`, `health`
   */
  registerActor(actor, hitboxes = null) {
    const boxes = hitboxes ?? humanoidHitboxes(actor, { scale: actor.hitboxScale ?? 1, armour: actor.armourValue ?? 0 });
    for (const box of boxes) box.actor = actor;
    this.actors.set(actor, boxes);
    return boxes;
  }

  unregisterActor(actor) { return this.actors.delete(actor); }

  /** Rebuilds hurt volumes (after a stance change, shield pickup, boss scale-up, …). */
  setHitboxes(actor, boxes) {
    for (const box of boxes) box.actor = actor;
    this.actors.set(actor, boxes);
    return boxes;
  }

  /** Refreshes world-space hitbox positions. Call once per frame before resolving shots. */
  updateActors() {
    for (const [actor, boxes] of this.actors) {
      const position = actor.position ?? actor.object3D?.position;
      if (!position) continue;
      const rotation = actor.rotationQuaternion ?? null;
      for (const box of boxes) box.update(position, rotation);
    }
    return this;
  }

  /** Closest actor hitbox along a ray (used by hitscan traces). */
  traceActors(origin, direction, maxDistance, { ignore = null, team = null, mask = null } = {}) {
    let best = null;
    let bestDistance = maxDistance;
    for (const [actor, boxes] of this.actors) {
      if (!actor || actor === ignore) continue;
      if (ignore && (Array.isArray(ignore) ? ignore.includes(actor) : ignore.has?.(actor))) continue;
      if (actor.dead || actor.isDead) continue;
      if (team && actor.team === team) continue;
      if (mask && actor.layer !== undefined && !(actor.layer & mask)) continue;
      for (const box of boxes) {
        const distance = box.rayTest(origin, direction, bestDistance);
        if (distance === null || distance < 0 || distance >= bestDistance) continue;
        bestDistance = distance;
        best = { actor, box, distance };
      }
    }
    return best;
  }

  // ------------------------------------------------------------------ firing
  /**
   * Resolves one shot descriptor produced by a `Weapon`.
   * @param {object} shot { origin, direction, damage, weaponId, weaponClass, penetration, range, projectile }
   * @param {object} [ctx] { attacker, team, weapon, spread, useProjectile, time, tracerOrigin }
   */
  fireShot(shot, ctx = {}) {
    const attacker = ctx.attacker ?? null;
    const team = ctx.team ?? attacker?.team ?? 'neutral';
    this.stats.shots++;
    if (shot.projectile && ctx.useProjectile !== false) {
      return this.spawnProjectile(shot, ctx);
    }
    const result = this.resolveHitscan(shot, { ...ctx, attacker, team });
    // Tracer every Nth shot (keeps the screen readable and the cost low).
    const def = ctx.weapon?.definition ?? null;
    const every = def?.tracerEvery ?? 3;
    if (this.tracers && result.hits.length > 0 && (this.stats.shots % Math.max(1, every) === 0 || def?.class === 'sniper' || def?.class === 'lmg')) {
      const end = result.hits[0].point;
      this.tracers.fire(shot.origin, end, {
        color: def?.tracerColor ?? '#ffe08a',
        width: def?.class === 'sniper' ? 0.05 : 0.028,
        speed: Math.max(300, shot.velocity || 800),
        intensity: def?.class === 'sniper' ? 1.6 : 1,
      });
      this.stats.tracers++;
    }
    this.ShotFired.emit({ shot, ctx, result });
    return result;
  }

  /**
   * Hitscan resolution with penetration.
   * @returns {{hits: object[], damage: number, killed: boolean, actorHit: ?object}}
   */
  resolveHitscan(shot, ctx = {}) {
    const origin = shot.origin ?? _v1;
    const direction = (shot.direction ?? _v2.set(0, 0, -1)).clone().normalize();
    const maxDistance = 1000;
    const ignore = new Set(ctx.ignore ?? []);
    if (ctx.attacker) ignore.add(ctx.attacker);
    const layerMask = ctx.layerMask ?? (CollisionLayer.All & ~CollisionLayer.Trigger);

    // World hits first (all of them — penetration needs the full list).
    const worldHits = this.collision
      ? this.collision.raycastAll(origin, direction, { maxDistance, layerMask, ignore, triggers: false })
      : [];

    let remainingPenetration = shot.penetration ?? 0.5;
    let distanceFallen = 0;
    const hits = [];
    let actorHit = null;
    let damageDealt = 0;
    let killed = false;
    let sourcePosition = origin.clone();

    // Walk surfaces near→far; before consuming each surface, test actors in that span.
    for (let i = 0; i <= worldHits.length; i++) {
      const worldHit = worldHits[i] ?? null;
      const span = worldHit ? worldHit.distance - distanceFallen : maxDistance * 4;
      const actorResult = this.hitRegistrationEnabled && span > 0
        ? this.traceActors(sourcePosition, direction, span, { ignore: [...ignore], team: ctx.attacker?.team ?? null })
        : null;
      if (actorResult) {
        const point = _v3.copy(sourcePosition).addScaled(direction, actorResult.distance);
        const damageInfo = this._makeDamageInfo({
          actor: actorResult.actor,
          box: actorResult.box,
          shot,
          ctx,
          point,
          direction,
          distance: distanceFallen + actorResult.distance,
          penetrated: hits.length,
        });
        const applied = this.applyDamage(actorResult.actor, damageInfo);
        damageDealt += applied.applied;
        killed = killed || applied.killed;
        actorHit = { ...actorResult, ...applied, damageInfo, point: point.clone() };
        hits.push({
          type: 'actor',
          actor: actorResult.actor,
          zone: actorResult.box.zone,
          point: point.clone(),
          normal: direction.clone().negate(),
          distance: damageInfo.distance,
          damageInfo,
          applied: applied.applied,
          killed: applied.killed,
          surface: null,
        });
        this.stats.hits++;
        if (actorResult.box.zone === HitZone.Head) this.stats.headshots++;
        this.ActorHit.emit({ ...actorHit, shot, ctx });
        this.Hit.emit(hits[hits.length - 1]);
        // Bullets that hit flesh lose most of their energy; heavy hitters over-penetrate anyway.
        remainingPenetration -= 0.55 - (shot.penetration ?? 0) * 0.25;
        if (remainingPenetration <= 0) break;
        sourcePosition = point.addScaled(direction, 0.05);
        continue;
      }

      if (!worldHit) break;
      const surfaceKey = worldHit.surface?.key ?? worldHit.material ?? 'concrete';
      const impact = ImpactTable[surfaceKey] ?? ImpactTable.concrete;
      hits.push({
        type: 'world',
        part: worldHit.part,
        point: worldHit.point.clone(),
        normal: worldHit.normal.clone(),
        distance: worldHit.distance,
        surface: surfaceKey,
        material: worldHit.material,
      });
      this._impactEffects(worldHit.point, worldHit.normal, surfaceKey, ctx, worldHit.part);
      remainingPenetration -= 1 - (worldHit.surface?.penetration ?? 0.1);
      const shatter = worldHit.surface?.fragile && ctx.weapon?.definition?.damage > 20;
      if (shatter && worldHit.part) worldHit.part.shatter?.();
      if (remainingPenetration <= 0) {
        if (impact.blood === false && ctx.attacker) {
          // Near-miss suppression: bullets cracking past an enemy make them flinch.
          this._suppressNearMiss(worldHit.point, ctx);
        }
        break;
      }
      sourcePosition = worldHit.point.addScaled(direction, 0.02);
      distanceFallen = worldHit.distance;
    }

    this.stats.damage += damageDealt;
    return { hits, damage: damageDealt, killed, actorHit, origin: origin.clone(), direction };
  }

  _makeDamageInfo({ actor, box, shot, ctx, point, direction, distance, penetrated }) {
    const def = ctx.weapon?.definition ?? null;
    const headshotMultiplier = def?.headshotMultiplier ?? 2.6;
    const limbMultiplier = def?.limbMultiplier ?? 0.85;

    // Distance falloff: full damage up to `falloffStart`, tapering to `minDamageScale` at `falloffEnd`.
    const falloffStart = def?.falloffStart ?? 40;
    const falloffEnd = def?.falloffEnd ?? 120;
    const minScale = def?.minDamageScale ?? 0.6;
    const t = clamp01((distance - falloffStart) / Math.max(1, falloffEnd - falloffStart));
    const falloff = lerp(1, minScale, t);

    // Penetration loss: each surface crossed also removes energy.
    const penetrationLoss = 1 - Math.min(0.5, penetrated * 0.12);

    let zoneMultiplier = box.multiplier ?? 1;
    if (box.zone === HitZone.Head) zoneMultiplier = headshotMultiplier;
    else if (box.zone.startsWith('arm') || box.zone.startsWith('leg') || box.zone === HitZone.Foot) zoneMultiplier *= limbMultiplier;

    const amount = (shot.damage ?? def?.damage ?? 20) * zoneMultiplier * falloff * penetrationLoss;
    return new DamageInfo({
      amount,
      type: shot.pellet !== undefined && (def?.pellets ?? 1) > 1 ? DamageType.Pellet : DamageType.Bullet,
      attacker: ctx.attacker ?? null,
      inflictor: ctx.weapon ?? null,
      weapon: ctx.weapon ?? null,
      hitZone: box.zone,
      point,
      direction,
      normal: direction.clone().negate(),
      distance,
      penetrated,
      armorPiercing: def?.armorPiercing ?? 0,
      knockback: (def?.damage ?? 20) * 0.012,
      crit: box.zone === HitZone.Head,
      timestamp: this.time,
      suppression: 0.2,
    });
  }

  /**
   * Applies a damage packet to a target through its health model.
   * The target may be a `Player`, a `Bot`, a `HealthComponent` owner or anything exposing
   * `takeDamage(info)` / `health.damage(info)`.
   */
  applyDamage(target, info) {
    if (!target) return { applied: 0, killed: false };
    if (typeof target.applyDamage === 'function') return target.applyDamage(info);
    if (target.health && typeof target.health.damage === 'function') return target.health.damage(info);
    if (typeof target.takeDamage === 'function') {
      const result = target.takeDamage(info.amount, info) ?? {};
      return { applied: result.applied ?? info.amount, killed: !!result.killed };
    }
    return { applied: 0, killed: false };
  }

  /** Logs a kill and broadcasts it (killfeed, scoreboard, netcode). */
  registerKill({ killer, victim, weapon, info, headshot = false, distance = 0, wallbang = false, noscope = false, melee = false, explosion = false }) {
    this.stats.kills++;
    const entry = {
      killer, victim, weapon,
      weaponName: weapon?.definition?.name ?? weapon?.name ?? 'Environment',
      killerName: killer?.displayName ?? killer?.name ?? 'Unknown',
      victimName: victim?.displayName ?? victim?.name ?? 'Unknown',
      teamKill: !!(killer && victim && killer.team && killer.team === victim.team && killer !== victim),
      headshot, distance, wallbang, noscope, melee, explosion,
      time: this.time,
    };
    this.damageLog.push(entry);
    if (this.damageLog.length > this.maxDamageLog) this.damageLog.shift();
    this.Kill.emit(entry);
    return entry;
  }

  // ------------------------------------------------------------------ impacts & effects
  _impactEffects(point, normal, surfaceKey, ctx, part) {
    const impact = ImpactTable[surfaceKey] ?? ImpactTable.concrete;
    if (this.decals && impact.decal) {
      this.decals.spawn(point, normal, impact.decal, { scale: ctx.decalScale ?? 1, life: ctx.decalLife ?? 22 });
    }
    if (this.particles && impact.particles) {
      this.particles.emit(impact.particles, point, { normal, scale: ctx.impactScale ?? 1 });
    }
    if (this.audio) {
      this.audio.playImpact(impact, point, { source: ctx.attacker });
    }
    if (impact.sparks && this.particles) this.particles.emit('sparkBurst', point, { normal });
    void part;
  }

  _suppressNearMiss(point, ctx) {
    // Anyone close to the bullet's path gets flinched (AI accuracy/spread penalty, player
    // screen-edge blur). Radius is generous around narrow misses.
    const radius = 2.2;
    for (const [actor] of this.actors) {
      if (actor === ctx.attacker) continue;
      if (actor.team === ctx.attacker?.team) continue;
      if (!actor.position) continue;
      if (actor.position.distanceTo(point) > radius) continue;
      actor.suppression = Math.min(1, (actor.suppression ?? 0) + 0.45);
      this.Suppressed.emit({ actor, attacker: ctx.attacker, point: point.clone() });
    }
  }

  // ------------------------------------------------------------------ projectiles
  /** Spawns a ballistic projectile for a shot (rockets, grenades, slow bullets). */
  spawnProjectile(shot, ctx = {}) {
    const def = ctx.weapon?.definition ?? null;
    const projectile = new Projectile({
      kind: def?.rockets ? ProjectileKind.Rocket : ProjectileKind.Bullet,
      position: shot.origin,
      velocity: _v4.copy(shot.direction).scale(shot.velocity ?? 80),
      damage: shot.damage,
      splashRadius: def?.splashRadius ?? 0,
      splashDamage: def?.splashDamage ?? 0,
      // `projectileDrop` doubles as a gravity multiplier: 0 = laser (hitscan-speed), 0.65 = sniper
      // arc, 3.2 = rocket lob. Anything above 0 gets real drop.
      gravityScale: def?.projectileDrop ?? 0,
      drag: def?.projectileDrag ?? 0,
      bounce: def?.bounce ?? 0,
      fuse: def?.fuse ?? 0,
      penetration: shot.penetration ?? 0,
      owner: ctx.attacker ?? null,
      weapon: ctx.weapon ?? null,
      team: ctx.team ?? ctx.attacker?.team ?? 'neutral',
      trail: def?.rockets ? 'rocketTrail' : (def?.projectileTrail ?? null),
      radius: def?.projectileRadius ?? 0.08,
      explosion: def?.rockets || def?.splashRadius ? def : null,
      ignore: ctx.ignore ?? null,
    });
    this.projectiles.push(projectile);
    this.stats.projectiles++;
    this.ProjectileSpawned.emit({ projectile, shot, ctx });
    return { hits: [], damage: 0, killed: false, projectile };
  }

  /** Moves all live projectiles; handles impacts, bounces, fuses and splash damage. */
  updateProjectiles(dt) {
    for (const projectile of this.projectiles) {
      if (projectile.dead) continue;
      projectile.age += dt;
      // Fuse/lifetime are checked *before* collision handling: a resting grenade produces a
      // contact hit every frame, and that `continue` used to starve the fuse check entirely
      // (the first version of this made frag grenades immortal while lying on the ground).
      if (projectile.age > projectile.lifetime) { this._detonate(projectile); continue; }
      if (projectile.fuse > 0 && projectile.age >= projectile.fuse) { this._detonate(projectile); continue; }
      if (projectile.stuck) continue;
      projectile.lastPosition.copy(projectile.position);
      // Gravity + drag.
      if (projectile.gravityScale) projectile.velocity.y -= this.gravity * projectile.gravityScale * dt;
      if (projectile.drag) projectile.velocity.scale(Math.max(0, 1 - projectile.drag * dt));
      const delta = _v5.copy(projectile.velocity).scale(dt);
      const distance = delta.magnitude;
      if (distance > 1e-6) {
        const direction = _v6.copy(delta).scale(1 / distance);
        const hit = this.collision
          ? this.collision.raycast(projectile.position, direction, {
            maxDistance: distance + projectile.radius,
            ignore: projectile.ignore ?? undefined,
            triggers: false,
            layerMask: CollisionLayer.All & ~CollisionLayer.Trigger,
          })
          : null;
        const actorHit = this.hitRegistrationEnabled
          ? this.traceActors(projectile.position, direction, distance + projectile.radius, { ignore: projectile.owner ? [projectile.owner] : null, team: projectile.team })
          : null;
        if (actorHit && (!hit || actorHit.distance < hit.distance)) {
          const point = _v7.copy(projectile.position).addScaled(direction, actorHit.distance);
          projectile.position.copy(point);
          this._detonate(projectile, { hitActor: actorHit.actor, box: actorHit.box, point });
          continue;
        }
        if (hit) {
          projectile.position.copy(hit.point).addScaled(hit.normal, projectile.radius);
          // Fused projectiles (grenades) never explode on contact: they bounce, stick and wait.
          // Testing the explosion branch first is how the first version of this turned every
          // thrown frag into a contact grenade.
          if (projectile.fuse > 0) {
            if (projectile.sticky) { projectile.stuck = true; projectile.velocity.set(0, 0, 0); this.ProjectileImpact.emit({ projectile, hit }); continue; }
            const into = projectile.velocity.dot(hit.normal);
            if (projectile.bounce > 0 && into < 0) {
              projectile.velocity.addScaled(hit.normal, -(1 + projectile.bounce) * into);
              projectile.velocity.scale(1 - projectile.friction * 0.25);
              if (projectile.velocity.magnitude < 1.4) projectile.velocity.set(0, 0, 0);
            } else if (projectile.bounce <= 0) {
              projectile.velocity.set(0, 0, 0);
            }
            // A grenade that has stopped moving is at rest: park it so we stop sweeping it
            // every frame (it wakes up again only for the fuse).
            if (projectile.velocity.magnitude < 0.6) {
              projectile.velocity.set(0, 0, 0);
              if (projectile.bounce > 0) projectile.stuck = true;
            }
            this.ProjectileImpact.emit({ projectile, hit });
            if (projectile.smoke && this.particles) this.particles.emit('impactDirt', hit.point, { normal: hit.normal, scale: 0.5 });
            continue;
          }
          if (projectile.explosion || projectile.kind === ProjectileKind.Rocket) {
            this._detonate(projectile, { point: hit.point, normal: hit.normal, part: hit.part });
            continue;
          }
          if (projectile.bounce > 0) {
            const into = projectile.velocity.dot(hit.normal);
            projectile.velocity.addScaled(hit.normal, -(1 + projectile.bounce) * into);
            projectile.velocity.scale(1 - projectile.friction * 0.3);
            this.ProjectileImpact.emit({ projectile, hit });
            continue;
          }
          this._impactEffects(hit.point, hit.normal, hit.surface?.key ?? 'concrete', { attacker: projectile.owner, weapon: projectile.weapon }, hit.part);
          this.ProjectileImpact.emit({ projectile, hit });
          projectile.dead = true;
          continue;
        }
        projectile.position.add(delta);
      }
      // Fuse (grenades) and smoke volumes (usable before detonation).
      if (projectile.smoke && this.particles && projectile.age > 0.35) {
        projectile._trailTimer -= dt;
        if (projectile._trailTimer <= 0) {
          projectile._trailTimer = 0.06;
          this.particles.emit('smokeTrail', projectile.position, { scale: 0.6 });
        }
      }
      if (projectile.fuse > 0 && projectile.age >= projectile.fuse) this._detonate(projectile);
    }
    if (this.projectiles.length) {
      this.projectiles = this.projectiles.filter((p) => !p.dead && p.age <= p.lifetime);
    }
    return this;
  }

  _detonate(projectile, hitInfo = null) {
    if (projectile.dead) return;
    projectile.dead = true;
    const point = _v8.copy(hitInfo?.point ?? projectile.position);
    // Grenades that leave something behind (smoke, fire, gas, flash, EMP) spawn an area volume
    // instead of a plain explosion; pure frags just blow up.
    const grenade = projectile.grenade ?? null;
    const leavesVolume = grenade && (grenade.duration || grenade.blocksVision || grenade.blindIntensity || grenade.disableElectronics || grenade.dotPerSecond);
    if (leavesVolume) {
      return this._spawnAreaVolume(grenade, point, {
        attacker: projectile.owner,
        weapon: projectile.weapon,
        damageOnImpact: (grenade.damage ?? 0) > 0,
      });
    }
    if (hitInfo?.hitActor) {
      const info = new DamageInfo({
        amount: projectile.damage,
        type: DamageType.Explosion,
        attacker: projectile.owner,
        weapon: projectile.weapon,
        hitZone: hitInfo.box?.zone ?? HitZone.Torso,
        point,
        direction: _v9.copy(projectile.velocity).normalize(),
        distance: 0,
      });
      this.applyDamage(hitInfo.hitActor, info);
    }
    if (projectile.splashRadius > 0 || projectile.explosion) {
      this.explode(point, {
        radius: projectile.splashRadius || projectile.explosion?.splashRadius || 4,
        damage: projectile.splashDamage || projectile.explosion?.splashDamage || projectile.damage,
        attacker: projectile.owner,
        weapon: projectile.weapon,
        kind: projectile.kind,
        normal: hitInfo?.normal ?? null,
      });
    } else if (projectile.effect && this.particles) {
      this.particles.emit(projectile.effect, point, {});
    }
  }

  /**
   * Explosion damage with occlusion: targets behind hard cover take reduced or no damage, and
   * damage falls off with distance (quadratic-ish, the standard shooter curve).
   */
  explode(position, { radius = 5, damage = 100, attacker = null, weapon = null, kind = ProjectileKind.Rocket, normal = null, shake = 1, silent = false } = {}) {
    this.stats.explosions++;
    const affected = [];
    let kills = 0;
    for (const [actor, boxes] of this.actors) {
      if (actor === attacker) continue;
      const actorPosition = actor.position;
      if (!actorPosition) continue;
      const centre = _v10.copy(actorPosition).add(_up);
      const distance = centre.distanceTo(position);
      if (distance > radius) continue;
      if (!this._hasBlastLine(position, centre)) continue;
      const falloff = 1 - clamp01(distance / radius);
      const amount = damage * falloff * falloff;
      if (amount <= 0) continue;
      const direction = _v11.copy(centre).sub(position).normalize();
      const info = new DamageInfo({
        amount,
        type: DamageType.Explosion,
        attacker,
        weapon,
        hitZone: HitZone.Torso,
        point: centre.clone(),
        direction,
        distance,
        knockback: amount * 0.05,
        normal: direction.clone().negate(),
      });
      const result = this.applyDamage(actor, info);
      if (result.killed) kills++;
      actor.applyKnockback?.(direction, amount * 0.045);
      actor.shakeCamera?.(amount * 0.02 * shake, 'explosion');
      affected.push({ actor, distance, amount: result.applied, killed: result.killed });
      void boxes;
    }
    if (!silent) {
      if (this.particles) {
        this.particles.emit(kind === ProjectileKind.Grenade ? 'grenadeExplosion' : 'rocketExplosion', position, { normal: normal ?? new Vector3(0, 1, 0) });
      }
      if (this.lights) this.lights.flash?.(position, '#ffb35a', 8, 0.35);
      if (this.audio) this.audio.play('explosion', position, { volume: clamp01(radius / 6) });
    }
    if (this.decals) this.decals.spawn(position, new Vector3(0, 1, 0), 'Scorch', { scale: radius * 0.4, life: 40 });
    const event = { position: position.clone(), radius, damage, attacker, weapon, affected, kills };
    this.Explosion.emit(event);
    return event;
  }

  /**
   * Blast line check: hard cover between the charge and the target blocks damage.
   * The trace is lifted above foot level — a horizontal ray along the floor hits the floor
   * itself and would otherwise report "blocked" for every target standing on the ground.
   */
  _hasBlastLine(from, to, lift = 0.4) {
    if (!this.collision) return true;
    const delta = _v12.copy(to).sub(from);
    const distance = delta.magnitude;
    if (distance < 1e-4) return true;
    const start = _v16.copy(from).addScaled(_up, lift);
    delta.scale(1 / distance);
    const hits = this.collision.raycastAll(start, delta, {
      maxDistance: distance,
      layerMask: CollisionLayer.Static | CollisionLayer.Dynamic,
      triggers: false,
    });
    for (const hit of hits) {
      const kind = hit.surface?.key;
      if (kind === 'glass' || kind === 'foliage') continue;
      return false;
    }
    return true;
  }

  /**
   * Creates a lasting area effect volume: smoke that blocks vision, fire that ticks damage,
   * gas that denies space. Volumes expire with `duration` and are queryable by AI, the renderer
   * (particle field) and gameplay systems.
   */
  _spawnAreaVolume(grenade, position, { attacker = null, weapon = null, damageOnImpact = false } = {}) {
    const volume = {
      kind: grenade.id,
      position: position.clone(),
      radius: grenade.radius ?? grenade.splashRadius ?? 4,
      remaining: grenade.duration ?? 6,
      duration: grenade.duration ?? 6,
      damagePerSecond: grenade.dotPerSecond ?? 0,
      blocksVision: !!grenade.blocksVision,
      blindIntensity: grenade.blindIntensity ?? 0,
      disableElectronics: !!grenade.disableElectronics,
      attacker,
      weapon,
    };
    this.volumes.push(volume);
    if (damageOnImpact && grenade.damage > 0) {
      // Incendiary/flash still hit for a little damage on the pop itself.
      this.explode(position, {
        radius: grenade.splashRadius ?? grenade.radius ?? 4,
        damage: grenade.damage,
        attacker,
        weapon,
        kind: ProjectileKind.Grenade,
        silent: grenade.blindIntensity > 0,
      });
    }
    if (grenade.blindIntensity > 0) {
      // Flashbang: anyone with line of sight gets blinded proportionally to how close/lit it is.
      for (const [actor] of this.actors) {
        if (!actor.position) continue;
        const distance = actor.position.distanceTo(position);
        if (distance > grenade.radius * 1.4) continue;
        if (!this._hasBlastLine(position, actor.position)) continue;
        const facing = actor.getForward ? clamp01((actor.getForward().dot(_v15.copy(position).sub(actor.position).normalize()) + 1) * 0.5) : 0.5;
        const intensity = clamp01(grenade.blindIntensity * (1 - distance / (grenade.radius * 1.4)) * (0.35 + facing * 0.65));
        actor.applyFlash?.(intensity, grenade.duration);
      }
    }
    this.Explosion.emit({ position: position.clone(), radius: volume.radius, damage: 0, kind: grenade.id, volume });
    return volume;
  }

  /** Damage-over-time and vision queries for active volumes (called from `update`). */
  _updateVolumes(dt) {
    for (let i = this.volumes.length - 1; i >= 0; i--) {
      const volume = this.volumes[i];
      volume.remaining -= dt;
      if (volume.remaining <= 0) { this.volumes.splice(i, 1); continue; }
      if (volume.damagePerSecond > 0) {
        volume._tick = (volume._tick ?? 0) + dt;
        if (volume._tick >= 0.25) {
          const elapsed = volume._tick;
          volume._tick = 0;
          this.areaEffect(volume.position, {
            radius: volume.radius,
            duration: elapsed,
            damagePerSecond: volume.damagePerSecond,
            attacker: volume.attacker,
            type: volume.kind === 'incendiary' ? DamageType.Fire : DamageType.Gas,
          });
        }
      }
    }
    return this;
  }

  /** True when smoke/fire sits between two points (used by AI vision and the HUD). */
  isVisionBlocked(from, to) {
    if (this.volumes.length === 0) return false;
    for (const volume of this.volumes) {
      if (!volume.blocksVision) continue;
      const distance = pointToSegmentDistance(volume.position, from, to);
      if (distance < volume.radius * 0.75) return true;
    }
    return false;
  }

  getVolumeAt(position) {
    for (const volume of this.volumes) {
      if (volume.position.distanceTo(position) < volume.radius) return volume;
    }
    return null;
  }

  // ------------------------------------------------------------------ grenades
  /**
   * Throws a grenade along a ballistic arc.
   * @param {object} grenade definition from `GrenadeLibrary`
   * @param {Vector3} origin
   * @param {Vector3} direction normalised throw direction (already including the arc lift)
   * @param {object} [opts] { owner, team, speed, fuse, spin }
   */
  throwGrenade(grenade, origin, direction, opts = {}) {
    const speed = opts.speed ?? 16;
    const projectile = new Projectile({
      kind: ProjectileKind.Grenade,
      position: origin,
      velocity: _v13.copy(direction).normalize().scale(speed),
      damage: grenade.damage ?? 0,
      splashRadius: grenade.splashRadius ?? grenade.radius ?? 0,
      splashDamage: grenade.damage ?? 0,
      gravityScale: opts.gravityScale ?? 1.15,
      drag: 0.12,
      bounce: grenade.bounce ?? 0.4,
      friction: grenade.friction ?? 0.7,
      fuse: opts.fuse ?? grenade.fuse ?? 3,
      sticky: grenade.sticky ?? false,
      owner: opts.owner ?? null,
      team: opts.team ?? opts.owner?.team ?? 'neutral',
      radius: 0.09,
      trail: null,
      explosion: grenade.damage > 0 ? grenade : null,
      smoke: grenade.blocksVision ? grenade : null,
      effect: grenade.blocksVision ? 'smokeGrenadePop' : null,
      lifetime: opts.lifetime ?? (grenade.duration ? grenade.duration + 5 : 8),
      ignore: opts.ignore ?? null,
    });
    projectile.grenade = grenade;
    projectile.owner = opts.owner ?? null;
    this.projectiles.push(projectile);
    this.stats.projectiles++;
    this.ProjectileSpawned.emit({ projectile, grenade, opts });
    return projectile;
  }

  /** Area-of-effect helpers used by gas/incendiary/flash (called by the gameplay layer). */
  areaEffect(position, { radius, onActor, type = DamageType.Gas, damagePerSecond = 0, duration = 1, attacker = null }) {
    const affected = [];
    for (const [actor] of this.actors) {
      if (!actor.position) continue;
      const distance = actor.position.distanceTo(position);
      if (distance > radius) continue;
      const falloff = 1 - clamp01(distance / radius);
      if (onActor) onActor(actor, falloff, this);
      if (damagePerSecond > 0) {
        this.applyDamage(actor, new DamageInfo({
          amount: damagePerSecond * duration * falloff,
          type,
          attacker,
          point: actor.position.clone(),
          direction: _v14.copy(actor.position).sub(position).normalize(),
          distance,
          hitZone: HitZone.Torso,
        }));
      }
      affected.push(actor);
    }
    return affected;
  }

  update(dt) {
    this.time += dt;
    this.updateActors();
    this.updateProjectiles(dt);
    this._updateVolumes(dt);
    return this;
  }

  getStats() {
    return { ...this.stats, projectiles: this.projectiles.length, actors: this.actors.size, accuracy: this.stats.shots ? this.stats.hits / this.stats.shots : 0 };
  }
}

// ---------------------------------------------------------------------------
// analytic ray tests
// ---------------------------------------------------------------------------

/** Ray/sphere intersection returning the entry distance (0 when starting inside). */
export function raySphere(origin, direction, center, radius, maxDistance) {
  const ox = origin.x - center.x, oy = origin.y - center.y, oz = origin.z - center.z;
  const b = ox * direction.x + oy * direction.y + oz * direction.z;
  const c = ox * ox + oy * oy + oz * oz - radius * radius;
  if (c > 0 && b > 0) return null;
  const discriminant = b * b - c;
  if (discriminant < 0) return null;
  let t = -b - Math.sqrt(discriminant);
  if (t < 0) t = 0;
  return t <= maxDistance ? t : null;
}

/** Ray/AABB intersection (slab method) returning the entry distance. */
export function rayBox(origin, direction, center, halfExtents, maxDistance) {
  let tmin = 0;
  let tmax = maxDistance;
  for (let axis = 0; axis < 3; axis++) {
    const key = axis === 0 ? 'x' : axis === 1 ? 'y' : 'z';
    const o = origin[key] - center[key];
    const d = direction[key];
    const h = halfExtents[key];
    if (Math.abs(d) < 1e-8) {
      if (o < -h || o > h) return null;
      continue;
    }
    const inv = 1 / d;
    let t1 = (-h - o) * inv;
    let t2 = (h - o) * inv;
    if (t1 > t2) { const tmp = t1; t1 = t2; t2 = tmp; }
    if (t1 > tmin) tmin = t1;
    if (t2 < tmax) tmax = t2;
    if (tmin > tmax) return null;
  }
  return tmin;
}

/** Shortest distance between a point and a segment (smoke volumes use this for vision tests). */
export function pointToSegmentDistance(point, a, b) {
  const abx = b.x - a.x, aby = b.y - a.y, abz = b.z - a.z;
  const apx = point.x - a.x, apy = point.y - a.y, apz = point.z - a.z;
  const lengthSq = abx * abx + aby * aby + abz * abz;
  const t = lengthSq > 1e-9 ? clamp01((apx * abx + apy * aby + apz * abz) / lengthSq) : 0;
  const dx = apx - abx * t, dy = apy - aby * t, dz = apz - abz * t;
  return Math.sqrt(dx * dx + dy * dy + dz * dz);
}

/** Spread cone sampling helper shared by weapons and AI. */
export function sampleCone(direction, spreadRadians, rng, out = new Vector3()) {
  const angle = rng.nextNumber(0, Math.PI * 2);
  const radius = Math.sqrt(rng.random()) * Math.tan(spreadRadians);
  const right = _cRight.set(0, 1, 0).cross(direction);
  if (right.sqrMagnitude < 1e-6) right.set(1, 0, 0).cross(direction);
  right.normalize();
  const up = _cUp.copy(direction).cross(right).normalize();
  return out.copy(direction).addScaled(right, Math.cos(angle) * radius).addScaled(up, Math.sin(angle) * radius).normalize();
}

const _v1 = new Vector3();
const _v2 = new Vector3();
const _v3 = new Vector3();
const _v4 = new Vector3();
const _v5 = new Vector3();
const _v6 = new Vector3();
const _v7 = new Vector3();
const _v8 = new Vector3();
const _v9 = new Vector3();
const _v10 = new Vector3();
const _v11 = new Vector3();
const _v12 = new Vector3();
const _v13 = new Vector3();
const _v14 = new Vector3();
const _v15 = new Vector3();
const _v16 = new Vector3();
const _up = new Vector3(0, 1, 0);
const _cRight = new Vector3();
const _cUp = new Vector3();
void clamp;

export default BallisticsSystem;
