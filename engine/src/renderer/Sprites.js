/**
 * OminX Engine — sprites, tracers, debug lines and 3D text.
 *
 * These are the "shoot feedback" primitives of an FPS project: a tracer streak you can read
 * in the corner of your eye, a muzzle flash quad glued to the barrel, a hit marker that
 * floats where you hit, blood pools on the ground, bot name tags, damage numbers, and the
 * debug lines the editor draws for vision cones and navigation meshes.
 *
 * @module engine/renderer/Sprites
 */
import { Vector3 } from '../math/Vector3.js';
import { Color3 } from '../math/Color3.js';
import { Vector3 as V3 } from '../math/Vector3.js';
import { Matrix4 } from '../math/Matrix4.js';
import { Quaternion } from '../math/Quaternion.js';
import { Shader, GLSL } from './gl/Shader.js';
import { ShaderSources } from './shaders/index.js';
import { GeometryBuffer } from './gl/GeometryBuffer.js';
import { InstancedBatch, RenderLayer } from './RenderList.js';
import { createBillboardQuad, createTracerStrip } from './Particles.js';
import { clamp01, lerp } from '../math/MathUtils.js';
import { RNG } from '../math/Random.js';

// ---------------------------------------------------------------------------
// Sprites (billboards in world space)
// ---------------------------------------------------------------------------
export class SpriteSystem {
  constructor(device, textures, opts = {}) {
    this.device = device;
    this.textures = textures;
    this.maxSprites = opts.maxSprites ?? 256;
    this.sprites = [];
    this.quad = createBillboardQuad();
    this.rng = new RNG(9182);
    this.materials = opts.materials ?? null;
    this.stats = { active: 0 };
    this._matrix = new Matrix4();
    for (let i = 0; i < this.maxSprites; i++) {
      this.sprites.push({
        active: false, position: new Vector3(), size: [0.2, 0.2], color: new Color3(1, 1, 1),
        alpha: 1, texture: 'glow', life: 0, maxLife: 1, billboard: true, rotation: 0,
        uvOffset: [0, 0], uvScale: [1, 1], follow: null, followOffset: new Vector3(),
        additive: true, onExpire: null, normalizedAge: 0, spin: 0, scaleCurve: null,
      });
    }
    this._batches = new Map();
  }
  static create(device, textures, opts) { return new SpriteSystem(device, textures, opts); }

  /** @returns {object} the sprite handle so callers can move/animate or kill it. */
  add(opts = {}) {
    let sprite = this.sprites.find((s) => !s.active);
    if (!sprite) {
      // recycle the oldest
      let oldest = this.sprites[0];
      for (const s of this.sprites) if (s.normalizedAge > oldest.normalizedAge) oldest = s;
      sprite = oldest;
    }
    sprite.active = true;
    sprite.position.copy(opts.position ?? _zero);
    sprite.size[0] = opts.size?.[0] ?? opts.size ?? 0.2;
    sprite.size[1] = opts.size?.[1] ?? opts.size ?? 0.2;
    sprite.color.copy(opts.color ? (opts.color instanceof Color3 ? opts.color : Color3.fromCSS(opts.color)) : _white);
    sprite.alpha = opts.alpha ?? 1;
    sprite.texture = opts.texture ?? 'glow';
    sprite.life = 0;
    sprite.maxLife = opts.life ?? 0.12;
    sprite.billboard = opts.billboard !== false;
    sprite.rotation = opts.rotation ?? 0;
    sprite.spin = opts.spin ?? 0;
    sprite.uvOffset = opts.uvOffset ?? [0, 0];
    sprite.uvScale = opts.uvScale ?? [1, 1];
    sprite.follow = opts.follow ?? null;
    sprite.followOffset.copy(opts.followOffset ?? _zero);
    sprite.additive = opts.additive !== false;
    sprite.onExpire = opts.onExpire ?? null;
    sprite.normalizedAge = 0;
    sprite.scaleCurve = opts.scaleCurve ?? null;
    sprite.materialName = opts.materialName ?? (sprite.additive ? 'MuzzleFlash' : 'Smoke');
    return sprite;
  }

