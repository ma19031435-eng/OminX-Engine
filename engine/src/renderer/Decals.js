/**
 * OminX Engine — decal system.
 *
 * Bullet holes, blood splatter, scorch marks and glass cracks. Implemented as an instanced
 * quad ring buffer: when the buffer wraps, the oldest decal is recycled, so the cost per map
 * is fixed no matter how many shots are fired. This is exactly how an FPS keeps a firefight
 * from degrading framerate after ten thousand rounds.
 *
 * @module engine/renderer/Decals
 */
import { Vector3 } from '../math/Vector3.js';
import { Color3 } from '../math/Color3.js';
import { Matrix4 } from '../math/Matrix4.js';
import { Quaternion } from '../math/Quaternion.js';
import { Mesh } from '../geometry/Mesh.js';
import { InstancedBatch, RenderLayer } from './RenderList.js';
import { AlphaMode, RenderQueue } from './Material.js';
import { RNG } from '../math/Random.js';
import { clamp01, lerp } from '../math/MathUtils.js';

/** Decal kinds → atlas cell (4×4 grid produced by `makeDecalAtlas`). */
export const DecalKind = {
  Concrete: { cell: 0, size: [0.16, 0.16], color: '#c9c5bd', life: 26 },
  Metal: { cell: 3, size: [0.15, 0.15], color: '#e2e2e6', life: 26 },
  Wood: { cell: 7, size: [0.16, 0.16], color: '#c9a273', life: 26 },
  Sand: { cell: 6, size: [0.2, 0.2], color: '#cbbd9b', life: 22 },
  Flesh: { cell: 1, size: [0.3, 0.3], color: '#c8332f', life: 30 },
  Blood: { cell: 1, size: [0.42, 0.42], color: '#9c2220', life: 34 },
  BloodPool: { cell: 4, size: [1.5, 1.5], color: '#8c1a18', life: 60 },
  Scorch: { cell: 2, size: [2.4, 2.4], color: '#6a6259', life: 42 },
  Glass: { cell: 5, size: [0.6, 0.6], color: '#dff2f8', life: 30 },
};

/** Material name → decal kind, so shots automatically match the surface they hit. */
export const MaterialToDecal = {
  concrete: 'Concrete', concreteDark: 'Concrete', brick: 'Concrete', rock: 'Concrete',
  metal: 'Metal', rust: 'Metal', hazard: 'Metal', WeaponGunmetal: 'Metal', BotArmor: 'Metal',
  wood: 'Wood', sandbag: 'Sand', dirt: 'Sand', grass: 'Sand', foliage: 'Sand', sand: 'Sand',
  glass: 'Glass', WindowedWall: 'Glass',
  CharacterSkin: 'Flesh', CharacterMid: 'Flesh', CharacterDark: 'Flesh', CharacterVest: 'Flesh',
  CharacterHelmet: 'Flesh', CharacterGlove: 'Flesh', CharacterBoot: 'Flesh', CharacterPants: 'Flesh',
  CharacterPouch: 'Flesh', CharacterPack: 'Flesh', PlayerSkin: 'Flesh',
};

export function createDecalQuad(segments = 1) {
  // A slightly subdivided quad; the subdivision is unused for flat surfaces but lets us
  // curve the decal around a cylinder later (barrels, poles) without changing the shader.
  const positions = [];
  const uvs = [];
  const normals = [];
  const indices = [];
  const n = Math.max(1, segments);
  for (let y = 0; y <= n; y++) {
    for (let x = 0; x <= n; x++) {
      const u = x / n, v = y / n;
      positions.push(u - 0.5, v - 0.5, 0);
      normals.push(0, 0, 1);
      uvs.push(u, v);
    }
  }
  for (let y = 0; y < n; y++) {
    for (let x = 0; x < n; x++) {
      const a = y * (n + 1) + x;
      const b = a + 1;
      const c = a + (n + 1);
      const d = c + 1;
      indices.push(a, c, b, b, c, d);
    }
  }
  return new Mesh({ name: 'DecalQuad', positions, normals, uvs, indices });
}

export class DecalSystem {
  /**
   * @param {import('./gl/GLDevice.js').GLDevice} device
   * @param {object} textures
   * @param {object} [opts]
   * @param {number} [opts.capacity=640] max simultaneous decals (ring buffer)
   */
  constructor(device, textures, opts = {}) {
    this.device = device;
    this.textures = textures;
    this.capacity = opts.capacity ?? 640;
    this.material = opts.material ?? null;
    this.rng = new RNG(opts.seed ?? 4242);
    this.quad = createDecalQuad(1);
    this.enabled = opts.enabled !== false;

    /** Parallel CPU arrays; the instanced GPU buffer is rebuilt/updated each frame. */
    this.count = 0;
    this.cursor = 0;
    this.decals = new Array(this.capacity);
    for (let i = 0; i < this.capacity; i++) {
      this.decals[i] = {
        active: false, position: new Vector3(), normal: new Vector3(0, 1, 0),
        size: 0.2, color: new Color3(1, 1, 1), cell: 0, life: 0, maxLife: 30,
        rotation: 0, fadeStart: 0.75, alpha: 1, kind: 'Concrete', owner: null,
      };
    }

    this.batch = new InstancedBatch({
      mesh: this.quad,
      material: this.material,
      capacity: this.capacity,
      layer: RenderLayer.Dynamic,
      castShadow: false,
      receiveShadow: false,
      frustumCulled: false,
      name: 'decals',
      vertexColors: true,
      dynamic: true,
    });
    this._matrix = new Matrix4();
    this._quat = new Quaternion();
    this.stats = { active: 0, spawned: 0, recycled: 0 };
    /** Global budget multiplier for low-end devices. */
    this.qualityScale = 1;
    this.maxDistance = opts.maxDistance ?? 90;   // don't waste decals far from the fight
  }

