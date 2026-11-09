/**
 * OminX Engine — GPU-instanced particle system.
 *
 * One CPU-side pool, one draw call per texture/material. Every FPS effect is a preset here:
 * muzzle smoke and flash, dirt/metal/concrete/flesh impacts, sparks, tracers' glow, blood
 * spray and pools, dust kicked up by footsteps and landings, explosions, smoke grenades,
 * shell casings (simulated physically), bullet whiz-by, respawn burst and healing motes.
 *
 * @module engine/renderer/Particles
 */
import { Vector3 } from '../math/Vector3.js';
import { Color3 } from '../math/Color3.js';
import { Matrix4 } from '../math/Matrix4.js';
import { Mesh } from '../geometry/Mesh.js';
import { InstanceBuffer } from './gl/GeometryBuffer.js';
import { InstancedBatch, RenderLayer } from './RenderList.js';
import { Material, AlphaMode, RenderQueue } from './Material.js';
import { RNG, randomRange } from '../math/Random.js';
import { clamp01, lerp, TAU } from '../math/MathUtils.js';
import { createLogger } from '../core/Logger.js';

const MAX_PARTICLES_DEFAULT = 3000;

/** Instanced quad used by every particle. */
export function createParticleQuad() {
  return new Mesh({
    name: 'ParticleQuad',
    positions: [-0.5, -0.5, 0, 0.5, -0.5, 0, 0.5, 0.5, 0, -0.5, 0.5, 0],
    normals: [0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1],
    uvs: [0, 0, 1, 0, 1, 1, 0, 1],
    indices: [0, 1, 2, 0, 2, 3],
  });
}

/** Trapezoid strip used for tracer streaks (x runs 0..1 along the streak). */
export function createTracerStrip() {
  return new Mesh({
    name: 'TracerStrip',
    positions: [0, -1, 1, 0, 1, 1, 1, 1, 0.35, 1, -1, 0.35],
    normals: [0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1],
    uvs: [0, 0, 0, 1, 1, 1, 1, 0],
    indices: [0, 1, 2, 0, 2, 3],
  });
}

/** Billboard quad used by sprites & muzzle flash overlays. */
export function createBillboardQuad() {
  return new Mesh({
    name: 'Billboard',
    positions: [-0.5, -0.5, 0, 0.5, -0.5, 0, 0.5, 0.5, 0, -0.5, 0.5, 0],
    normals: [0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1],
    uvs: [0, 0, 1, 0, 1, 1, 0, 1],
    indices: [0, 1, 2, 0, 2, 3],
  });
}

export class Particle {
  constructor() {
    this.active = false;
    this.position = new Vector3();
    this.velocity = new Vector3();
    this.prevPosition = new Vector3();
    this.colorStart = new Color3(1, 1, 1);
    this.colorEnd = new Color3(1, 1, 1);
    this.alphaStart = 1;
    this.alphaEnd = 0;
    this.sizeStart = 0.2;
    this.sizeEnd = 0.05;
    this.life = 0;
    this.maxLife = 1;
    this.gravity = -9.81;
    this.drag = 0.6;
    this.rotation = 0;
    this.rotationSpeed = 0;
    this.atlasIndex = 0;
    this.softness = 0.25;
    this.stretch = 0;
    this.collide = false;
    this.bounce = 0;
    this.friction = 0.4;
    this.emissive = 0;
    this.group = 0;
    /** Optional callback fired on death: `(particle, position) => void` (shell casings land). */
    this.onDeath = null;
    this.billboard = 0;
  }
  get t() { return this.maxLife > 0 ? clamp01(this.life / this.maxLife) : 1; }
}

/**
 * ParticleEffect — a reusable emitter description (data, not code), so the editor can build
 * effects without scripting and gameplay can fire them by name.
 */