  /** Tracer-style sprite travelling from A to B; used for fast bullets and thrown knives. */
  addProjectile(start, end, opts = {}) {
    const sprite = this.add({
      position: start.clone(),
      size: opts.size ?? 0.18,
      color: opts.color ?? '#ffd98a',
      life: opts.life ?? 0.4,
      texture: opts.texture ?? 'glow',
    });
    sprite.projectile = {
      start: start.clone(), end: end.clone(),
      speed: opts.speed ?? 140,
      velocity: end.clone().sub(start).normalize().scale(opts.speed ?? 140),
    };
    return sprite;
  }

  update(dt) {
    let active = 0;
    for (const s of this.sprites) {
      if (!s.active) continue;
      s.life += dt;
      if (s.life >= s.maxLife) {
        s.active = false;
        s.onExpire?.(s);
        continue;
      }
      active++;
      s.normalizedAge = s.life / s.maxLife;
      s.rotation += s.spin * dt;
      if (s.follow) s.position.copy(s.follow).add(s.followOffset);
      if (s.projectile) {
        s.position.addScaled(s.projectile.velocity, dt);
        if (s.position.distanceTo(s.projectile.end) < 0.4) s.position.copy(s.projectile.end);
      }
    }
    this.stats.active = active;
    return this;
  }

  /** Sprite batches are grouped by texture+blend so the whole frame costs a few draws. */
  buildBatches(materials) {
    const batches = new Map();
    for (const s of this.sprites) {
      if (!s.active) continue;
      const key = `${s.texture}_${s.additive ? 'add' : 'alpha'}`;
      let batch = batches.get(key);
      if (!batch) {
        batch = new InstancedBatch({
          mesh: this.quad,
          material: materials.get(s.materialName) ?? materials.get('MuzzleFlash'),
          capacity: 128,
          layer: RenderLayer.Dynamic,
          castShadow: false,
          receiveShadow: false,
          frustumCulled: false,
          name: `sprites_${key}`,
          vertexColors: true,
        });
        batch.texKey = s.texture;
        batch.billboard = s.billboard;
        batch.additive = s.additive;
        batches.set(key, batch);
      }
      const m = this._matrix;
      m.makeRotationZ(s.rotation);
      m.scale_(_v.set(s.size[0], s.size[1], 1));
      m.setPosition(s.position);
      // Sprites use a shader with per-instance UV rects -> pack them into params.
      batch.add(m, { r: s.color.r, g: s.color.g, b: s.color.b, a: s.alpha * (1 - Math.pow(s.normalizedAge, 3)) }, [s.uvOffset[0], s.uvOffset[1], s.uvScale[0], s.uvScale[1]]);
    }
    return [...batches.values()];
  }

  clear() { for (const s of this.sprites) s.active = false; return this; }
}

// ---------------------------------------------------------------------------
// Tracers
// ---------------------------------------------------------------------------
export class TracerSystem {
  constructor(device, opts = {}) {
    this.device = device;
    this.maxTracers = opts.maxTracers ?? 160;
    this.tracers = [];
    this.mesh = createTracerStrip();
    this.rng = new RNG(5150);
    for (let i = 0; i < this.maxTracers; i++) {
      this.tracers.push({
        active: false, start: new Vector3(), end: new Vector3(), head: 0,
        speed: 260, color: new Color3(1, 0.86, 0.5), width: 0.035, intensity: 1,
        life: 0, maxLife: 0.5, beam: false, opacity: 1,
      });
    }
    this.stats = { active: 0 };
  }
  static create(device, opts) { return new TracerSystem(device, opts); }

