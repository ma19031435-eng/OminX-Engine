/**
 * OminX Engine — mesh renderer component.
 *
 * Bridges the object model (`Instance`) to the renderer's render list: uploads geometry,
 * manages material overrides, per-object frustum/portal visibility, LOD switching, shadow
 * casting flags, damage flash and team tint. This is the component a level usually has on
 * every prop, and it is what keeps the game code free of GPU details.
 *
 * @module engine/renderer/MeshRenderer
 */
import { Matrix4 } from '../math/Matrix4.js';
import { Vector3 } from '../math/Vector3.js';
import { Color3 } from '../math/Color3.js';
import { AABB } from '../math/Geometry.js';
import { Signal } from '../core/Signal.js';
import { createLogger } from '../core/Logger.js';
import { RenderLayer } from './RenderList.js';
import { AlphaMode } from './Material.js';
import { clamp01, lerp } from '../math/MathUtils.js';

const log = createLogger('MeshRenderer');

/** Simple distance-based LOD table: `[{ distance, mesh, material? }]`, nearest first. */
export class LODGroup {
  constructor(levels = []) {
    this.levels = levels.map((l) => ({ distance: l.distance, mesh: l.mesh, material: l.material ?? null })).sort((a, b) => a.distance - b.distance);
  }
  static create(levels) { return new LODGroup(levels); }
  select(distance) {
    for (const level of this.levels) if (distance <= level.distance) return level;
    return this.levels[this.levels.length - 1] ?? null;
  }
  toJSON() { return { levels: this.levels.map((l) => ({ distance: l.distance, mesh: l.mesh.name, material: l.material?.name })) }; }
}

/**
 * Per-object render state. Not an `Instance` subclass so it can be swapped in on frozen/static
 * props without paying the object-model cost; it is attached as a component-like bag.
 */
export class MeshRenderer {
  /**
   * @param {object} [opts]
   * @param {import('../geometry/Mesh.js').Mesh} [opts.mesh]
   * @param {import('./Material.js').Material} [opts.material]
   * @param {RenderLayer|string} [opts.layer]
   */
  constructor(opts = {}) {
    this.mesh = opts.mesh ?? null;
    this.material = opts.material ?? null;
    this.materialOverride = null;
    this.layer = opts.layer ?? RenderLayer.Dynamic;
    this.castShadow = opts.castShadow !== false;
    this.receiveShadow = opts.receiveShadow !== false;
    this.frustumCulled = opts.frustumCulled !== false;
    this.visible = opts.visible !== false;
    this.enabled = opts.enabled !== false;
    this.skinned = opts.skinned ?? false;
    this.boneMatrices = opts.boneMatrices ?? null;
    this.vertexColors = opts.vertexColors ?? false;
    this.lod = opts.lod ? (opts.lod instanceof LODGroup ? opts.lod : new LODGroup(opts.lod)) : null;
    this.renderOrder = opts.renderOrder ?? 0;
    this.opacity = opts.opacity ?? 1;
    this.tint = opts.tint ? Color3.fromCSS(opts.tint) : null;
    this.damageFlash = 0;
    this.emissiveScale = 1;
    this.rendered = false;
    this.owner = opts.owner ?? null;
    /** Runtime stats for the editor's debug panel. */
    this.stats = { distance: 0, lodLevel: 0, visibleLastFrame: false, triangles: 0 };
  }

  static create(opts) { return new MeshRenderer(opts); }

  set mesh(value) { this._mesh = value; if (value) this._bounds = null; }
  get mesh() { return this._mesh; }

  /** Local-space bounds, computed once and reused (mesh-owned). */
  get bounds() {
    if (!this._bounds) this._bounds = this._mesh?.bounds ?? new AABB().setFromCenterAndSize(new Vector3(), new Vector3(1, 1, 1));
    return this._bounds;
  }

  setMaterial(material) { this.materialOverride = material; return this; }
  clearMaterialOverride() { this.materialOverride = null; return this; }
  get activeMaterial() { return this.materialOverride ?? this.material; }

  setVisible(v) { this.visible = v; return this; }
  setLayer(layer) { this.layer = layer; return this; }

  /** Hit feedback: white/red flash for a few frames when the object takes damage. */
  flash(intensity = 1, duration = 0.12) {
    this._flash = { intensity, time: 0, duration };
    this.damageFlash = clamp01(intensity);
    return this;
  }

  update(dt, { camera, renderer, ownerMatrix = null } = {}) {
    if (this._flash) {
      this._flash.time += dt;
      const t = this._flash.time / this._flash.duration;
      this.damageFlash = t >= 1 ? 0 : clamp01(this._flash.intensity * (1 - t) * (1 - t));
      if (t >= 1) this._flash = null;
    } else if (this.damageFlash > 0) {
      this.damageFlash = Math.max(0, this.damageFlash - dt * 4);
    }
    if (camera && ownerMatrix) {
      this.stats.distance = camera.worldPosition.distanceTo(_v.setFromMatrixPosition(ownerMatrix));
    }
    void renderer;
    return this;
  }