export const ParticlePresets = {
  muzzleSmoke: {
    count: 6, lifetime: [0.35, 0.8], size: [0.09, 0.32], color: ['#cbc4b6', '#8b8579'],
    speed: [0.7, 2.1], coneAngle: 16, gravity: 1.6, drag: 2.4, texture: 'smoke', alpha: [0.55, 0],
    rotationSpeed: [-1.4, 1.4], softness: 0.4, emissive: 0,
  },
  muzzleFlash: {
    count: 3, lifetime: [0.035, 0.07], size: [0.22, 0.5], color: ['#fff3c4', '#ffa53d'],
    speed: [0.4, 1.2], coneAngle: 25, gravity: 0, drag: 6, texture: 'muzzleFlash', alpha: [1, 0],
    emissive: 1, additive: true, rotationSpeed: [-3, 3], billboard: 0,
  },
  impactDirt: {
    count: 14, lifetime: [0.5, 1.2], size: [0.05, 0.2], color: ['#9d8f72', '#5d5340'],
    speed: [1.5, 5.5], coneAngle: 42, gravity: 6.5, drag: 1.6, texture: 'dust', alpha: [0.8, 0],
    rotationSpeed: [-2, 2], softness: 0.3,
  },
  impactConcrete: {
    count: 12, lifetime: [0.4, 0.9], size: [0.04, 0.16], color: ['#cfcabe', '#8a857a'],
    speed: [2, 6], coneAngle: 38, gravity: 7.2, drag: 1.2, texture: 'dust', alpha: [0.7, 0],
  },
  impactMetal: {
    count: 16, lifetime: [0.25, 0.6], size: [0.03, 0.1], color: ['#fff2b0', '#ff9d2e'],
    speed: [3, 9], coneAngle: 46, gravity: -14, drag: 1.1, texture: 'spark', alpha: [1, 0],
    emissive: 1, additive: true, stretch: 2.2,
  },
  impactWood: {
    count: 10, lifetime: [0.4, 0.9], size: [0.03, 0.12], color: ['#b98a52', '#6b4a26'],
    speed: [1.8, 5], coneAngle: 40, gravity: 6, drag: 1.5, texture: 'dust', alpha: [0.8, 0],
  },
  impactSand: {
    count: 16, lifetime: [0.6, 1.4], size: [0.06, 0.24], color: ['#d8c9a3', '#8f815f'],
    speed: [1.2, 4.5], coneAngle: 50, gravity: 4.5, drag: 2.2, texture: 'smoke', alpha: [0.6, 0],
    softness: 0.5,
  },
  impactBlood: {
    count: 18, lifetime: [0.3, 0.8], size: [0.04, 0.18], color: ['#a30f12', '#5c0708'],
    speed: [2, 7], coneAngle: 46, gravity: 12, drag: 0.8, texture: 'blood', alpha: [0.95, 0.2],
    collide: true, decalOnDeath: 'blood',
  },
  impactGlass: {
    count: 20, lifetime: [0.5, 1.1], size: [0.03, 0.1], color: ['#d8f0f6', '#8fb3bd'],
    speed: [2.5, 8], coneAngle: 55, gravity: 9.8, drag: 0.4, texture: 'spark', alpha: [0.85, 0],
    collide: true,
  },
  bloodSpray: {
    count: 26, lifetime: [0.4, 1.1], size: [0.05, 0.24], color: ['#8f0c0f', '#3d0404'],
    speed: [2.5, 8.5], coneAngle: 34, gravity: 13, drag: 0.7, texture: 'blood', alpha: [1, 0.15],
    collide: true, decalOnDeath: 'blood',
  },
  deathBlood: {
    count: 46, lifetime: [0.6, 1.6], size: [0.09, 0.42], color: ['#8f0c0f', '#2f0303'],
    speed: [3, 11], coneAngle: 62, gravity: 12, drag: 0.6, texture: 'blood', alpha: [1, 0.2],
    collide: true, decalOnDeath: 'blood',
  },
  explosion: {
    count: 60, lifetime: [0.5, 1.6], size: [0.4, 2.6], color: ['#ffd88a', '#403020'],
    speed: [4, 18], coneAngle: 180, gravity: 3.2, drag: 2.0, texture: 'smoke', alpha: [0.95, 0],
    softness: 0.5, rotationSpeed: [-2, 2],
  },
  explosionSparks: {
    count: 40, lifetime: [0.3, 0.9], size: [0.05, 0.18], color: ['#fff6c8', '#ff7a1a'],
    speed: [6, 22], coneAngle: 180, gravity: -12, drag: 0.9, texture: 'spark', alpha: [1, 0],
    additive: true, emissive: 1, stretch: 3,
  },
  grenadeSmoke: {
    count: 40, lifetime: [2.2, 4.5], size: [0.9, 4.5], color: ['#d9d5cc', '#6d6a63'],
    speed: [0.4, 2.2], coneAngle: 180, gravity: 0.35, drag: 1.1, texture: 'smoke', alpha: [0.85, 0],
    softness: 0.6, rotationSpeed: [-0.6, 0.6],
  },
  dust: {
    count: 8, lifetime: [1.2, 2.6], size: [0.12, 0.5], color: ['#b8a98c', '#6b6353'],
    speed: [0.3, 1.4], coneAngle: 70, gravity: 0.4, drag: 2.6, texture: 'dust', alpha: [0.45, 0],
    softness: 0.6,
  },
  footstep: {
    count: 4, lifetime: [0.5, 1.1], size: [0.08, 0.28], color: ['#bdb09a', '#7a6f5c'],
    speed: [0.2, 0.9], coneAngle: 60, gravity: 0.6, drag: 3.2, texture: 'dust', alpha: [0.4, 0],
  },
  bulletWhiz: {
    count: 3, lifetime: [0.1, 0.2], size: [0.05, 0.14], color: ['#fff0c0', '#ffbf66'],
    speed: [0.5, 2], coneAngle: 60, gravity: 0, drag: 5, texture: 'spark', alpha: [0.6, 0],
    additive: true, emissive: 1,
  },
  heal: {
    count: 22, lifetime: [0.7, 1.5], size: [0.08, 0.24], color: ['#7dffc4', '#1f8f5f'],
    speed: [0.6, 2.4], coneAngle: 180, gravity: -1.6, drag: 1.4, texture: 'spark', alpha: [0.8, 0],
    additive: true, emissive: 1,
  },
  respawn: {
    count: 34, lifetime: [0.8, 1.6], size: [0.1, 0.5], color: ['#9fd8ff', '#2a6fa8'],
    speed: [1, 4], coneAngle: 180, gravity: -0.8, drag: 1.2, texture: 'spark', alpha: [0.85, 0],
    additive: true, emissive: 1,
  },
  shellCasing: {
    count: 1, lifetime: [1.4, 2.4], size: [0.028, 0.028], color: ['#d8b25a', '#8a6f2c'],
    speed: [1.6, 3.4], coneAngle: 60, gravity: 11, drag: 0.35, texture: 'spark', alpha: [1, 1],
    collide: true, bounce: 0.32, friction: 0.55, rotationSpeed: [-18, 18],
  },
  waterSplash: {
    count: 24, lifetime: [0.4, 1.1], size: [0.05, 0.3], color: ['#d6f0ff', '#4e7f9c'],
    speed: [1.5, 6], coneAngle: 50, gravity: 9, drag: 1.6, texture: 'smoke', alpha: [0.8, 0],
    softness: 0.4,
  },
  ash: {
    count: 40, lifetime: [3, 7], size: [0.05, 0.16], color: ['#8a8a86', '#3d3d39'],
    speed: [0.1, 0.6], coneAngle: 180, gravity: -0.25, drag: 0.3, texture: 'dust', alpha: [0.5, 0],
    windAffected: true,
  },
  ambientMotes: {
    count: 60, lifetime: [4, 9], size: [0.02, 0.07], color: ['#fff4d0', '#c9b98a'],
    speed: [0.05, 0.5], coneAngle: 180, gravity: -0.05, drag: 0.2, texture: 'spark', alpha: [0.35, 0],
    additive: true, emissive: 0.6, windAffected: true,
  },
};