  /**
   * Fires a tracer that visibly travels from the muzzle to the impact point.
   * Only ~1 in N rounds gets a visible tracer in real games; gameplay code controls that.
   */
  fire(start, end, opts = {}) {
    const t = this._acquire();
    t.active = true;
    t.start.copy(start);
    t.end.copy(end);
    t.head = 0;
    t.speed = opts.speed ?? 280;
    t.color.copy(opts.color ? Color3.fromCSS(opts.color) : _tracerColor);
    t.width = opts.width ?? 0.03;
    t.intensity = opts.intensity ?? 1;
    t.life = 0;
    t.maxLife = opts.life ?? 0.45;
    t.beam = false;
    t.opacity = 1;
    return t;
  }

  /** Instant beam (sniper, lasers, lightning) that fades out in place. */
  beam(start, end, opts = {}) {
    const t = this._acquire();
    t.active = true;
    t.start.copy(start);
    t.end.copy(end);
    t.head = 1;
    t.speed = 0;
    t.color.copy(opts.color ? Color3.fromCSS(opts.color) : _tracerColor);
    t.width = opts.width ?? 0.02;
    t.intensity = opts.intensity ?? 1.4;
    t.life = 0;
    t.maxLife = opts.life ?? 0.08;
    t.beam = true;
    t.opacity = 1;
    return t;
  }

  _acquire() {
    for (const t of this.tracers) if (!t.active) return t;
    let oldest = this.tracers[0];
    for (const t of this.tracers) if (t.life > oldest.life) oldest = t;
    return oldest;
  }

  update(dt) {
    const total = this.tracers.length;
    let active = 0;
    for (let i = 0; i < total; i++) {
      const t = this.tracers[i];
      if (!t.active) continue;
      t.life += dt;
      if (t.life >= t.maxLife) { t.active = false; continue; }
      active++;
      if (!t.beam) t.head = clamp01(t.head + (t.speed * dt) / Math.max(t.end.distanceTo(t.start), 0.01));
      t.opacity = t.beam ? 1 - t.life / t.maxLife : Math.min(1, (1 - t.life / t.maxLife) * 2.2);
    }
    this.stats.active = active;
    return this;
  }

  buildBatch(material) {
    const batch = new InstancedBatch({
      mesh: this.mesh,
      material,
      capacity: this.maxTracers,
      layer: RenderLayer.Dynamic,
      castShadow: false,
      receiveShadow: false,
      frustumCulled: false,
      name: 'tracers',
      vertexColors: true,
    });
    // Shader semantics: m0 = start.xyz + width, m1 = end.xyz + intensity,
    // m2 = color.rgb + life, m3 unused.
    for (const t of this.tracers) {
      if (!t.active) continue;
      const end = t.beam ? t.end : t.start.clone().lerp(t.end, t.head);
      batch.addRaw(
        [t.start.x, t.start.y, t.start.z, t.width],
        [end.x, end.y, end.z, t.intensity],
        [t.color.r, t.color.g, t.color.b, t.opacity],
        [0, 0, 0, 0],
        [1, 1, 1, 1],
        [0, 0, 0, 0],
      );
    }
    batch.updateBounds();
    return batch;
  }
  clear() { for (const t of this.tracers) t.active = false; return this; }
}

// ---------------------------------------------------------------------------
// Lines — editor grids, gizmos, ray debug, bot navigation
// ---------------------------------------------------------------------------
export class LineSystem {
  constructor(device, opts = {}) {
    this.device = device;
    this.maxLines = opts.maxLines ?? 4096;
    this.positions = new Float32Array(this.maxLines * 2 * 3);
    this.colors = new Float32Array(this.maxLines * 2 * 4);
    this.count = 0;
    this.depthTest = opts.depthTest !== false;
    this.shader = device.createShader({
      name: 'lines',
      vertex: ShaderSources.LINE_VERTEX,
      fragment: ShaderSources.LINE_FRAGMENT,
      attributes: ['position', 'normal', 'uv', 'uv1', 'color'],
    });
    // Backend-neutral dynamic line buffers (VAO + bufferSubData on WebGL, vertex buffers on WebGPU).
    this.lineGeometry = device.createLineGeometry(this.maxLines * 2);
    this.tint = new Color3(1, 1, 1);
    this.opacity = 1;
  }
  static create(device, opts) { return new LineSystem(device, opts); }