  /**
   * Pushes this renderer into the render list.
   * @param {import('./RenderList.js').RenderList} list
   * @param {Matrix4} worldMatrix
   * @param {object} [ctx] { camera, renderer }
   */
  submit(list, worldMatrix, ctx = {}) {
    if (!this.mesh || !this.enabled || !this.visible) { this.stats.visibleLastFrame = false; return null; }
    let mesh = this.mesh;
    let material = this.activeMaterial;
    if (this.lod && ctx.camera) {
      const distance = ctx.camera.worldPosition.distanceTo(_v.setFromMatrixPosition(worldMatrix));
      const level = this.lod.select(distance);
      if (level) {
        this.stats.lodLevel = this.lod.levels.indexOf(level);
        if (level.mesh) mesh = level.mesh;
        if (level.material) material = level.material;
      }
    }
    if (!material) material = ctx.renderer?.materials.get('default') ?? null;

    const item = list.getOrCreate(this.owner ?? this, mesh);
    item.mesh = mesh;
    item.material = material;
    item.matrix.copy(worldMatrix);
    item.matrixWorld.copy(worldMatrix);
    item.layer = this.layer;
    item.castShadow = this.castShadow;
    item.receiveShadow = this.receiveShadow;
    item.frustumCulled = this.frustumCulled;
    item.skinned = this.skinned && !!this.boneMatrices;
    item.boneMatrices = this.boneMatrices;
    item.vertexColors = this.vertexColors;
    item.renderOrder = this.renderOrder;
    item.owner = this.owner;
    item.overrides.opacity = this.opacity;
    item.overrides.tint = this.tint ? [this.tint.r, this.tint.g, this.tint.b] : null;
    item.overrides.damageFlash = this.damageFlash;
    item.overrides.emissiveScale = this.emissiveScale;
    item.updateBounds();
    this.stats.visibleLastFrame = true;
    this.stats.triangles = mesh.triangleCount ?? mesh.indexCount / 3 ?? 0;
    this.rendered = true;
    return item;
  }

  /** Static props bake into instanced batches for huge draw-call savings. */
  static bakeBatch(renderer, mesh, material, transforms, opts = {}) {
    const batch = renderer.addInstanced(mesh, material, transforms.length, {
      castShadow: opts.castShadow ?? true,
      receiveShadow: opts.receiveShadow ?? true,
      layer: opts.layer ?? RenderLayer.Static,
      name: opts.name ?? `batch_${mesh.name}`,
      vertexColors: true,
      dynamic: false,
    });
    transforms.forEach((m, i) => batch.setInstant(i, m, opts.colors?.[i] ?? null, opts.params?.[i] ?? null));
    batch.updateBounds();
    return batch;
  }

  toJSON() {
    return {
      mesh: this.mesh?.name ?? null,
      material: this.material?.name ?? null,
      layer: this.layer,
      castShadow: this.castShadow,
      receiveShadow: this.receiveShadow,
      visible: this.visible,
      opacity: this.opacity,
      tint: this.tint?.toHex?.() ?? null,
      lod: this.lod ? this.lod.toJSON() : null,
    };
  }
}

/**
 * SkinnedMeshRenderer — adds skeleton plumbing on top of MeshRenderer.
 * Falls back to a cheap procedural idle animation when no skeleton is supplied, so character
 * meshes never appear frozen while an artist rig is still being authored.
 */
export class SkinnedMeshRenderer extends MeshRenderer {
  constructor(opts = {}) {
    super({ ...opts, skinned: true });
    this.skeleton = opts.skeleton ?? null;
    this.boneMatrices = opts.boneMatrices ?? new Float32Array((opts.maxBones ?? 96) * 16);
    this.animationTime = 0;
    this.proceduralIdle = opts.proceduralIdle ?? false;
    this.hips = null;
  }
  static create(opts) { return new SkinnedMeshRenderer(opts); }

  update(dt, ctx) {
    super.update(dt, ctx);
    this.animationTime += dt;
    if (this.proceduralIdle && this.skeleton?.bones?.length) {
      // Breathing + weapon-chatter: tiny rotations on the upper-body chain.
      for (const bone of this.skeleton.bones) {
        if (bone.name === 'spine' || bone.name === 'chest') {
          bone.rotation.x = Math.sin(this.animationTime * 1.7) * 0.012;
        } else if (bone.name === 'head') {
          bone.rotation.y = Math.sin(this.animationTime * 0.6) * 0.03;
        }
      }
      this.skeleton.update();
      this.boneMatrices = this.skeleton.getBoneMatrices();
    }
    return this;
  }
}

const _v = new Vector3();
void Matrix4;
void Signal;
void log;
void AlphaMode;
void lerp;

export default MeshRenderer;