export const ParticleTextureSlots = {
  smoke: 'smoke', spark: 'spark', blood: 'blood', dust: 'dust', muzzleFlash: 'muzzleFlash',
  tracer: 'tracer', glow: 'glow', ring: 'ring',
};

const _log = createLogger('Particles');

export class ParticleSystem {
  /**
   * @param {import('./gl/GLDevice.js').GLDevice} device
   * @param {object} textures
   * @param {object} [opts]
   */
  constructor(device, textures, opts = {}) {
    this.device = device;
    this.textures = textures;
    this.maxParticles = opts.maxParticles ?? MAX_PARTICLES_DEFAULT;
    this.pool = [];
    for (let i = 0; i < this.maxParticles; i++) this.pool.push(new Particle());
    this.activeCount = 0;
    this.rng = new RNG(opts.seed ?? 20240607);
    this.quad = createParticleQuad();
    this.qualityScale = opts.qualityScale ?? 1;
    this.enabled = true;
    /** Global wind, affects smoke/ash/motes. */
    this.wind = new Vector3(0.6, 0, 0.25);
    this.windStrength = 0.35;
    /** Optional world collision callback: (from, to, radius) => hit|null */
    this.collisionQuery = null;
    /** Callback used by `decalOnDeath`: (position, normal, kind) => void */
    this.decalSpawner = null;
    this.stats = { active: 0, emitted: 0, killed: 0, batches: 0 };
    this._matrices = new Float32Array(this.maxParticles * 16);
    this._colors = new Float32Array(this.maxParticles * 4);
    this._params = new Float32Array(this.maxParticles * 4);
    this._scratchMatrix = new Matrix4();
    this._textureGroups = new Map();
    /** Named effect registry so gameplay/editor can fire presets by name. */
    this.effects = new Map(Object.entries(ParticlePresets).map(([k, v]) => [k, { name: k, ...v }]));
  }