  clear() { this.count = 0; return this; }
  get isFull() { return this.count >= this.maxLines; }

  line(a, b, color = '#ffffff', alpha = 1) {
    if (this.count >= this.maxLines) return this;
    const i = this.count * 6;
    this.positions[i] = a.x; this.positions[i + 1] = a.y; this.positions[i + 2] = a.z;
    this.positions[i + 3] = b.x; this.positions[i + 4] = b.y; this.positions[i + 5] = b.z;
    const c = color instanceof Color3 ? color : Color3.fromCSS(color);
    const j = this.count * 8;
    for (const k of [0, 1]) {
      this.colors[j + k * 4] = c.r;
      this.colors[j + k * 4 + 1] = c.g;
      this.colors[j + k * 4 + 2] = c.b;
      this.colors[j + k * 4 + 3] = alpha;
    }
    this.count++;
    return this;
  }
  ray(origin, direction, length, color, alpha) {
    return this.line(origin, _v.copy(direction).normalize().scale(length).add(origin), color, alpha);
  }
  box(aabb, color = '#44ff88', alpha = 1) {
    const { min, max } = aabb;
    const c = [
      new Vector3(min.x, min.y, min.z), new Vector3(max.x, min.y, min.z),
      new Vector3(max.x, min.y, max.z), new Vector3(min.x, min.y, max.z),
      new Vector3(min.x, max.y, min.z), new Vector3(max.x, max.y, min.z),
      new Vector3(max.x, max.y, max.z), new Vector3(min.x, max.y, max.z),
    ];
    const edges = [[0, 1], [1, 2], [2, 3], [3, 0], [4, 5], [5, 6], [6, 7], [7, 4], [0, 4], [1, 5], [2, 6], [3, 7]];
    for (const [i, j] of edges) this.line(c[i], c[j], color, alpha);
    return this;
  }
  sphere(center, radius, color = '#88ccff', alpha = 1, segments = 12) {
    for (let axis = 0; axis < 3; axis++) {
      for (let i = 0; i < segments; i++) {
        const a0 = (i / segments) * Math.PI * 2;
        const a1 = ((i + 1) / segments) * Math.PI * 2;
        const p0 = _v.set(0, 0, 0);
        const p1 = _v2.set(0, 0, 0);
        if (axis === 0) { p0.set(0, Math.cos(a0), Math.sin(a0)); p1.set(0, Math.cos(a1), Math.sin(a1)); }
        else if (axis === 1) { p0.set(Math.cos(a0), 0, Math.sin(a0)); p1.set(Math.cos(a1), 0, Math.sin(a1)); }
        else { p0.set(Math.cos(a0), Math.sin(a0), 0); p1.set(Math.cos(a1), Math.sin(a1), 0); }
        this.line(p0.scale(radius).add(center), p1.scale(radius).add(center), color, alpha);
      }
    }
    return this;
  }
  capsule(start, end, radius, color = '#ffdd55', alpha = 1) {
    const axis = _v.copy(end).sub(start);
    const len = axis.magnitude;
    const dir = axis.clone().scale(1 / Math.max(len, 1e-6));
    const up = Math.abs(dir.y) > 0.9 ? _v2.set(1, 0, 0) : _v2.set(0, 1, 0);
    const right = _v3.crossVectors(dir, up).normalize();
    const upPerp = _v4.crossVectors(right, dir).normalize();
    const rings = 6;
    for (let i = 0; i <= rings; i++) {
      const t = i / rings;
      const center = start.clone().lerp(end, t);
      for (let s = 0; s < 8; s++) {
        const a0 = (s / 8) * Math.PI * 2;
        const a1 = ((s + 1) / 8) * Math.PI * 2;
        const p0 = center.clone().addScaled(right, Math.cos(a0) * radius).addScaled(upPerp, Math.sin(a0) * radius);
        const p1 = center.clone().addScaled(right, Math.cos(a1) * radius).addScaled(upPerp, Math.sin(a1) * radius);
        this.line(p0, p1, color, alpha);
      }
    }
    return this;
  }
  cross(position, size = 0.25, color = '#ffffff', alpha = 1) {
    this.line(position.clone().add(_v.set(size, 0, 0)), position.clone().add(_v.set(-size, 0, 0)), color, alpha);
    this.line(position.clone().add(_v.set(0, size, 0)), position.clone().add(_v.set(0, -size, 0)), color, alpha);
    this.line(position.clone().add(_v.set(0, 0, size)), position.clone().add(_v.set(0, 0, -size)), color, alpha);
    return this;
  }
  /** Draws a navigation path / movement trail. */
  path(points, color = '#66ffaa', alpha = 1) {
    for (let i = 0; i < points.length - 1; i++) this.line(points[i], points[i + 1], color, alpha);
    return this;
  }