  static create(device, textures, opts) { return new DecalSystem(device, textures, opts); }

  /**
   * Places a decal on a surface.
   * @param {Vector3} position world impact point
   * @param {Vector3} normal surface normal (need not be normalised)
   * @param {string|object} kind decal kind name or definition
   * @param {object} [opts]
   * @param {number} [opts.scale=1]
   * @param {Color3|string} [opts.color]
   * @param {number} [opts.rotation] explicit rotation about the normal
   * @param {number} [opts.alpha=1]
   * @param {object} [opts.owner]
   */
  spawn(position, normal, kind = 'Concrete', opts = {}) {
    if (!this.enabled) return null;
    const def = typeof kind === 'string' ? (DecalKind[kind] ?? DecalKind.Concrete) : kind;
    if (this.rng.random() > (opts.chance ?? 1) * this.qualityScale) return null;

    let decal;
    if (this.count < this.capacity) {
      decal = this.decals[this.count++];
    } else {
      decal = this.decals[this.cursor];
      this.cursor = (this.cursor + 1) % this.capacity;
      this.stats.recycled++;
    }
    const n = normal.clone().normalize();
    decal.active = true;
    decal.position.copy(position).addScaled(n, opts.normalOffset ?? 0.008);
    decal.normal.copy(n);
    const baseSize = (def.size?.[0] ?? 0.2);
    decal.size = baseSize * (opts.scale ?? 1) * (0.85 + this.rng.random() * 0.3);
    const cellDef = def.cell ?? 0;
    decal.cell = cellDef;
    decal.color.copy(opts.color ? (opts.color instanceof Color3 ? opts.color : Color3.fromCSS(opts.color)) : (def.color ? Color3.fromCSS(def.color) : _white));
    decal.life = 0;
    decal.maxLife = (def.life ?? 30) * (opts.lifeScale ?? 1);
    decal.rotation = opts.rotation ?? this.rng.nextNumber(0, Math.PI * 2);
    decal.fadeStart = opts.fadeStart ?? 0.8;
    decal.alpha = opts.alpha ?? 1;
    decal.kind = typeof kind === 'string' ? kind : 'custom';
    decal.owner = opts.owner ?? null;
    this.stats.spawned++;
    return decal;
  }

  /** Convenience: blood pool under a corpse, sized by damage dealt. */
  spawnCorpse(position, scale = 1) {
    return this.spawn(position, _up, 'BloodPool', { scale: 0.8 + scale * 0.6, rotation: this.rng.nextNumber(0, Math.PI * 2) });
  }
  /** Explosion scorch + a ring of small impact marks. */
  spawnExplosion(position, normal, radius = 2.2) {
    this.spawn(position, normal, 'Scorch', { scale: radius * 0.5 });
    const n = Math.floor(6 * this.qualityScale);
    for (let i = 0; i < n; i++) {
      const a = (i / n) * Math.PI * 2;
      const offset = new Vector3(Math.cos(a) * radius * 0.7, 0, Math.sin(a) * radius * 0.7);
      this.spawn(position.clone().add(offset), normal, 'Scorch', { scale: 0.22, alpha: 0.7 });
    }
  }

  update(dt) {
    let active = 0;
    for (let i = 0; i < this.count; i++) {
      const d = this.decals[i];
      if (!d.active) continue;
      d.life += dt;
      if (d.life >= d.maxLife) { d.active = false; continue; }
      active++;
    }
    this.stats.active = active;
    return this;
  }

  /** Rebuilds the instanced batch for this frame. */
  buildBatch(camera) {
    const batch = this.batch;
    batch.count = 0;
    const camPos = camera?.worldPosition;
    for (let i = 0; i < this.count; i++) {
      const d = this.decals[i];
      if (!d.active) continue;
      if (camPos && d.position.distanceTo(camPos) > this.maxDistance) continue;
      // Orientation: decal +Z aligns with the surface normal, random spin about it.
      const rot = _quat.setFromUnitVectors(_forward, d.normal);
      const spin = _quat2.setFromAxisAngle(d.normal, d.rotation);
      _matrix.makeRotationFromQuaternion(_quat2.multiplyQuaternions(spin, rot));
      _matrix.scale_(_v.set(d.size, d.size, 1));
      _matrix.setPosition(d.position);
      const t = d.life / d.maxLife;
      const fade = t < d.fadeStart ? 1 : 1 - clamp01((t - d.fadeStart) / (1 - d.fadeStart));
      const cellU = (d.cell % 4) * 0.25;
      const cellV = Math.floor(d.cell / 4) * 0.25;
      // Shader: instanceParams.xy = uv offset, .z = uv scale.
      batch.add(_matrix, { r: d.color.r, g: d.color.g, b: d.color.b, a: d.alpha * fade }, [cellU, cellV, 0.25, 0]);
      batch._distances ??= [];
      batch._distances[batch.count - 1] = camPos ? d.position.distanceTo(camPos) : 0;
    }
    batch.updateBounds();
    return batch;
  }

  clear() {
    for (let i = 0; i < this.count; i++) this.decals[i].active = false;
    this.count = 0;
    this.cursor = 0;
    return this;
  }
  getStats() { return { ...this.stats, capacity: this.capacity }; }
}

const _v = new Vector3();
const _up = new Vector3(0, 1, 0);
const _forward = new Vector3(0, 0, 1);
const _white = new Color3(1, 1, 1);
const _quat = new Quaternion();
const _quat2 = new Quaternion();
const _matrix = new Matrix4();

export { lerp };
export default DecalSystem;