  static create(device, textures, opts) { return new ParticleSystem(device, textures, opts); }

  registerEffect(name, def) { this.effects.set(name, { name, ...def }); return this; }
  getEffect(name) { return this.effects.get(name); }
  listEffects() { return [...this.effects.keys()]; }

  /** Finds a free particle, or steals the oldest one when the budget is exhausted. */
  _spawn() {
    for (let i = 0; i < this.pool.length; i++) {
      const p = this.pool[i];
      if (!p.active) { p.active = true; return p; }
    }
    // steal the one closest to death
    let best = this.pool[0], bestT = -1;
    for (const p of this.pool) { const t = p.t; if (t > bestT) { bestT = t; best = p; } }
    return best;
  }

  /**
   * Emits a particle effect.
   * @param {string|object} effect preset name or definition
   * @param {Vector3} position
   * @param {object} [opts]
   * @param {Vector3} [opts.direction] emission axis (cone around it)
   * @param {Color3} [opts.color] override base color
   * @param {number} [opts.scale] size multiplier
   * @param {number} [opts.speedScale]
   * @param {number} [opts.count] override particle count
   * @param {object} [opts.follow] { position, offset } to make the effect follow a moving object
   */
  emit(effect, position, opts = {}) {
    if (!this.enabled) return [];
    const def = typeof effect === 'string' ? this.effects.get(effect) : effect;
    if (!def) {
      if (this._warnedMissing?.has(effect)) return [];
      (this._warnedMissing ??= new Set()).add(effect);
      _log.warn(typeof effect === 'string' ? `unknown particle effect "${effect}"` : 'emit() called with an undefined effect definition');
      return [];
    }
    const count = Math.max(1, Math.round((opts.count ?? def.count ?? 1) * (def.budgetScale ?? 1) * this.qualityScale));
    const dir = opts.direction ? opts.direction.clone().normalize() : new Vector3(0, 1, 0);
    const spawned = [];
    const speedRange = def.speed ?? [1, 3];
    const lifeRange = def.lifetime ?? [0.5, 1];
    const sizeRange = def.size ?? [0.1, 0.3];
    for (let i = 0; i < count; i++) {
      const p = this._spawn();
      if (!p) break;
      p.position.copy(position);
      if (opts.positionJitter) {
        p.position.x += this.rng.nextNumber(-opts.positionJitter, opts.positionJitter);
        p.position.y += this.rng.nextNumber(-opts.positionJitter, opts.positionJitter);
        p.position.z += this.rng.nextNumber(-opts.positionJitter, opts.positionJitter);
      }
      const angle = (def.coneAngle ?? 30) * Math.PI / 180;
      p.velocity.copy(this.rng.nextConeDirection(dir, angle)).scale(this.rng.nextNumber(speedRange[0], speedRange[1]) * (opts.speedScale ?? 1));
      const c0 = pickColor(def.color?.[0] ?? '#ffffff', opts.color);
      const c1 = pickColor(def.color?.[1] ?? def.color?.[0] ?? '#ffffff', opts.color);
      p.colorStart.copy(c0);
      p.colorEnd.copy(c1);
      p.alphaStart = def.alpha?.[0] ?? 1;
      p.alphaEnd = def.alpha?.[1] ?? 0;
      p.sizeStart = this.rng.nextNumber(sizeRange[0], sizeRange[1]) * (opts.scale ?? 1);
      p.sizeEnd = p.sizeStart * (def.sizeEndScale ?? 0.35) * (opts.scale ?? 1);
      p.maxLife = this.rng.nextNumber(lifeRange[0], lifeRange[1]);
      p.life = 0;
      p.gravity = def.gravity ?? -9.81;
      p.drag = def.drag ?? 1;
      p.rotation = this.rng.nextNumber(0, TAU);
      p.rotationSpeed = this.rng.nextNumber(def.rotationSpeed?.[0] ?? -1, def.rotationSpeed?.[1] ?? 1);
      p.atlasIndex = def.atlasIndex ?? this.rng.nextInteger(0, 7);
      p.softness = def.softness ?? 0.25;
      p.stretch = def.stretch ?? 0;
      p.collide = def.collide ?? false;
      p.bounce = def.bounce ?? 0;
      p.friction = def.friction ?? 0.4;
      p.emissive = def.emissive ?? 0;
      p.billboard = def.billboard ?? 0;
      p.texture = def.texture ?? 'smoke';
      p.additive = def.additive ?? (p.emissive > 0.5);
      p.decalOnDeath = def.decalOnDeath ?? null;
      p.windAffected = def.windAffected ?? false;
      p.onDeath = opts.onDeath ?? null;
      p.prevPosition.copy(p.position);
      spawned.push(p);
      this.stats.emitted++;
    }
    return spawned;
  }