  render(camera) {
    if (this.count === 0) return;
    this.lineGeometry.update(this.positions, this.colors, this.count * 2);
    this.shader.use().applyAll({
      uViewProjectionMatrix: camera.viewProjectionMatrix.elements,
      uTint: [this.tint.r, this.tint.g, this.tint.b, this.opacity],
    });
    this.lineGeometry.bind();
    this.device.setDepthTest(this.depthTest);
    this.device.setBlend('alpha');
    this.lineGeometry.draw(this.count * 2);
    this.device.setBlend('none');
  }
  destroy() {
    this.lineGeometry.destroy();
  }
}

// ---------------------------------------------------------------------------
// 3D text — name tags, damage numbers, floating score popups
// ---------------------------------------------------------------------------
export class TextSystem {
  /**
   * @param {import('./gl/GLDevice.js').GLDevice} device
   * @param {{texture: any, charMap: Map<string, any>, size: number}} fontAtlas from `makeFontAtlas`
   */
  constructor(device, fontAtlas, opts = {}) {
    this.device = device;
    this.atlas = fontAtlas;
    this.maxGlyphs = opts.maxGlyphs ?? 1024;
    this.labels = [];
    this.rng = new RNG(3131);
    this.quad = createBillboardQuad();
    this.shader = device.createShader({
      name: 'text3d',
      vertex: `${GLSL.constants}
        layout(location = 0) in vec3 position;
        layout(location = 2) in vec2 uv;
        layout(location = 8) in vec4 instanceMatrix0;  // worldPos.xyz + size
        layout(location = 9) in vec4 instanceMatrix1;  // glyphPos.xy + glyphSize.xy (screen-aligned offset)
        layout(location = 10) in vec4 instanceMatrix2; // color.rgb + alpha
        layout(location = 11) in vec4 instanceMatrix3; // uvRect.xy + uvRect.zw
        uniform mat4 uViewProjectionMatrix;
        uniform vec3 uCameraRight;
        uniform vec3 uCameraUp;
        out vec2 vUV;
        out vec4 vColor;
        void main() {
          vec3 center = instanceMatrix0.xyz;
          float size = instanceMatrix0.w;
          vec2 glyphOffset = instanceMatrix1.xy * size;
          vec2 glyphSize = instanceMatrix1.zw * size;
          vec3 worldPos = center + uCameraRight * (glyphOffset.x + position.x * glyphSize.x)
                                 + uCameraUp * (glyphOffset.y + position.y * glyphSize.y);
          vUV = instanceMatrix3.xy + uv * instanceMatrix3.zw;
          vColor = instanceMatrix2;
          gl_Position = uViewProjectionMatrix * vec4(worldPos, 1.0);
        }`,
      fragment: `${GLSL.srgb}
        in vec2 vUV;
        in vec4 vColor;
        uniform sampler2D uFontAtlas;
        uniform vec4 uOutlineColor;
        out vec4 fragColor;
        void main() {
          float a = texture(uFontAtlas, vUV).a;
          if (a < 0.02) discard;
          fragColor = vec4(vColor.rgb, a * vColor.a);
        }`,
    });
    this.batch = new InstancedBatch({
      mesh: this.quad, material: null, capacity: this.maxGlyphs,
      layer: RenderLayer.Overlay, castShadow: false, receiveShadow: false,
      frustumCulled: false, name: 'text3d',
    });
    this.charWidth = 1 / (fontAtlas.cols ?? 16);
  }
  static create(device, fontAtlas, opts) { return new TextSystem(device, fontAtlas, opts); }

  /**
   * Adds a floating label.
   * @param {string} text
   * @param {Vector3} position world position of the label centre
   * @param {object} [opts] { size, color, life, follow, offset, uppercase, billboardScale }
   */
  add(text, position, opts = {}) {
    const label = {
      text: String(text),
      position: position.clone(),
      size: opts.size ?? 0.14,
      color: opts.color ? (opts.color instanceof Color3 ? opts.color : Color3.fromCSS(opts.color)) : _white,
      alpha: opts.alpha ?? 1,
      life: 0,
      maxLife: opts.life ?? 2,
      follow: opts.follow ?? null,
      offset: (opts.offset ? new Vector3().copy(opts.offset) : new Vector3(0, 0, 0)),
      rise: opts.rise ?? 0,
      billboard: true,
      shadow: opts.shadow !== false,
    };
    this.labels.push(label);
    if (this.labels.length > 96) this.labels.shift();
    return label;
  }
  /** Damage numbers: colour-coded by hit type, drifting upward. */
  addDamageNumber(amount, position, opts = {}) {
    const color = opts.headshot ? '#ffd54a' : opts.armor ? '#8fd0ff' : '#fff4e0';
    return this.add(String(Math.round(amount)), position, {
      size: opts.size ?? 0.16, color, life: opts.life ?? 0.9, rise: 0.9, offset: new Vector3(0, 0.05, 0),
    });
  }
  addNameTag(name, position, opts = {}) {
    return this.add(name, position, { size: opts.size ?? 0.11, color: opts.color ?? '#ffffff', life: opts.life ?? 0.2, ...opts });
  }

  update(dt) {
    for (let i = this.labels.length - 1; i >= 0; i--) {
      const l = this.labels[i];
      l.life += dt;
      if (l.life >= l.maxLife) { this.labels.splice(i, 1); continue; }
      if (l.follow) l.position.copy(l.follow).add(l.offset);
      if (l.rise) l.position.y += l.rise * dt;
    }
    return this;
  }

  /** Builds glyph instances for every visible label. */
  buildBatch(camera, material) {
    const batch = this.batch;
    batch.count = 0;
    batch.material = material;
    const right = camera.right;
    const up = camera.upVector;
    for (const l of this.labels) {
      const fade = clamp01(1 - Math.pow(l.life / l.maxLife, 3));
      const chars = l.text.split('');
      const totalWidth = chars.length * 0.62 * l.size;
      let x = -totalWidth / 2;
      for (const ch of chars) {
        const glyph = this.atlas.charMap.get(ch);
        if (glyph) {
          // Screen-aligned: place glyph corners in camera space, then push to world.
          const worldPos = l.position.clone()
            .addScaled(right, x + 0.32 * l.size)
            .addScaled(up, 0);
          batch.addRaw(
            [worldPos.x, worldPos.y, worldPos.z, l.size],
            [0, 0, 1, 1],
            [l.color.r, l.color.g, l.color.b, l.alpha * fade],
            [glyph.u, glyph.v, glyph.w, glyph.h],
            [1, 1, 1, 1],
            [0, 0, 0, 0],
          );
        }
        x += 0.62 * l.size;
      }
    }
    return batch;
  }

  clear() { this.labels.length = 0; return this; }
}

const _v = new V3();
const _v2 = new V3();
const _v3 = new V3();
const _v4 = new V3();
const _zero = new V3();
const _white = new Color3(1, 1, 1);
const _tracerColor = new Color3(1, 0.86, 0.5);
void lerp;
void Quaternion;

export default SpriteSystem;