  /** Fire and forget along a ray — used for impacts: hitscan point + surface normal. */
  emitImpact(position, normal, materialKind = 'concrete', opts = {}) {
    const table = {
      concrete: 'impactConcrete', dirt: 'impactDirt', sand: 'impactSand',
      metal: 'impactMetal', wood: 'impactWood', flesh: 'impactBlood', blood: 'impactBlood',
      glass: 'impactGlass', water: 'waterSplash', foliage: 'impactSand', rock: 'impactConcrete',
    };
    const effect = table[materialKind] ?? 'impactConcrete';
    const dir = normal.clone().negate();
    return this.emit(effect, position, { direction: dir, ...opts });
  }

  /**
   * @param {number} dt
   * @param {object} [ctx] { camera, wind, gravity }
   */
  update(dt, ctx = {}) {
    const camPos = ctx.camera?.worldPosition;
    let active = 0;
    for (let i = 0; i < this.pool.length; i++) {
      const p = this.pool[i];
      if (!p.active) continue;
      p.life += dt;
      if (p.life >= p.maxLife) {
        p.active = false;
        this.stats.killed++;
        if (p.decalOnDeath && this.decalSpawner) this.decalSpawner(p.position, p.decalOnDeath);
        p.onDeath?.(p);
        continue;
      }
      active++;
      p.prevPosition.copy(p.position);
      // integrate
      p.velocity.y -= p.gravity * dt;
      const damp = Math.max(0, 1 - p.drag * dt);
      p.velocity.scale(damp);
      if (p.windAffected) p.velocity.addScaled(this.wind, this.windStrength * dt * 12);
      else p.velocity.addScaled(this.wind, this.windStrength * dt * 1.5);
      const stepX = p.velocity.x * dt, stepY = p.velocity.y * dt, stepZ = p.velocity.z * dt;
      if (p.collide && this.collisionQuery && (Math.abs(stepX) + Math.abs(stepY) + Math.abs(stepZ)) > 1e-5) {
        const hit = this.collisionQuery(p.position, p.velocity, dt, p.sizeStart * 0.5);
        if (hit) {
          p.position.copy(hit.point).addScaled(hit.normal, p.sizeStart * 0.35);
          const vn = p.velocity.dot(hit.normal);
          p.velocity.addScaled(hit.normal, -(1 + p.bounce) * vn);
          p.velocity.scale(Math.max(0, 1 - p.friction));
          if (p.decalOnDeath && Math.abs(vn) > 1.4 && this.decalSpawner) this.decalSpawner(p.position, p.decalOnDeath, hit.normal);
        } else {
          p.position.x += stepX; p.position.y += stepY; p.position.z += stepZ;
        }
      } else {
        p.position.x += stepX; p.position.y += stepY; p.position.z += stepZ;
      }
      p.rotation += p.rotationSpeed * dt;
    }
    this.activeCount = active;
    this.stats.active = active;
    void camPos;
    return this;
  }

  /**
   * Builds the instanced batches for this frame (one per particle texture).
   * @param {import('./Camera.js').Camera} camera
   * @returns {InstancedBatch[]}
   */
  buildBatches(camera, materials) {
    const groups = this._textureGroups;
    groups.clear();
    const camPos = camera.worldPosition;
    for (const p of this.pool) {
      if (!p.active) continue;
      const key = p.texture ?? 'smoke';
      let batch = groups.get(key);
      if (!batch) {
        batch = new InstancedBatch({
          mesh: this.quad,
          material: materials.get(key) ?? materials.get('Smoke'),
          capacity: Math.min(this.maxParticles, 512),
          layer: RenderLayer.Dynamic,
          castShadow: false,
          receiveShadow: false,
          name: `particles_${key}`,
          vertexColors: true,
          frustumCulled: false,
        });
        batch.texKey = key;
        groups.set(key, batch);
      }
      const t = 1 - p.t;
      const size = p.sizeStart * t + p.sizeEnd * (1 - t);
      const cr = p.colorStart.r * t + p.colorEnd.r * (1 - t);
      const cg = p.colorStart.g * t + p.colorEnd.g * (1 - t);
      const cb = p.colorStart.b * t + p.colorEnd.b * (1 - t);
      const alpha = p.alphaStart * t + p.alphaEnd * (1 - t);
      // Shader semantics: m0 = centre.xyz + size, m1 = velocity.xyz, m2 = rgb + alpha.
      batch.addRaw(
        [p.position.x, p.position.y, p.position.z, size],
        [p.velocity.x, p.velocity.y, p.velocity.z, 0],
        [cr, cg, cb, alpha],
        [0, 0, 0, 0],
        [1, 1, 1, 1],
        [p.rotation, p.atlasIndex, p.softness, p.stretch],
      );
      const dist = p.position.distanceTo(camPos);
      batch._distances ??= [];
      batch._distances[batch.count - 1] = dist;
    }
    const out = [];
    for (const batch of groups.values()) {
      batch.updateBounds();
      out.push(batch);
    }
    this.stats.batches = out.length;
    return out;
  }

  clear() {
    for (const p of this.pool) p.active = false;
    this.activeCount = 0;
    return this;
  }

  /** Adaptive quality: reduces the effect count when the frame budget is tight. */
  setQualityScale(scale) { this.qualityScale = clamp01(scale); return this; }
  setMaxParticles(max) {
    this.maxParticles = max;
    while (this.pool.length < max) this.pool.push(new Particle());
    if (this.pool.length > max) this.pool.length = max;
    return this;
  }
  getStats() { return { ...this.stats, capacity: this.pool.length, qualityScale: this.qualityScale }; }
}

const _c = new Color3();
function pickColor(colorDef, override) {
  if (override) return override;
  if (colorDef instanceof Color3) return colorDef;
  if (typeof colorDef === 'string') return Color3.fromCSS(colorDef);
  return _c.set(colorDef?.[0] ?? 1, colorDef?.[1] ?? 1, colorDef?.[2] ?? 1);
}

export { randomRange, lerp };
export default ParticleSystem;
